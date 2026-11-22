/**
 * Music engine:
 *  - user playlist from ./music/playlist.json (npm run scan-music)
 *  - if missing/empty → built-in Synthwave loop plays out of the box
 *  - HTMLAudio + WebAudio analyser for spectrum HUD
 * Never throws: all failures degrade gracefully.
 */
import { SynthLoop } from './synth.js';

export class MusicPlayer {
  constructor() {
    this.tracks = [];          // [{title, artist, url}]
    this.index = -1;
    this.playing = false;
    this.ready = false;
    this.usingSynth = false;

    this.audio = new Audio();
    this.audio.crossOrigin = 'anonymous';
    this.audio.preload = 'auto';

    this.ctx = null;
    this.analyser = null;
    this.freqData = null;
    this.synth = new SynthLoop();

    this.audio.addEventListener('ended', () => this.next(true));
    this.audio.addEventListener('error', () => {
      if (this.index >= 0) {
        console.warn('Track failed:', this.tracks[this.index]?.url);
      }
    });
  }

  /** Load playlist; NEVER rejects. */
  async load() {
    this.tracks = [];
    try {
      const res = await fetch('./music/playlist.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('no playlist');
      const data = await res.json();
      if (Array.isArray(data?.tracks)) {
        this.tracks = data.tracks
          .filter((t) => t && t.url)
          .map((t) => ({
            title: t.title || 'Без названия',
            artist: t.artist || 'Unknown',
            url: t.url,
          }));
      }
    } catch (e) {
      console.info('Playlist unavailable, synth fallback will be used.', e?.message || e);
      this.tracks = [];
    }
    this.ready = true;
    return this.tracks;
  }

  _ensureCtx() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = this.ctx.createMediaElementSource(this.audio);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 128;
      this.analyser.smoothingTimeConstant = 0.75;
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      src.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    } catch (e) {
      console.warn('WebAudio unavailable, plain playback', e);
      this.ctx = null;
    }
  }

  /** Must be called from a user gesture (click/keydown) to unlock audio. */
  unlock() {
    this._ensureCtx();
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  async play(index) {
    if (index < 0 || index >= this.tracks.length) return false;
    this._stopSynth();
    this._ensureCtx();
    try {
      if (this.ctx?.state === 'suspended') await this.ctx.resume();
    } catch { /* ok */ }

    const t = this.tracks[index];
    const sameTrack = this.index === index;
    this.index = index;
    try {
      if (!sameTrack || !this.audio.src.endsWith(encodeURI(t.url))) {
        this.audio.src = t.url;
      }
      await this.audio.play();
      this.playing = true;
      return true;
    } catch (e) {
      console.warn('play() blocked:', e);
      this.playing = false;
      return false;
    }
  }

  /** Start built-in synthwave loop (no tracks needed). */
  startSynth() {
    this._ensureCtx();
    if (!this.ctx) return false;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    try {
      this.audio.pause();
      const ok = this.synth.start(this.ctx, this.analyser || this.ctx.destination);
      this.usingSynth = ok;
      this.playing = ok;
      if (ok) this.index = -1;
      return ok;
    } catch (e) {
      console.warn('Synth start failed:', e);
      this.playing = false;
      return false;
    }
  }

  _stopSynth() {
    if (this.synth.running) {
      this.synth.stop();
      this.usingSynth = false;
      if (this.index < 0) this.playing = false;
    }
  }

  /** Called on start button: playlist first, synth as fallback. */
  async startDefault() {
    this.unlock();
    if (this.tracks.length) {
      const ok = await this.play(0);
      if (ok) return 'track';
    }
    return this.startSynth() ? 'synth' : 'none';
  }

  toggle(index) {
    if (index < 0 || index >= this.tracks.length) {
      // toggling "virtual" synth entry
      if (this.usingSynth && this.playing) {
        this.pause();
        return false;
      }
      return this.startSynth();
    }
    if (this.index === index && this.playing) {
      this.pause();
      return false;
    }
    return this.play(index);
  }

  stop() {
    this.audio.pause();
    try { this.audio.currentTime = 0; } catch { /* ok */ }
    this._stopSynth();
    this.playing = false;
  }

  pause() {
    this.audio.pause();
    if (this.synth.running) this.synth.stop();
    this.usingSynth = false;
    this.playing = false;
  }

  resume() {
    if (this.usingSynth || this.index < 0) {
      this.startSynth();
      return;
    }
    this.audio.play().then(() => { this.playing = true; }).catch(() => {});
  }

  next(auto = false) {
    if (!this.tracks.length) return;
    if (this.usingSynth) return;
    const i = (this.index + 1) % this.tracks.length;
    this.play(i);
    if (auto) return;
  }

  prev() {
    if (!this.tracks.length || this.usingSynth) return;
    const i = (this.index - 1 + this.tracks.length) % this.tracks.length;
    this.play(i);
  }

  get current() {
    if (this.usingSynth) {
      return { title: 'SYNTHWAVE LOOP', artist: 'Vibe Driver · встроенный' };
    }
    return this.index >= 0 ? this.tracks[this.index] : null;
  }

  /** spectrum levels 0..1 for `bars` columns */
  spectrum(bars = 10) {
    if (!this.analyser || !this.playing) return new Array(bars).fill(0.04);
    try {
      this.analyser.getByteFrequencyData(this.freqData);
    } catch {
      return new Array(bars).fill(0.04);
    }
    const out = [];
    const step = Math.max(1, Math.floor(this.freqData.length / bars));
    for (let b = 0; b < bars; b++) {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < step; i++) {
        const idx = b * step + i;
        if (idx < this.freqData.length) { sum += this.freqData[idx]; n++; }
      }
      out.push(Math.max(0.04, n ? sum / n / 255 : 0.04));
    }
    return out;
  }
}
