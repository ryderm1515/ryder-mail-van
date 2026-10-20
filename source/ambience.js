// Willow Lane soundscape for the Morning Route film.
//
// Everything is synthesized: birdsong (three voices), a babbling creek, a
// breeze in the leaves, a far-off dog, a ticking sprinkler, one porch's wind
// chimes, the van's soft electric hum and tyre roll, and the foley of a
// delivery (door slide, mailbox lid, flag, gravel). Events run on a
// look-ahead scheduler; `scheduleUntil` also lets an offline render prime it.
// It all routes through the main mix, so the sound toggle mutes it.

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

export class Ambience {
  constructor(audio) {
    this.audio = audio;
    this.playing = false;
    this.state = { cam: null, van: null, speed: 0, creek: null, sprinkler: null };
  }
  build() {
    const a = this.audio,
      c = a.ctx;
    this.c = c;
    this.out = new GainNode(c, { gain: 0 });
    // Soft top end: nothing in the bed should sound hissy.
    const tone = new BiquadFilterNode(c, { type: "lowpass", frequency: 6500, Q: 0.3 });
    this.out.connect(tone).connect(a.master);
    this.wet = new GainNode(c, { gain: 0.35 });
    this.out.connect(this.wet).connect(a.reverb);
    this.noise = a.noise;
    // Continuous beds.
    this.creekGain = new GainNode(c, { gain: 0 });
    this.creekGain.connect(this.out);
    this.loop(new BiquadFilterNode(c, { type: "bandpass", frequency: 900, Q: 0.5 }), this.creekGain, 0.55, 1.0);
    this.loop(new BiquadFilterNode(c, { type: "bandpass", frequency: 1800, Q: 1.2 }), this.creekGain, 0.08, 1.2);
    this.breezeGain = new GainNode(c, { gain: 0.05 });
    this.breezeGain.connect(this.out);
    this.loop(new BiquadFilterNode(c, { type: "lowpass", frequency: 420 }), this.breezeGain, 0.9, 0.7);
    this.leaves = new GainNode(c, { gain: 0 });
    this.leaves.connect(this.out);
    this.loop(new BiquadFilterNode(c, { type: "bandpass", frequency: 3200, Q: 0.7 }), this.leaves, 0.07, 1.1);
    // Van: hum (two sines) and tyre roll.
    this.hum = new GainNode(c, { gain: 0 });
    this.hum.connect(this.out);
    this.humA = new OscillatorNode(c, { type: "sine", frequency: 180 });
    this.humB = new OscillatorNode(c, { type: "sine", frequency: 365 });
    const hb = new GainNode(c, { gain: 0.4 });
    this.humA.connect(this.hum);
    this.humB.connect(hb).connect(this.hum);
    this.humA.start();
    this.humB.start();
    this.roll = new GainNode(c, { gain: 0 });
    this.roll.connect(this.out);
    this.loop(new BiquadFilterNode(c, { type: "lowpass", frequency: 380 }), this.roll, 1, 0.6);
  }
  loop(filter, dest, gain, rate) {
    const s = new AudioBufferSourceNode(this.c, { buffer: this.noise, loop: true, playbackRate: rate }),
      g = new GainNode(this.c, { gain });
    s.connect(filter).connect(g).connect(dest);
    s.start(0, Math.random());
    (this.sources ||= []).push(s);
  }
  start() {
    if (!this.audio.ctx) return;
    if (!this.c) this.build();
    const t = this.c.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0.9, t + 2.5);
    if (this.playing) return;
    this.playing = true;
    this.next = { chirp: t + 0.4, whistle: t + 2.2, coo: t + 5, dog: t + 11, chime: t + 3.5, tick: t + 0.2, swell: t };
    clearInterval(this.timer);
    this.timer = setInterval(() => this.scheduleUntil(this.c.currentTime + 0.3), 100);
  }
  stop(fade = 2) {
    if (!this.c || !this.playing) return;
    const t = this.c.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0, t + Math.max(0.01, fade));
    clearInterval(this.timer);
    this.playing = false;
  }
  // ctx: cam, van (Vector3), speed (m/s), creek, sprinkler (Vector3)
  update(s) {
    Object.assign(this.state, s);
    if (!this.c) return;
    const t = this.c.currentTime,
      st = this.state,
      dist = (a, b) => (a && b ? a.distanceTo(b) : 1e9);
    const near = (d, r) => clamp(1 - d / r);
    this.creekGain.gain.setTargetAtTime(0.012 + 0.11 * near(dist(st.cam, st.creek), 55) ** 1.5, t, 0.4);
    const v = clamp(st.speed / 9),
      dv = near(dist(st.cam, st.van), 45);
    this.hum.gain.setTargetAtTime(0.03 * v * (0.35 + 0.65 * dv), t, 0.15);
    this.humA.frequency.setTargetAtTime(140 + st.speed * 48, t, 0.2);
    this.humB.frequency.setTargetAtTime((140 + st.speed * 48) * 2.03, t, 0.2);
    this.roll.gain.setTargetAtTime(0.045 * v * (0.3 + 0.7 * dv), t, 0.2);
    this.sprinklerLevel = near(dist(st.cam, st.sprinkler), 30);
  }
  scheduleUntil(ahead) {
    const n = this.next;
    if (!n) return;
    while (n.chirp < ahead) this.chirp(n.chirp), (n.chirp += rand(1.2, 3.6));
    while (n.whistle < ahead) this.whistle(n.whistle), (n.whistle += rand(5, 11));
    while (n.coo < ahead) this.coo(n.coo), (n.coo += rand(9, 16));
    while (n.dog < ahead) this.woof(n.dog), (n.dog += rand(16, 28));
    while (n.chime < ahead) this.chime(n.chime), (n.chime += rand(4, 9));
    while (n.tick < ahead) {
      if ((this.sprinklerLevel ?? 0) > 0.02) this.tick(n.tick, this.sprinklerLevel);
      n.tick += 0.13;
    }
    while (n.swell < ahead) {
      // Gusts: breeze and leaves breathe together.
      const g = rand(0.02, 0.05),
        d = rand(3, 6);
      this.breezeGain.gain.setTargetAtTime(g, n.swell, d / 3);
      this.leaves.gain.setTargetAtTime(g * 0.6, n.swell, d / 3);
      n.swell += d;
    }
  }
  // ---------------------------------------------------------------- voices
  voice(t, pan, gain, reverb = 0.3) {
    const g = new GainNode(this.c, { gain: 0 }),
      p = new StereoPannerNode(this.c, { pan });
    g.connect(p).connect(this.out);
    if (reverb) {
      const w = new GainNode(this.c, { gain: reverb });
      p.connect(w).connect(this.audio.reverb);
    }
    return { g, gain };
  }
  osc(type, f, t, dur, dest) {
    const o = new OscillatorNode(this.c, { type, frequency: f });
    o.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }
  chirp(t) {
    // A quick trill of 3-6 rising/falling FM chirps.
    const { g } = this.voice(t, rand(-0.8, 0.8), 0, 0.35),
      n = Math.floor(rand(3, 7)),
      base = rand(3000, 4600),
      up = Math.random() > 0.5;
    for (let i = 0; i < n; i++) {
      const s = t + i * rand(0.06, 0.09),
        e = new GainNode(this.c, { gain: 0 });
      e.connect(g);
      const o = this.osc("sine", base, s, 0.07, e);
      o.frequency.setValueAtTime(base * (up ? 0.85 : 1.15), s);
      o.frequency.exponentialRampToValueAtTime(base * (up ? 1.2 : 0.8), s + 0.05);
      e.gain.setValueAtTime(0, s);
      e.gain.linearRampToValueAtTime(rand(0.012, 0.022), s + 0.008);
      e.gain.exponentialRampToValueAtTime(0.0001, s + 0.065);
    }
    g.gain.setValueAtTime(1, t);
  }
  whistle(t) {
    // Two clear notes, high then lower, with a little vibrato.
    const { g } = this.voice(t, rand(-0.6, 0.6), 0, 0.4);
    g.gain.setValueAtTime(1, t);
    const f = rand(2000, 2500);
    [
      [0, f, 0.2],
      [0.26, f * 0.78, 0.3],
    ].forEach(([dt, fr, d]) => {
      const e = new GainNode(this.c, { gain: 0 }),
        o = this.osc("sine", fr, t + dt, d, e),
        lfo = new OscillatorNode(this.c, { frequency: 22 }),
        lg = new GainNode(this.c, { gain: fr * 0.012 });
      lfo.connect(lg).connect(o.frequency);
      lfo.start(t + dt);
      lfo.stop(t + dt + d + 0.05);
      e.connect(g);
      e.gain.setValueAtTime(0, t + dt);
      e.gain.linearRampToValueAtTime(0.018, t + dt + 0.03);
      e.gain.setValueAtTime(0.018, t + dt + d - 0.06);
      e.gain.linearRampToValueAtTime(0, t + dt + d);
    });
  }
  coo(t) {
    // Distant dove: soft, low "hoo-OO-hoo".
    const { g } = this.voice(t, rand(-0.9, 0.9), 0, 0.6),
      bp = new BiquadFilterNode(this.c, { type: "lowpass", frequency: 900 });
    bp.connect(g);
    g.gain.setValueAtTime(1, t);
    [
      [0, 0.32, 520, 560],
      [0.42, 0.55, 560, 600],
      [1.05, 0.4, 540, 500],
    ].forEach(([dt, d, f0, f1]) => {
      const e = new GainNode(this.c, { gain: 0 }),
        o = this.osc("sine", f0, t + dt, d, e);
      o.frequency.linearRampToValueAtTime(f1, t + dt + d);
      e.connect(bp);
      e.gain.setValueAtTime(0, t + dt);
      e.gain.linearRampToValueAtTime(0.02, t + dt + d * 0.3);
      e.gain.linearRampToValueAtTime(0, t + dt + d);
    });
  }
  woof(t) {
    // Two muffled barks from a few gardens away.
    const { g } = this.voice(t, rand(-0.9, 0.9), 0, 0.8),
      lp = new BiquadFilterNode(this.c, { type: "lowpass", frequency: 700 }),
      bp = new BiquadFilterNode(this.c, { type: "bandpass", frequency: 520, Q: 1.4 });
    bp.connect(lp).connect(g);
    g.gain.setValueAtTime(1, t);
    for (const dt of [0, 0.32]) {
      const e = new GainNode(this.c, { gain: 0 }),
        o = this.osc("sawtooth", 300, t + dt, 0.16, e);
      o.frequency.setValueAtTime(330, t + dt);
      o.frequency.exponentialRampToValueAtTime(210, t + dt + 0.14);
      e.connect(bp);
      e.gain.setValueAtTime(0, t + dt);
      e.gain.linearRampToValueAtTime(0.03, t + dt + 0.015);
      e.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.15);
    }
  }
  chime(t) {
    // A breath of wind through one porch's chimes.
    const { g } = this.voice(t, 0.55, 0, 0.6);
    g.gain.setValueAtTime(1, t);
    const notes = [1318, 1568, 1760, 2093, 2349];
    const n = Math.floor(rand(2, 5));
    for (let i = 0; i < n; i++) {
      const s = t + i * rand(0.12, 0.35),
        f = notes[Math.floor(Math.random() * notes.length)];
      for (const [k, a] of [
        [1, 1],
        [2.76, 0.4],
        [5.4, 0.15],
      ]) {
        const e = new GainNode(this.c, { gain: 0 });
        this.osc("sine", f * k, s, 2.4, e);
        e.connect(g);
        e.gain.setValueAtTime(0, s);
        e.gain.linearRampToValueAtTime(0.006 * a, s + 0.004);
        e.gain.exponentialRampToValueAtTime(0.00001, s + 2.2 / k ** 0.3);
      }
    }
  }
  tick(t, level) {
    const s = new AudioBufferSourceNode(this.c, { buffer: this.noise }),
      hp = new BiquadFilterNode(this.c, { type: "bandpass", frequency: 5200, Q: 2 }),
      e = new GainNode(this.c, { gain: 0 });
    s.connect(hp).connect(e).connect(this.out);
    e.gain.setValueAtTime(0.05 * level, t);
    e.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
    s.start(t, Math.random());
    s.stop(t + 0.03);
  }
  // ---------------------------------------------------------------- foley
  foley(name, at, when = null) {
    if (!this.c) return;
    const t = when ?? this.c.currentTime + 0.01,
      { g } = this.voice(t, 0.25, 0, 0.25);
    g.gain.setValueAtTime(1, t);
    const noise = (dur, type, f, q, peak, attack = 0.01) => {
      const s = new AudioBufferSourceNode(this.c, { buffer: this.noise }),
        flt = new BiquadFilterNode(this.c, { type, frequency: f, Q: q }),
        e = new GainNode(this.c, { gain: 0 });
      s.connect(flt).connect(e).connect(g);
      e.gain.setValueAtTime(0, t);
      e.gain.linearRampToValueAtTime(peak, t + attack);
      e.gain.linearRampToValueAtTime(0, t + dur);
      s.start(t, Math.random());
      s.stop(t + dur + 0.05);
      return flt;
    };
    const tone = (f, dur, peak, dt = 0, type = "sine") => {
      const e = new GainNode(this.c, { gain: 0 }),
        o = this.osc(type, f, t + dt, dur, e);
      e.connect(g);
      e.gain.setValueAtTime(0, t + dt);
      e.gain.linearRampToValueAtTime(peak, t + dt + 0.004);
      e.gain.exponentialRampToValueAtTime(0.0001, t + dt + dur);
      return o;
    };
    if (name === "door") {
      // Sliding door: rolling rumble along its track, then a soft latch.
      const f = noise(1.3, "bandpass", 500, 0.8, 0.05, 0.2);
      f.frequency.linearRampToValueAtTime(900, t + 1.2);
      tone(110, 0.25, 0.05, 1.25);
      noise(0.08, "highpass", 2500, 0.5, 0.03, 0.002);
    } else if (name === "mailbox") {
      // Tin lid: a bright tink and a little rattle.
      tone(1850, 0.35, 0.03);
      tone(2760, 0.25, 0.018, 0.002);
      tone(1870, 0.25, 0.015, 0.08);
      noise(0.06, "bandpass", 3000, 2, 0.02, 0.002);
    } else if (name === "flag") {
      // Spring-loaded flag: a playful boing.
      const o = tone(420, 0.5, 0.03, 0, "triangle");
      o.frequency.setValueAtTime(420, t);
      o.frequency.linearRampToValueAtTime(640, t + 0.08);
      o.frequency.linearRampToValueAtTime(520, t + 0.2);
      o.frequency.linearRampToValueAtTime(580, t + 0.32);
    } else if (name === "gravel") {
      // Tyres settling to a stop on a sandy kerb.
      for (let i = 0; i < 14; i++) {
        const s = t + i * rand(0.02, 0.06);
        const src = new AudioBufferSourceNode(this.c, { buffer: this.noise }),
          bp = new BiquadFilterNode(this.c, { type: "bandpass", frequency: rand(1200, 3200), Q: 3 }),
          e = new GainNode(this.c, { gain: 0 });
        src.connect(bp).connect(e).connect(g);
        e.gain.setValueAtTime(rand(0.01, 0.025) * (1 - i / 16), s);
        e.gain.exponentialRampToValueAtTime(0.0001, s + 0.03);
        src.start(s, Math.random());
        src.stop(s + 0.04);
      }
    }
  }
}
