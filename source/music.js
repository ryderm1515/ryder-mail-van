// Generative score for the walkthrough.
//
// A slow, warm ambient bed in F: detuned pads moving through a four-chord
// loop, a soft sub, a sparse arpeggiated pluck through a dotted-eighth delay,
// and a whisper of brushed noise on the off-beats. Everything is synthesized
// with Web Audio on a look-ahead scheduler, so there are no files to load and
// it never loops audibly. It plays through the main mix, so the sound toggle
// mutes it too.

// Defaults are the walkthrough's score; the Morning Route film asks for a
// slower, softer take with a felt-piano voice instead of plucks.
// F major colour: Fmaj9, Am7(add11), Dm9, Bbmaj7(#11). MIDI notes.
const CHORDS = [
  { root: 41, pad: [53, 57, 60, 64, 67], arp: [65, 69, 72, 76, 79, 72] },
  { root: 45, pad: [52, 57, 60, 64, 67], arp: [64, 69, 72, 74, 76, 72] },
  { root: 38, pad: [53, 57, 60, 62, 64], arp: [62, 65, 69, 72, 76, 69] },
  { root: 46, pad: [53, 57, 58, 62, 64], arp: [65, 70, 74, 76, 77, 74] },
];
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class TourMusic {
  constructor(audio, { bpm = 82, voice = "pluck", level = 0.42 } = {}) {
    this.audio = audio;
    this.playing = false;
    this.voice = voice;
    this.level = level;
    this.BEAT = 60 / bpm;
    this.BAR = this.BEAT * 4;
  }
  build() {
    const a = this.audio,
      c = a.ctx;
    this.c = c;
    this.out = new GainNode(c, { gain: 0 });
    this.out.connect(a.master);
    const send = new GainNode(c, { gain: 0.55 });
    this.out.connect(send).connect(a.reverb);
    // Warm tilt so it sits under the van sounds.
    this.bus = new BiquadFilterNode(c, { type: "lowpass", frequency: 5200, Q: 0.4 });
    this.bus.connect(this.out);
    // Pads breathe through a slowly moving filter.
    this.padFilter = new BiquadFilterNode(c, { type: "lowpass", frequency: 950, Q: 0.7 });
    const lfo = new OscillatorNode(c, { frequency: 0.07 }),
      lfoGain = new GainNode(c, { gain: 380 });
    lfo.connect(lfoGain).connect(this.padFilter.frequency);
    lfo.start();
    this.padFilter.connect(this.bus);
    // Dotted-eighth echo for the plucks.
    this.delay = new DelayNode(c, { delayTime: this.BEAT * 0.75, maxDelayTime: 2 });
    const fb = new GainNode(c, { gain: 0.38 }),
      tone = new BiquadFilterNode(c, { type: "lowpass", frequency: 2600 });
    this.delay.connect(tone).connect(fb).connect(this.delay);
    tone.connect(new GainNode(c, { gain: 0.5 })).connect(this.bus);
    this.pluckBus = new GainNode(c, { gain: 1 });
    this.pluckBus.connect(this.bus);
    this.pluckBus.connect(this.delay);
    this.noise = a.noise;
  }
  start() {
    const a = this.audio;
    if (!a.ctx) return;
    if (!this.c) this.build();
    const t = this.c.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(this.level, t + 3);
    if (this.playing) return;
    this.playing = true;
    this.next = t + 0.15;
    this.step = 0;
    this.timer = setInterval(() => this.schedule(), 90);
    this.schedule();
  }
  // Briefly lower the score under a sound effect.
  duck(amount = 0.4, seconds = 1.2) {
    if (!this.c || !this.playing) return;
    const t = this.c.currentTime,
      g = this.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this.level * (1 - amount), t + 0.15);
    g.setValueAtTime(this.level * (1 - amount), t + seconds);
    g.linearRampToValueAtTime(this.level, t + seconds + 0.8);
  }
  stop(fade = 2.2) {
    if (!this.c || !this.playing) return;
    const t = this.c.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0, t + fade);
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      clearInterval(this.timer);
      this.playing = false;
    }, fade * 1000 + 200);
  }
  // A gentle lift for chapter changes.
  accent() {
    if (!this.playing) return;
    const t = this.c.currentTime + 0.02,
      chord = CHORDS[Math.floor(this.step / 16) % CHORDS.length];
    [chord.arp[2] + 12, chord.arp[4] + 12].forEach((m, i) => this.bell(hz(m), t + i * 0.09, 0.045));
  }
  // Look-ahead scheduler: one step is an eighth note.
  schedule() {
    this.scheduleUntil(this.c.currentTime + 0.25);
  }
  scheduleUntil(ahead) {
    const c = this.c,
      BEAT = this.BEAT,
      BAR = this.BAR;
    while (this.next < ahead) {
      const s = this.step,
        t = this.next,
        bar = Math.floor(s / 8),
        chord = CHORDS[Math.floor(bar / 2) % CHORDS.length];
      if (s % 16 === 0) {
        this.pad(chord.pad, t, BAR * 2);
        this.sub(hz(chord.root), t, BAR * 2);
      }
      // Sparse arpeggio: mostly on, with rests that keep it human.
      const pick = (s * 7 + bar * 3) % 11;
      if (s % 2 === 0 || pick < 4) {
        if (pick !== 5 && pick !== 9) (this.voice === "piano" ? this.piano : this.pluck).call(this, hz(chord.arp[(s + bar) % chord.arp.length]), t, s % 8 === 0 ? 0.075 : 0.05);
      }
      if (s % 2 === 1) this.brush(t, s % 4 === 3 ? 0.018 : 0.011);
      if (s % 8 === 4 && bar % 4 === 3) this.bell(hz(chord.arp[3] + 12), t, 0.03);
      this.next += BEAT / 2;
      this.step++;
    }
  }
  pad(notes, t, dur) {
    const c = this.c,
      g = new GainNode(c, { gain: 0 });
    g.connect(this.padFilter);
    const peak = 0.038;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 2.2);
    g.gain.setValueAtTime(peak, t + dur - 0.4);
    g.gain.linearRampToValueAtTime(0, t + dur + 2.8);
    for (const m of notes)
      for (const det of [-7, 6]) {
        const o = new OscillatorNode(c, { type: "sawtooth", frequency: hz(m), detune: det + (Math.random() * 4 - 2) });
        o.connect(g);
        o.start(t);
        o.stop(t + dur + 3);
      }
  }
  sub(f, t, dur) {
    const c = this.c,
      o = new OscillatorNode(c, { type: "sine", frequency: f }),
      g = new GainNode(c, { gain: 0 });
    o.connect(g).connect(this.bus);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.11, t + 1.2);
    g.gain.setValueAtTime(0.11, t + dur - 0.5);
    g.gain.linearRampToValueAtTime(0, t + dur + 1);
    o.start(t);
    o.stop(t + dur + 1.1);
  }
  pluck(f, t, vel) {
    const c = this.c,
      o = new OscillatorNode(c, { type: "triangle", frequency: f }),
      o2 = new OscillatorNode(c, { type: "sine", frequency: f * 2 }),
      g = new GainNode(c, { gain: 0 }),
      g2 = new GainNode(c, { gain: 0.25 }),
      lp = new BiquadFilterNode(c, { type: "lowpass", frequency: 3200, Q: 0.3 });
    o.connect(lp);
    o2.connect(g2).connect(lp);
    lp.connect(g).connect(this.pluckBus);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    lp.frequency.setValueAtTime(3600, t);
    lp.frequency.exponentialRampToValueAtTime(900, t + 0.6);
    o.start(t);
    o2.start(t);
    o.stop(t + 1.2);
    o2.stop(t + 1.2);
  }
  // Felt piano: a few slightly stretched partials with a soft hammer.
  piano(f, t, vel) {
    const c = this.c,
      g = new GainNode(c, { gain: 0 }),
      lp = new BiquadFilterNode(c, { type: "lowpass", frequency: 2400, Q: 0.2 });
    g.connect(lp).connect(this.pluckBus);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel * 1.1, t + 0.012);
    g.gain.exponentialRampToValueAtTime(vel * 0.35, t + 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    [1, 2.003, 3.01, 4.03].forEach((k, i) => {
      const o = new OscillatorNode(c, { type: "sine", frequency: f * k }),
        pg = new GainNode(c, { gain: [1, 0.35, 0.12, 0.05][i] });
      o.connect(pg).connect(g);
      o.start(t);
      o.stop(t + 2.5);
    });
    if (this.noise) {
      const s = new AudioBufferSourceNode(c, { buffer: this.noise }),
        bp = new BiquadFilterNode(c, { type: "bandpass", frequency: f * 3, Q: 1.2 }),
        hg = new GainNode(c, { gain: 0 });
      s.connect(bp).connect(hg).connect(lp);
      hg.gain.setValueAtTime(vel * 0.25, t);
      hg.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      s.start(t, Math.random());
      s.stop(t + 0.06);
    }
  }
  bell(f, t, vel) {
    const c = this.c,
      o = new OscillatorNode(c, { type: "sine", frequency: f }),
      m = new OscillatorNode(c, { type: "sine", frequency: f * 3.5 }),
      mg = new GainNode(c, { gain: f * 0.6 }),
      g = new GainNode(c, { gain: 0 });
    m.connect(mg).connect(o.frequency);
    o.connect(g).connect(this.pluckBus);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
    mg.gain.setValueAtTime(f * 0.6, t);
    mg.gain.exponentialRampToValueAtTime(1, t + 1.2);
    o.start(t);
    m.start(t);
    o.stop(t + 2.7);
    m.stop(t + 2.7);
  }
  brush(t, vel) {
    if (!this.noise) return;
    const c = this.c,
      s = new AudioBufferSourceNode(c, { buffer: this.noise }),
      hp = new BiquadFilterNode(c, { type: "highpass", frequency: 6500, Q: 0.6 }),
      g = new GainNode(c, { gain: 0 });
    s.connect(hp).connect(g).connect(this.bus);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    s.start(t, Math.random() * 1.5);
    s.stop(t + 0.1);
  }
}
