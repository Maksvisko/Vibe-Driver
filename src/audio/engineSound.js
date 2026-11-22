/**
 * Engine sound — tiny WebAudio synth (saw + noise), pitch follows RPM.
 * Toggle with M. Music stays the main character; this sits low in the mix.
 */
export class EngineSound {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.master = null;
    this.osc = null;
    this.osc2 = null;
    this.filter = null;
    this.noiseGain = null;
    this.started = false;
  }

  _init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.0;
      this.master.connect(this.ctx.destination);

      this.filter = this.ctx.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.value = 700;
      this.filter.Q.value = 4;
      this.filter.connect(this.master);

      this.osc = this.ctx.createOscillator();
      this.osc.type = 'sawtooth';
      this.osc.frequency.value = 60;

      this.osc2 = this.ctx.createOscillator();
      this.osc2.type = 'square';
      this.osc2.frequency.value = 61;
      const mix = this.ctx.createGain();
      mix.gain.value = 0.35;
      this.osc.connect(mix);
      this.osc2.connect(mix);
      mix.connect(this.filter);

      // exhaust noise
      const bufferSize = this.ctx.sampleRate * 2;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
      const noise = this.ctx.createBufferSource();
      noise.buffer = buffer;
      noise.loop = true;
      this.noiseGain = this.ctx.createGain();
      this.noiseGain.gain.value = 0.04;
      noise.connect(this.noiseGain);
      this.noiseGain.connect(this.filter);

      this.osc.start();
      this.osc2.start();
      noise.start();
      this.started = true;
    } catch (e) {
      console.warn('Engine sound unavailable', e);
    }
  }

  /** @param {number} rpmNorm 0..1  @param {number} load 0..1 */
  update(rpmNorm, load) {
    if (!this.enabled) {
      if (this.master) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
      return;
    }
    this._init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    const t = this.ctx.currentTime;
    const freq = 45 + rpmNorm * 160;
    this.osc.frequency.setTargetAtTime(freq, t, 0.05);
    this.osc2.frequency.setTargetAtTime(freq * 1.007, t, 0.05);
    this.filter.frequency.setTargetAtTime(350 + rpmNorm * 1800 + load * 600, t, 0.08);
    this.master.gain.setTargetAtTime(0.05 + load * 0.05 + rpmNorm * 0.02, t, 0.1);
  }

  cut() {
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
    }
  }

  /** Call from a user gesture to pre-create + resume the context. */
  unlock() {
    this._init();
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) this.cut();
    return this.enabled;
  }
}
