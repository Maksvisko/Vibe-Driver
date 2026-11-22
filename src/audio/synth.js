/**
 * Built-in synthwave loop — plays when there are no user tracks.
 * Pure Web Audio: kick, snare, hats, sub bass, arp with dotted-8th delay.
 * Scheduler: 25ms lookahead, 4-bar progression Am–F–C–G.
 */
export class SynthLoop {
  constructor() {
    this.running = false;
    this.bpm = 110;
    this.step = 0;          // 16th notes, 0..63 (4 bars)
    this.nextTime = 0;
    this.timer = null;
    this.ctx = null;
    this.out = null;
    this.delay = null;
    this.noiseBuf = null;
  }

  start(ctx, dest) {
    if (this.running || !ctx) return false;
    try {
      const now = ctx.currentTime;
      this.ctx = ctx;

      this.out = ctx.createGain();
      this.out.gain.setValueAtTime(0.0001, now);
      this.out.gain.exponentialRampToValueAtTime(0.55, now + 1.2);
      this.out.connect(dest || ctx.destination);

      // dotted-8th delay for the arp
      const stepDur = 60 / this.bpm / 4;
      this.delay = ctx.createDelay(1.5);
      this.delay.delayTime.value = stepDur * 3;
      const fb = ctx.createGain();
      fb.gain.value = 0.36;
      const wet = ctx.createGain();
      wet.gain.value = 0.32;
      this.delay.connect(fb);
      fb.connect(this.delay);
      this.delay.connect(wet);
      wet.connect(this.out);

      // shared noise buffer for drums
      const len = Math.floor(ctx.sampleRate * 1);
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

      this.step = 0;
      this.nextTime = now + 0.08;
      this.running = true;
      this.timer = setInterval(() => this._tick(), 25);
      return true;
    } catch (e) {
      console.warn('SynthLoop start failed:', e);
      this.stop();
      return false;
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.out && this.ctx) {
      try {
        const now = this.ctx.currentTime;
        const g = this.out.gain;
        g.cancelScheduledValues(now);
        g.setValueAtTime(Math.max(g.value, 0.0001), now);
        g.exponentialRampToValueAtTime(0.0001, now + 0.35);
        const out = this.out;
        setTimeout(() => { try { out.disconnect(); } catch { /* ok */ } }, 600);
      } catch { /* ok */ }
    }
    this.out = null;
    this.delay = null;
    this.running = false;
  }

  _tick() {
    if (!this.running || !this.ctx) return;
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;
    const stepDur = 60 / this.bpm / 4;
    const horizon = ctx.currentTime + 0.12;
    let guard = 0;
    while (this.nextTime < horizon && guard++ < 32) {
      try {
        this._playStep(this.step, this.nextTime);
      } catch (e) {
        console.warn('SynthLoop step error:', e);
      }
      this.nextTime += stepDur;
      this.step = (this.step + 1) % 64;
    }
    // после свёрнутой вкладки могли сильно отстать — перезапускаем по часам
    if (this.nextTime < ctx.currentTime) this.nextTime = ctx.currentTime + 0.05;
  }

  _playStep(step, t) {
    const ctx = this.ctx;
    const stepDur = 60 / this.bpm / 4;
    const bar = Math.floor(step / 16);
    const s = step % 16;

    // Am – F – C – G
    const roots = [55.0, 43.65, 65.41, 49.0];
    const triads = [
      [220.0, 261.63, 329.63],   // Am: A3 C4 E4
      [174.61, 220.0, 261.63],   // F:  F3 A3 C4
      [261.63, 329.63, 392.0],   // C:  C4 E4 G4
      [196.0, 246.94, 293.66],   // G:  G3 B3 D4
    ];
    const root = roots[bar];
    const triad = triads[bar];

    // drums
    if (s % 4 === 0) this._kick(t);
    if (s === 4 || s === 12) this._snare(t);
    if (s % 2 === 0) this._hat(t, s % 8 === 0 ? 0.24 : 0.15);

    // sub bass on 8ths with octave jump
    if (s % 2 === 0) {
      const oct = (s === 6 || s === 14) ? 2 : 1;
      this._bass(t, root * oct, stepDur * 1.8);
    }

    // arp through triad
    const arpSeq = [0, 1, 2, 1, 0, 2, 1, 2, 0, 1, 2, 1, 2, 1, 0, 1];
    this._arp(t, triad[arpSeq[s]] * 2, stepDur * 1.6);
  }

  _kick(t) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1.0, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    o.connect(g);
    g.connect(this.out);
    o.start(t);
    o.stop(t + 0.26);
  }

  _snare(t) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    src.connect(hp);
    hp.connect(g);
    g.connect(this.out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.18);
    // tonal body
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 185;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.28, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(og);
    og.connect(this.out);
    o.start(t);
    o.stop(t + 0.12);
  }

  _hat(t, vol) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
    src.connect(hp);
    hp.connect(g);
    g.connect(this.out);
    src.start(t, Math.random() * 0.4);
    src.stop(t + 0.06);
  }

  _bass(t, freq, dur) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const sub = ctx.createOscillator();
    sub.type = 'square';
    sub.frequency.value = freq / 2;
    const subG = ctx.createGain();
    subG.gain.value = 0.55;

    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q = 8;
    f.frequency.setValueAtTime(Math.min(2400, freq * 10), t);
    f.frequency.exponentialRampToValueAtTime(Math.max(140, freq * 3), t + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.45, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    o.connect(f);
    sub.connect(subG);
    subG.connect(f);
    f.connect(g);
    g.connect(this.out);
    o.start(t);
    sub.start(t);
    o.stop(t + dur + 0.05);
    sub.stop(t + dur + 0.05);
  }

  _arp(t, freq, dur) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.value = freq;
    o2.detune.value = 9;

    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 3200;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    o.connect(f);
    o2.connect(f);
    f.connect(g);
    g.connect(this.out);
    if (this.delay) g.connect(this.delay);
    o.start(t);
    o2.start(t);
    o.stop(t + dur + 0.05);
    o2.stop(t + dur + 0.05);
  }
}
