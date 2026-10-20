// Vehicle audio for an electric delivery van.
//
// Everything continuous is generative and driven by the simulation: permanent
// magnet motor and reduction-gear whine (orders tied to real motor speed),
// inverter carrier whistle under load, regenerative braking, the low-speed
// pedestrian warning sound, tyre roar, wind, skids, suspension, and live metal
// groans and crunches while the soft-body structure is yielding.
//
// Recorded material (horn, power window, crash layers, cabin road bed) is never
// just played back: each one is looped or layered by intensity, pitch- and
// timing-varied per hit, saturated, filtered, positioned in 3D around the
// listener, sent to a generated reverb, and muffled through the cab when the
// camera is in the driver's seat.

const ASSETS = {
  hornAttack: "horn-attack.mp3",
  hornLoop: "horn-loop.mp3",
  hornRelease: "horn-release.mp3",
  windowStart: "window-start.mp3",
  windowLoop: "window-loop.mp3",
  windowStop: "window-stop.mp3",
  crashLight: "crash-light.mp3",
  crashMedium: "crash-medium.mp3",
  crashHeavy: "crash-heavy.mp3",
  cabin: "cabin-road.mp3",
  // Ryder's Oshkosh ODC sound study chimes.
  chWelcome: "../chimes/welcome.mp3",
  chDoor: "../chimes/door.mp3",
  chBlinker: "../chimes/blinker.mp3",
  chBelt: "../chimes/belt.mp3",
  chFcw: "../chimes/fcw.mp3",
  chCross: "../chimes/cross.mp3",
};
const WHEEL_RADIUS = 0.517,
  REDUCTION = 9.7;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (x) => {
  x = clamp(x, 0, 1);
  return x * x * (3 - 2 * x);
};

export class VehicleAudio {
  constructor() {
    this.enabled = false;
    this.ctx = null;
    this.buffers = {};
    this.lastTick = -1;
    this.lastReverse = -1;
    this.cab = false;
    this.lastCrash = -10;
    this.lastTinkle = 0;
    this.windows = {};
    this.listenerPos = { x: 0, y: 0, z: 0 };
    let v = 0.6;
    try {
      const saved = parseFloat(localStorage.getItem("van-volume"));
      if (saved >= 0 && saved <= 1) v = saved;
    } catch {}
    this.volume = v;
  }
  // User volume (0..1), applied after the mix so it scales everything, film included.
  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    try {
      localStorage.setItem("van-volume", String(this.volume));
    } catch {}
    if (this.volNode) this.volNode.gain.setTargetAtTime(this.volumeGain(), this.ctx.currentTime, 0.05);
  }
  volumeGain() {
    // Perceptual curve; full slider is still well under the old level.
    return 0.75 * this.volume * this.volume;
  }
  async unlock() {
    if (!this.ctx) this.build();
    await this.ctx.resume();
  }
  async toggle() {
    await this.unlock();
    this.enabled = !this.enabled;
    this.master.gain.setTargetAtTime(this.enabled ? 0.9 : 0, this.ctx.currentTime, 0.08);
    return this.enabled;
  }
  get now() {
    return this.ctx.currentTime;
  }

  // ---------------------------------------------------------------- graph
  build() {
    const c = (this.ctx = new AudioContext({ latencyHint: "interactive" }));
    this.master = c.createGain();
    this.master.gain.value = 0;
    // Glue compression then a fast limiter so big crashes never clip.
    const glue = new DynamicsCompressorNode(c, { threshold: -18, knee: 10, ratio: 3, attack: 0.012, release: 0.2 });
    const limit = new DynamicsCompressorNode(c, { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.08 });
    this.volNode = new GainNode(c, { gain: this.volumeGain() });
    this.master.connect(this.volNode).connect(glue).connect(limit).connect(c.destination);
    this.reverb = c.createConvolver();
    this.reverb.buffer = this.impulse(1.6, 2.8);
    this.reverbReturn = new GainNode(c, { gain: 0.32 });
    this.reverb.connect(this.reverbReturn).connect(this.master);
    // Exterior world: everything outside the cab passes the occlusion filter.
    this.occlusion = new BiquadFilterNode(c, { type: "lowpass", frequency: 20000, Q: 0.5 });
    this.exterior = new GainNode(c, { gain: 1 });
    this.occlusion.connect(this.exterior).connect(this.master);
    this.exterior.connect(this.reverb);
    // Interior: heard only from the driver's seat, not positional.
    this.interior = new GainNode(c, { gain: 0 });
    this.interior.connect(this.master);
    // The van as a sound source, positioned at the vehicle.
    this.vanPanner = this.panner();
    this.vanBus = new GainNode(c, { gain: 1 });
    this.vanBus.connect(this.vanPanner).connect(this.occlusion);
    this.noise = this.noiseBuffer();
    this.buildDrivetrain();
    this.buildRoad();
    this.buildStructure();
    this.buildCabin();
    this.load();
  }
  panner() {
    return new PannerNode(this.ctx, {
      panningModel: "HRTF",
      distanceModel: "inverse",
      refDistance: 4,
      maxDistance: 400,
      rolloffFactor: 1.1,
    });
  }
  place(panner, p) {
    const t = this.now;
    if (panner.positionX) {
      panner.positionX.setTargetAtTime(p.x, t, 0.02);
      panner.positionY.setTargetAtTime(p.y, t, 0.02);
      panner.positionZ.setTargetAtTime(p.z, t, 0.02);
    } else panner.setPosition(p.x, p.y, p.z);
  }
  // A short, dark, diffuse impulse: open yard with some building slap.
  impulse(seconds, decay) {
    const c = this.ctx,
      n = Math.floor(c.sampleRate * seconds),
      b = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n,
          early = i < c.sampleRate * 0.09 && Math.random() < 0.002 ? rand(-1, 1) * 2 : 0;
        lp += (rand(-1, 1) - lp) * (0.5 - 0.42 * t);
        d[i] = (lp + early) * Math.pow(1 - t, decay);
      }
    }
    return b;
  }
  noiseBuffer() {
    const c = this.ctx,
      b = c.createBuffer(1, c.sampleRate * 3, c.sampleRate),
      d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  noiseSource(rate = 1) {
    const s = new AudioBufferSourceNode(this.ctx, { buffer: this.noise, loop: true, playbackRate: rate });
    s.start(0, Math.random() * 2.5);
    return s;
  }
  // Brown-ish noise from white through a gentle lowpass cascade.
  rumbleSource() {
    const s = this.noiseSource(0.5),
      a = new BiquadFilterNode(this.ctx, { type: "lowpass", frequency: 420, Q: 0.3 }),
      b = new BiquadFilterNode(this.ctx, { type: "lowpass", frequency: 900, Q: 0.3 });
    s.connect(a).connect(b);
    return b;
  }

  buildDrivetrain() {
    const c = this.ctx;
    this.drive = new GainNode(c, { gain: 0 });
    const tone = new BiquadFilterNode(c, { type: "lowpass", frequency: 2800, Q: 0.4 });
    const body = new BiquadFilterNode(c, { type: "peaking", frequency: 900, Q: 0.9, gain: 2 });
    this.drive.connect(body).connect(tone).connect(this.vanBus);
    // Through the firewall the drivetrain is darker and closer.
    this.driveCab = new GainNode(c, { gain: 0 });
    this.drive.connect(new BiquadFilterNode(c, { type: "lowpass", frequency: 2600, Q: 0.6 })).connect(this.driveCab);
    this.driveCab.connect(this.interior);
    // Motor and gear orders (multiples of motor shaft speed).
    const orders = [
      { order: 8, type: "sine", gain: 0.22 }, // pole-pass
      { order: 16, type: "sine", gain: 0.12 },
      { order: 24, type: "sine", gain: 0.22 }, // stator slot harmonic: the classic EV whine
      { order: 48, type: "sine", gain: 0.04 },
      { order: 19, type: "sine", gain: 0.1 }, // reduction gear mesh
      { order: 38, type: "sine", gain: 0.06 },
    ];
    this.orders = orders.map((o) => {
      const osc = new OscillatorNode(c, { type: o.type, frequency: 40 }),
        g = new GainNode(c, { gain: 0 });
      osc.connect(g).connect(this.drive);
      osc.start();
      return { ...o, osc, g };
    });
    // Slow wander so the whine is alive rather than a test tone.
    const lfo = new OscillatorNode(c, { frequency: 4.7 }),
      depth = new GainNode(c, { gain: 6 });
    lfo.connect(depth);
    lfo.start();
    for (const o of this.orders) depth.connect(o.osc.detune);
    // Inverter carrier whistle under load at low speed, with motor-order sidebands.
    this.carrier = new OscillatorNode(c, { frequency: 7800 });
    this.carrierAm = new GainNode(c, { gain: 0 });
    this.carrierGain = new GainNode(c, { gain: 0 });
    this.carrierMod = new OscillatorNode(c, { frequency: 60 });
    const amDepth = new GainNode(c, { gain: 0.5 });
    this.carrierMod.connect(amDepth).connect(this.carrierAm.gain);
    this.carrier.connect(this.carrierAm).connect(this.carrierGain).connect(this.drive);
    this.carrier.start();
    this.carrierMod.start();
    // Pedestrian warning sound (exterior speaker), below 30 km/h.
    this.avas = new GainNode(c, { gain: 0 });
    const avasFilter = new BiquadFilterNode(c, { type: "bandpass", frequency: 700, Q: 0.7 });
    this.avasOsc = [0, 702, 1200].map((cents, i) => {
      const o = new OscillatorNode(c, { type: i === 2 ? "sine" : "triangle", frequency: 260, detune: cents + rand(-4, 4) });
      const g = new GainNode(c, { gain: [0.5, 0.35, 0.18][i] });
      o.connect(g).connect(avasFilter);
      o.start();
      return o;
    });
    const swell = new OscillatorNode(c, { frequency: 1.6 }),
      swellDepth = new GainNode(c, { gain: 0.25 }),
      avasAm = new GainNode(c, { gain: 0.75 });
    swell.connect(swellDepth).connect(avasAm.gain);
    swell.start();
    avasFilter.connect(avasAm).connect(this.avas).connect(this.vanBus);
  }

  buildRoad() {
    const c = this.ctx;
    // Tyre roar: rumble with a speed-tracking band for tread pattern.
    this.tyre = new GainNode(c, { gain: 0 });
    this.tyreBand = new BiquadFilterNode(c, { type: "bandpass", frequency: 500, Q: 0.8 });
    const roar = this.rumbleSource();
    roar.connect(this.tyreBand).connect(this.tyre).connect(this.vanBus);
    // Wind: broadband, rising faster than speed.
    this.wind = new GainNode(c, { gain: 0 });
    this.windBand = new BiquadFilterNode(c, { type: "bandpass", frequency: 400, Q: 0.5 });
    this.noiseSource(0.8).connect(this.windBand).connect(this.wind).connect(this.vanBus);
    this.windCab = new GainNode(c, { gain: 0 });
    this.windBand.connect(new BiquadFilterNode(c, { type: "lowpass", frequency: 1400 })).connect(this.windCab);
    this.windCab.connect(this.interior);
    // Skid: two resonant bands with a jittering pitch.
    this.skid = new GainNode(c, { gain: 0 });
    this.skidA = new BiquadFilterNode(c, { type: "bandpass", frequency: 1250, Q: 7 });
    this.skidB = new BiquadFilterNode(c, { type: "bandpass", frequency: 2450, Q: 9 });
    const sk = this.noiseSource(1);
    sk.connect(this.skidA).connect(this.skid);
    sk.connect(this.skidB).connect(this.skid);
    const squeal = new OscillatorNode(c, { type: "sawtooth", frequency: 870 }),
      squealGain = new GainNode(c, { gain: 0.06 }),
      squealFilter = new BiquadFilterNode(c, { type: "bandpass", frequency: 900, Q: 12 });
    squeal.connect(squealFilter).connect(squealGain).connect(this.skid);
    squeal.start();
    this.squeal = squeal;
    this.skid.connect(this.vanBus);
  }

  buildStructure() {
    const c = this.ctx;
    // Groaning sheet metal while the lattice is still yielding.
    this.groan = new GainNode(c, { gain: 0 });
    this.groanOsc = new OscillatorNode(c, { type: "sawtooth", frequency: 70 });
    this.groanFilter = new BiquadFilterNode(c, { type: "bandpass", frequency: 320, Q: 14 });
    const g2 = new BiquadFilterNode(c, { type: "bandpass", frequency: 910, Q: 18 });
    this.groanOsc.connect(this.groanFilter).connect(this.groan);
    this.groanOsc.connect(g2).connect(this.groan);
    this.groanOsc.start();
    this.groan.connect(this.vanBus);
    this.groanFilter2 = g2;
  }

  buildCabin() {
    const c = this.ctx;
    // HVAC fan and electronics hum while the van is powered.
    this.hvac = new GainNode(c, { gain: 0 });
    this.noiseSource(0.6)
      .connect(new BiquadFilterNode(c, { type: "lowpass", frequency: 520, Q: 0.4 }))
      .connect(new BiquadFilterNode(c, { type: "highpass", frequency: 90 }))
      .connect(this.hvac)
      .connect(this.interior);
    // Recorded cabin road bed is attached once it decodes.
    this.cabinBed = new GainNode(c, { gain: 0 });
    this.cabinShelf = new BiquadFilterNode(c, { type: "lowshelf", frequency: 160, gain: 0 });
    this.cabinBed.connect(this.cabinShelf).connect(this.interior);
  }

  // ---------------------------------------------------------------- assets
  async load() {
    await Promise.all(
      Object.entries(ASSETS).map(async ([key, file]) => {
        try {
          const r = await fetch("./assets/audio/" + file);
          this.buffers[key] = this.trim(await this.ctx.decodeAudioData(await r.arrayBuffer()));
        } catch (e) {
          console.warn("Audio asset unavailable", file, e);
        }
      }),
    );
    for (const k of ["hornLoop", "windowLoop", "cabin"]) if (this.buffers[k]) this.buffers[k] = this.loopable(this.buffers[k]);
    if (this.buffers.cabin) {
      this.cabinSrc = new AudioBufferSourceNode(this.ctx, { buffer: this.buffers.cabin, loop: true });
      this.cabinSrc.connect(this.cabinBed);
      this.cabinSrc.start(0, rand(0, 20));
    }
  }
  // Remove decoder padding (digital silence) from both ends.
  trim(b) {
    const d = b.getChannelData(0);
    let s = 0,
      e = d.length - 1;
    while (s < e && Math.abs(d[s]) < 1e-5) s++;
    while (e > s && Math.abs(d[e]) < 1e-5) e--;
    if (s === 0 && e === d.length - 1) return b;
    const out = this.ctx.createBuffer(b.numberOfChannels, e - s + 1, b.sampleRate);
    for (let ch = 0; ch < b.numberOfChannels; ch++) out.copyToChannel(b.getChannelData(ch).subarray(s, e + 1), ch);
    return out;
  }
  // Short equal-power crossfade across the loop point as insurance against seams.
  loopable(b, seconds = 0.025) {
    const n = Math.min(Math.floor(b.sampleRate * seconds), b.length >> 2),
      out = this.ctx.createBuffer(b.numberOfChannels, b.length - n, b.sampleRate);
    for (let ch = 0; ch < b.numberOfChannels; ch++) {
      const src = b.getChannelData(ch),
        dst = out.getChannelData(ch);
      dst.set(src.subarray(0, b.length - n));
      for (let i = 0; i < n; i++) {
        const t = i / n;
        dst[i] = src[i] * Math.sqrt(t) + src[b.length - n + i] * Math.sqrt(1 - t);
      }
    }
    return out;
  }
  play(key, { at = null, gain = 1, rate = 1, filter = 20000, drive = 0, reverb = 0.3, offset = 0, dest = null } = {}) {
    const b = this.buffers[key];
    if (!b || !this.ctx) return null;
    const c = this.ctx,
      src = new AudioBufferSourceNode(c, { buffer: b, playbackRate: rate }),
      f = new BiquadFilterNode(c, { type: "lowpass", frequency: filter, Q: 0.5 }),
      g = new GainNode(c, { gain });
    let node = src.connect(f);
    if (drive > 0) node = node.connect(new WaveShaperNode(c, { curve: this.curve(drive), oversample: "2x" }));
    node.connect(g);
    this.route(g, at, reverb, dest);
    src.start(this.now, offset);
    return { src, gain: g };
  }
  route(node, at, reverb = 0.25, dest = null) {
    if (dest) return node.connect(dest);
    if (at) {
      const p = this.panner();
      this.place(p, at);
      node.connect(p).connect(this.occlusion);
    } else node.connect(this.vanBus);
    if (reverb > 0) node.connect(new GainNode(this.ctx, { gain: reverb })).connect(this.reverb);
  }
  curve(amount) {
    const n = 1024,
      k = amount * 60,
      curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / n) * 2 - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  // ---------------------------------------------------------------- synthesis helpers
  burst({ at, freq = 1200, q = 1, dur = 0.08, gain = 0.3, type = "bandpass", delay = 0, reverb = 0.2, dest = null }) {
    const c = this.ctx,
      t = this.now + delay,
      s = new AudioBufferSourceNode(c, { buffer: this.noise, playbackRate: rand(0.8, 1.2) }),
      f = new BiquadFilterNode(c, { type, frequency: freq, Q: q }),
      g = new GainNode(c, { gain: 0 });
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g);
    this.route(g, at, reverb, dest);
    s.start(t, rand(0, 2.5));
    s.stop(t + dur + 0.05);
  }
  ping({ at, freq, dur = 0.3, gain = 0.1, type = "sine", delay = 0, bend = 1, reverb = 0.25, dest = null }) {
    const c = this.ctx,
      t = this.now + delay,
      o = new OscillatorNode(c, { type, frequency: freq }),
      g = new GainNode(c, { gain: 0 });
    o.frequency.setValueAtTime(freq, t);
    if (bend !== 1) o.frequency.exponentialRampToValueAtTime(freq * bend, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.0015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    this.route(g, at, reverb, dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  // Struck metal: inharmonic modal partials scaled by size.
  clank(at, energy = 1, size = 1, dest = null) {
    const base = rand(140, 220) / Math.sqrt(size);
    for (const [ratio, amp, decay] of [
      [1, 0.5, 0.5],
      [2.76, 0.32, 0.32],
      [5.4, 0.2, 0.18],
      [8.93, 0.12, 0.1],
    ])
      this.ping({ at, freq: base * ratio * rand(0.97, 1.03), dur: decay * rand(0.8, 1.2), gain: 0.18 * amp * energy, reverb: 0.35, dest });
    this.burst({ at, freq: 2600, q: 0.7, dur: 0.05, gain: 0.25 * energy, dest });
  }
  thud(at, energy = 1, dest = null) {
    this.ping({ at, freq: rand(58, 72), bend: 0.5, dur: 0.32, gain: 0.55 * energy, reverb: 0.15, dest });
    this.burst({ at, freq: 180, q: 0.8, dur: 0.12, gain: 0.35 * energy, type: "lowpass", dest });
  }

  // ---------------------------------------------------------------- events
  crash(severity, at) {
    if (!this.ctx || !this.enabled) return;
    const t = this.now;
    if (t - this.lastCrash < 0.12) {
      this.crunch(at, severity * 0.4);
      return;
    }
    this.lastCrash = t;
    const s = clamp(severity / 16, 0, 1.4),
      inCab = this.cab,
      dest = inCab ? this.interior : null;
    // Layer recorded impacts by intensity, each varied so no two hits match.
    // K keeps crashes punchy but well below ear-splitting.
    const K = 0.42;
    this.play("crashLight", {
      at,
      gain: K * (0.12 + 0.2 * Math.min(1, s * 2)),
      rate: rand(0.94, 1.12) * (1.1 - s * 0.15),
      filter: 2500 + s * 14000,
      reverb: 0.25,
      offset: rand(0, 0.02),
      dest,
    });
    if (s > 0.28)
      this.play("crashMedium", { at, gain: K * (0.16 + 0.24 * s), rate: rand(0.9, 1.06), filter: 4000 + s * 12000, drive: s * 0.25, reverb: 0.35, dest });
    if (s > 0.62)
      this.play("crashHeavy", { at, gain: K * (0.2 + 0.2 * s), rate: rand(0.88, 1.02), filter: 6000 + s * 10000, drive: s * 0.35, reverb: 0.45, dest });
    // Weight you feel, and the structure ringing out.
    this.thud(at, K * (0.35 + 0.5 * s), inCab ? this.interior : null);
    this.clank(at, K * (0.3 + s * 0.4), 1 + s, dest);
    this.crunch(at, severity * 0.5);
  }
  // Sheet metal folding: a spray of short resonant noise grains.
  crunch(at, severity) {
    if (!this.ctx || !this.enabled) return;
    const grains = Math.round(clamp(severity * 1.4, 3, 26));
    for (let i = 0; i < grains; i++)
      this.burst({
        at,
        freq: rand(500, 4200),
        q: rand(2, 9),
        dur: rand(0.03, 0.12),
        gain: rand(0.05, 0.16) * clamp(severity / 10, 0.4, 1.2) * 0.45,
        delay: Math.pow(Math.random(), 1.8) * (0.15 + severity * 0.02),
        dest: this.cab ? this.interior : null,
      });
  }
  glass(at, size = 1) {
    if (!this.ctx || !this.enabled) return;
    const dest = this.cab ? this.interior : null;
    this.burst({ at, freq: 4200, q: 0.5, dur: 0.22, gain: 0.14 * size, type: "highpass", reverb: 0.4, dest });
    this.burst({ at, freq: 1900, q: 1.2, dur: 0.09, gain: 0.11 * size, dest });
    const n = Math.round(30 + 40 * size);
    for (let i = 0; i < n; i++) {
      const f = rand(2600, 9500);
      this.ping({ at, freq: f, dur: rand(0.025, 0.14), gain: rand(0.012, 0.05) * size, delay: Math.pow(Math.random(), 2.2) * 0.85, reverb: 0.35, dest });
    }
  }
  tinkle(at) {
    if (!this.ctx || !this.enabled) return;
    const t = this.now;
    if (t - this.lastTinkle < 0.025) return;
    this.lastTinkle = t;
    this.ping({ at, freq: rand(3200, 8800), dur: rand(0.02, 0.08), gain: rand(0.008, 0.025), reverb: 0.2 });
  }
  // A panel or lamp tearing free: rip, then a clank.
  tear(at, mass = 10) {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx,
      t = this.now,
      s = new AudioBufferSourceNode(c, { buffer: this.noise }),
      f = new BiquadFilterNode(c, { type: "bandpass", frequency: 3200, Q: 4 }),
      g = new GainNode(c, { gain: 0 });
    f.frequency.setValueAtTime(3400, t);
    f.frequency.exponentialRampToValueAtTime(700, t + 0.18);
    g.gain.linearRampToValueAtTime(0.14, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    s.connect(f).connect(g);
    this.route(g, at, 0.3);
    s.start(t, rand(0, 2));
    s.stop(t + 0.25);
    this.clank(at, 0.6, Math.cbrt(mass / 8));
  }
  debrisHit(at, energy, mass) {
    if (!this.ctx || !this.enabled) return;
    const e = clamp(energy, 0.05, 1.2);
    this.clank(at, e, Math.cbrt(mass / 8));
    if (mass > 20) this.thud(at, e * 0.6);
  }
  horn(on, at) {
    if (!this.ctx) return;
    const t = this.now;
    if (on) {
      if (this.hornNode) return;
      // A real horn: attack sample, then a seamless sustain loop for as long as it's held.
      const out = new GainNode(this.ctx, { gain: 0.9 }),
        tone = new BiquadFilterNode(this.ctx, { type: "lowpass", frequency: 9000 });
      out.connect(tone);
      this.route(tone, null, 0.35);
      this.hornCab = tone.connect(new GainNode(this.ctx, { gain: 0 }));
      this.hornCab.connect(this.interior);
      const atk = this.buffers.hornAttack && new AudioBufferSourceNode(this.ctx, { buffer: this.buffers.hornAttack });
      const loop = this.buffers.hornLoop && new AudioBufferSourceNode(this.ctx, { buffer: this.buffers.hornLoop, loop: true });
      if (atk) {
        atk.connect(out);
        atk.start(t);
      }
      if (loop) {
        loop.connect(out);
        loop.start(t + (atk ? atk.buffer.duration - 0.03 : 0));
      }
      this.hornNode = { out, atk, loop, tone };
      if (!atk && !loop) this.ping({ freq: 420, dur: 0.4, gain: 0.2, type: "square" });
    } else if (this.hornNode) {
      const h = this.hornNode;
      this.hornNode = null;
      h.out.gain.setTargetAtTime(0, t, 0.035);
      if (this.buffers.hornRelease) {
        const rel = new AudioBufferSourceNode(this.ctx, { buffer: this.buffers.hornRelease }),
          g = new GainNode(this.ctx, { gain: 0.55 });
        g.gain.setTargetAtTime(0, t + 0.04, 0.05);
        rel.connect(g).connect(h.tone);
        rel.start(t);
        rel.stop(t + 0.4);
      }
      h.atk?.stop(t + 0.2);
      h.loop?.stop(t + 0.3);
    }
  }
  // Power window motor: start clunk, motor loop while moving, stop thump.
  windowMotor(id, moving, at) {
    if (!this.ctx || !this.enabled) return;
    const w = this.windows[id];
    if (moving && !w) {
      const start = this.play("windowStart", { at, gain: 0.5, rate: rand(0.97, 1.03), reverb: 0.05 });
      const loop = this.buffers.windowLoop && new AudioBufferSourceNode(this.ctx, { buffer: this.buffers.windowLoop, loop: true, playbackRate: rand(0.97, 1.04) });
      const g = new GainNode(this.ctx, { gain: 0 });
      if (loop) {
        loop.connect(g);
        this.route(g, at, 0.05);
        g.gain.setTargetAtTime(0.45, this.now + 0.12, 0.05);
        loop.start(this.now + 0.1, rand(0, 1));
      }
      this.windows[id] = { loop, g, start };
    } else if (!moving && w) {
      delete this.windows[id];
      w.g.gain.setTargetAtTime(0, this.now, 0.03);
      w.loop?.stop(this.now + 0.2);
      this.play("windowStop", { at, gain: 0.5, rate: rand(0.97, 1.03), reverb: 0.05 });
    }
  }
  // Cabin chimes for the driver display states (door, belt, parking, collision).
  chime(kind) {
    if (!this.ctx || !this.enabled) return;
    const dest = this.cab ? this.interior : null,
      g = this.cab ? 1 : 0.6;
    const S = { welcome: "chWelcome", start: "chWelcome", door: "chDoor", blinker: "chBlinker", belt: "chBelt", cross: "chCross" }[kind];
    if (S && this.buffers[S]) {
      this.play(S, { gain: (kind === "fcw" || kind === "cross" ? 0.55 : 0.75) * g, reverb: 0.04, dest });
      return;
    }
    if (kind === "door") {
      this.ping({ freq: 880, dur: 0.24, gain: 0.07 * g, dest });
      this.ping({ freq: 660, dur: 0.32, gain: 0.07 * g, delay: 0.17, dest });
    } else if (kind === "belt") {
      for (const [r, a, d] of [[1, 0.07, 0.7], [2.01, 0.025, 0.4], [3.03, 0.012, 0.25]]) this.ping({ freq: 1175 * r, dur: d, gain: a * g, dest });
    } else if (kind === "park" || kind === "park-near" || kind === "park-solid") {
      const f = kind === "park" ? 1240 : 1480;
      this.ping({ freq: f, dur: kind === "park-solid" ? 1.4 : 0.075, gain: 0.06 * g, type: "triangle", dest });
    } else if (kind === "fcw") {
      // Urgent but pleasant: a soft descending two-note bell (sine, no square
      // edges), with a quiet octave shimmer.
      for (const [f, d] of [[1046.5, 0], [830.6, 0.13]]) {
        this.ping({ freq: f, dur: 0.42, gain: 0.05 * g, type: "sine", delay: d, reverb: 0.12, dest });
        this.ping({ freq: f * 2, dur: 0.18, gain: 0.008 * g, type: "sine", delay: d, reverb: 0.12, dest });
      }
    } else if (kind === "thermal") {
      // Critical: a falling two-tone that sits apart from the collision beeps.
      this.ping({ freq: 1568, dur: 0.16, gain: 0.07 * g, type: "triangle", dest });
      this.ping({ freq: 1047, dur: 0.28, gain: 0.07 * g, type: "triangle", delay: 0.15, dest });
    } else if (kind === "lane") {
      // Caution: a paired soft pulse, like a rumble strip in sound.
      for (let i = 0; i < 2; i++) this.ping({ freq: 740, dur: 0.11, gain: 0.07 * g, type: "sine", delay: i * 0.14, dest }), this.ping({ freq: 1480, dur: 0.06, gain: 0.015 * g, delay: i * 0.14, dest });
    } else if (kind === "blinker") this.burst({ freq: 3000, q: 4, dur: 0.02, gain: 0.08, dest });
  }
  event(name, opts = {}) {
    if (!this.ctx || !this.enabled) return;
    const at = opts.at || null,
      cab = this.cab ? this.interior : null;
    if (name === "crash") this.crash(opts.severity ?? 8, at);
    else if (name === "horn") this.horn(true, at);
    else if (name === "start") {
      // Main contactor clunk, a rising inverter pre-charge tone, then the ready chime.
      this.thud(null, 0.35, cab);
      this.burst({ freq: 2400, q: 3, dur: 0.03, gain: 0.12, dest: cab });
      this.ping({ freq: 90, bend: 2.2, dur: 0.5, gain: 0.06, type: "sawtooth", delay: 0.05, dest: cab });
      if (!this.buffers.chWelcome) this.ping({ freq: 1318, dur: 0.5, gain: 0.07, delay: 0.42, dest: cab }), this.ping({ freq: 1760, dur: 0.7, gain: 0.06, delay: 0.56, dest: cab });
    } else if (name === "latch") {
      // Door or hood: latch click, body thump, panel ring.
      this.burst({ at, freq: 3200, q: 2, dur: 0.025, gain: 0.2 });
      this.thud(at, 0.35);
      this.ping({ at, freq: rand(380, 460), dur: 0.12, gain: 0.05, delay: 0.01 });
      this.ping({ at, freq: rand(1050, 1200), dur: 0.08, gain: 0.03, delay: 0.01 });
    } else if (name === "success") {
      this.ping({ freq: 784, dur: 0.22, gain: 0.08 });
      this.ping({ freq: 1047, dur: 0.24, gain: 0.08, delay: 0.11 });
      this.ping({ freq: 1568, dur: 0.4, gain: 0.07, delay: 0.22 });
    } else if (name === "gear") {
      // Rotary shifter detent and a soft confirmation tone.
      this.burst({ freq: 2900, q: 4, dur: 0.018, gain: 0.12, dest: cab });
      this.ping({ freq: 880, dur: 0.09, gain: 0.03, delay: 0.03, dest: cab });
    } else if (name === "bump") this.thud(at, clamp(opts.energy ?? 0.4, 0.1, 1), cab);
    else this.burst({ freq: 3600, q: 3, dur: 0.02, gain: 0.07, dest: cab });
  }

  // ---------------------------------------------------------------- per frame
  // s: { dt, time, speed, throttle, brake, ignition, gear, boost, power, signal,
  //      reverse, cab, listener{position,quaternion}, vehicle{position,quaternion},
  //      skid, suspension[], plastic, grounded }
  update(s) {
    if (!this.ctx) return;
    const c = this.ctx,
      t = c.currentTime,
      v = Math.abs(s.speed),
      kmh = v * 3.6;
    // Listener follows the camera.
    const L = c.listener,
      lp = s.listener.position,
      f = this.fwd || (this.fwd = { x: 0, y: 0, z: -1 }),
      q = s.listener.quaternion;
    const fx = -(2 * (q.x * q.z + q.w * q.y)),
      fy = -(2 * (q.y * q.z - q.w * q.x)),
      fz = -(1 - 2 * (q.x * q.x + q.y * q.y)),
      ux = 2 * (q.x * q.y - q.w * q.z),
      uy = 1 - 2 * (q.x * q.x + q.z * q.z),
      uz = 2 * (q.y * q.z + q.w * q.x);
    if (L.positionX) {
      L.positionX.setTargetAtTime(lp.x, t, 0.015);
      L.positionY.setTargetAtTime(lp.y, t, 0.015);
      L.positionZ.setTargetAtTime(lp.z, t, 0.015);
      L.forwardX.setTargetAtTime(fx, t, 0.015);
      L.forwardY.setTargetAtTime(fy, t, 0.015);
      L.forwardZ.setTargetAtTime(fz, t, 0.015);
      L.upX.setTargetAtTime(ux, t, 0.015);
      L.upY.setTargetAtTime(uy, t, 0.015);
      L.upZ.setTargetAtTime(uz, t, 0.015);
    } else {
      L.setPosition(lp.x, lp.y, lp.z);
      L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
    this.listenerPos = lp;
    // The van as a source; from the seat it sits right on the listener.
    this.place(this.vanPanner, s.cab ? lp : s.vehicle.position);
    // Cab occlusion: outside world is muffled and quieter from the driver's seat.
    if (s.cab !== this.cab) {
      this.cab = s.cab;
      this.occlusion.frequency.setTargetAtTime(s.cab ? 1300 : 20000, t, 0.12);
      this.exterior.gain.setTargetAtTime(s.cab ? 0.55 : 1, t, 0.12);
      this.interior.gain.setTargetAtTime(s.cab ? 1 : 0, t, 0.15);
    }
    if (this.hornNode) this.hornCab.gain.setTargetAtTime(this.cab ? 0.4 : 0, t, 0.05);
    const on = s.ignition,
      motorRps = (v / (2 * Math.PI * WHEEL_RADIUS)) * REDUCTION,
      load = on ? clamp(s.throttle * s.power * (s.boost ? 1.6 : 1), 0, 1.6) : 0,
      regen = on && s.gear === "D" && v > 1.5 ? clamp(0.25 + s.brake * 0.75, 0, 1) * (1 - s.throttle) : 0,
      torque = Math.max(load, regen * 0.7),
      spin = smooth(motorRps / 6);
    // Motor and gear orders.
    for (const o of this.orders) {
      o.osc.frequency.setTargetAtTime(Math.max(20, motorRps * o.order), t, 0.03);
      const emphasis = regen > load ? (o.order >= 24 ? 1.25 : 0.7) : 1;
      o.g.gain.setTargetAtTime(on ? o.gain * spin * (0.08 + torque * 0.3) * emphasis : 0, t, 0.06);
    }
    this.drive.gain.setTargetAtTime(on ? 0.12 : 0, t, 0.2);
    this.driveCab.gain.setTargetAtTime(on ? 0.45 : 0, t, 0.2);
    // Inverter whistle: strongest pulling away, fades as the motor spins up.
    this.carrierMod.frequency.setTargetAtTime(Math.max(5, motorRps * 8), t, 0.03);
    this.carrierGain.gain.setTargetAtTime(on ? 0.004 * load * (1 - smooth(kmh / 45)) + 0.002 * (on ? 1 : 0) : 0, t, 0.05);
    this.carrierAm.gain.setTargetAtTime(0.5, t, 0.1);
    // Pedestrian warning sound, forward and reverse, below 30 km/h.
    const avas = on && (s.gear === "D" || s.gear === "R") ? 1 - smooth((kmh - 18) / 12) : 0;
    this.avasOsc.forEach((o) => o.frequency.setTargetAtTime(240 + kmh * 9 * (s.gear === "R" ? 0.7 : 1), t, 0.05));
    this.avas.gain.setTargetAtTime(avas * 0.09, t, 0.1);
    // Tyres and wind.
    const roll = smooth(v / 3) * (s.grounded / 4);
    this.tyre.gain.setTargetAtTime(Math.pow(v / 28, 1.25) * 0.35 * roll, t, 0.08);
    this.tyreBand.frequency.setTargetAtTime(300 + v * 26, t, 0.1);
    const windAmt = Math.pow(v / 32, 2);
    this.wind.gain.setTargetAtTime(Math.min(0.22, windAmt * 0.14), t, 0.1);
    this.windCab.gain.setTargetAtTime(Math.min(0.16, windAmt * 0.1), t, 0.1);
    this.windBand.frequency.setTargetAtTime(260 + v * 22, t, 0.15);
    // Skid squeal, pitch wandering with slip.
    const skid = clamp((s.skid - 1.4) / 5, 0, 1) * roll;
    this.skid.gain.setTargetAtTime(skid * 0.42, t, 0.04);
    const wander = 1 + Math.sin(s.time * 13.1) * 0.03 + Math.sin(s.time * 31.7) * 0.015;
    this.skidA.frequency.setTargetAtTime(1150 * wander + skid * 220, t, 0.03);
    this.skidB.frequency.setTargetAtTime(2350 * wander + skid * 300, t, 0.03);
    this.squeal.frequency.setTargetAtTime(820 * wander + skid * 160, t, 0.03);
    // Structure groaning while the body is still deforming.
    const groan = clamp(s.plastic * 4, 0, 1);
    this.groan.gain.setTargetAtTime(groan * 0.12, t, groan > 0 ? 0.02 : 0.25);
    this.groanOsc.frequency.setTargetAtTime(55 + Math.random() * 40, t, 0.05);
    this.groanFilter.frequency.setTargetAtTime(rand(220, 560), t, 0.08);
    this.groanFilter2.frequency.setTargetAtTime(rand(700, 1400), t, 0.08);
    // Cabin bed and HVAC.
    this.cabinBed.gain.setTargetAtTime(smooth(v / 4) * (0.35 + Math.min(0.75, v / 30)), t, 0.15);
    this.cabinShelf.gain.setTargetAtTime(Math.min(6, s.suspensionActivity * 30), t, 0.1);
    if (this.cabinSrc) this.cabinSrc.playbackRate.setTargetAtTime(0.8 + Math.min(0.45, v / 60), t, 0.2);
    this.hvac.gain.setTargetAtTime(on ? 0.035 : 0, t, 0.4);
    // Suspension: thumps on hard compressions.
    if (s.bump > 0.35 && s.time - (this.lastBump || 0) > 0.18) {
      this.lastBump = s.time;
      this.thud(null, clamp(s.bump / 2.5, 0.15, 1), this.cab ? this.interior : null);
      if (s.bump > 1.2) this.crunch(null, 2);
    }
    // Turn signal relay, alternating tick and tock, louder from the seat.
    const tick = Math.floor(s.time * 2.6);
    if (s.signal && tick !== this.lastTick) {
      this.lastTick = tick;
      this.burst({ freq: tick % 2 ? 2300 : 3400, q: 5, dur: 0.018, gain: this.cab ? 0.16 : 0.05, dest: this.cab ? this.interior : null });
      this.ping({ freq: tick % 2 ? 640 : 820, dur: 0.03, gain: 0.025, dest: this.cab ? this.interior : null });
    }
    // Reversing beeper on the rear of the van.
    const r = Math.floor(s.time * 1.25);
    if (s.reverse && r !== this.lastReverse) {
      this.lastReverse = r;
      this.ping({ freq: 1040, dur: 0.32, gain: 0.07, type: "square", reverb: 0.3 });
    }
  }
}
