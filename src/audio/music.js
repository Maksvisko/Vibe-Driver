/**
 * Music engine: playlist from /music/playlist.json (npm run scan-music),
 * HTMLAudio + WebAudio analyser for spectrum HUD.
 */
export class MusicPlayer {
  constructor() {
    this.tracks = [];          // [{title, artist, url}]
    this.index = -1;
    this.playing = false;
    this.ready = false;

    this.audio = new Audio();
    this.audio.crossOrigin = 'anonymous';
    this.audio.preload = 'auto';

    this.ctx = null;
    this.analyser = null;
    this.freqData = null;

    this._pendingPlay = false;
    this.audio.addEventListener('ended', () => this.next(true));
    this.audio.addEventListener('error', () => {
      if (this.index >= 0) {
        console.warn('Track failed:', this.tracks[this.index]?.url);
      }
    });
  }

  async load() {
    try {
      const res = await fetch('./music/playlist.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('no playlist');
      const data = await res.json();
      this.tracks = (data.tracks || []).map((t) => ({
        title: t.title || 'Без названия',
        artist: t.artist || 'Unknown',
        url: t.url,
      }));
      this.ready = true;
      return this.tracks;
    } catch {
      this.tracks = [];
      this.ready = true;
      return [];
    }
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
    }
  }

  async play(index) {
    if (index < 0 || index >= this.tracks.length) return false;
    this._ensureCtx();
    if (this.ctx?.state === 'suspended') await this.ctx.resume();

    const t = this.tracks[index];
    const sameTrack = this.index === index;
    this.index = index;
    if (!sameTrack || !this.audio.src.endsWith(encodeURI(t.url))) {
      this.audio.src = t.url;
    }
    try {
      await this.audio.play();
      this.playing = true;
      return true;
    } catch (e) {
      console.warn('play() blocked:', e);
      this.playing = false;
      return false;
    }
  }

  toggle(index) {
    if (this.index === index && this.playing) {
      this.audio.pause();
      this.playing = false;
      return false;
    }
    return this.play(index);
  }

  stop() {
    this.audio.pause();
    this.audio.currentTime = 0;
    this.playing = false;
  }

  pause() {
    this.audio.pause();
    this.playing = false;
  }

  resume() {
    if (this.index >= 0) {
      this.audio.play().then(() => { this.playing = true; }).catch(() => {});
    }
  }

  next(auto = false) {
    if (!this.tracks.length) return;
    let i = (this.index + 1) % this.tracks.length;
    this.play(i);
    if (auto) return;
  }

  prev() {
    if (!this.tracks.length) return;
    let i = (this.index - 1 + this.tracks.length) % this.tracks.length;
    this.play(i);
  }

  get current() {
    return this.index >= 0 ? this.tracks[this.index] : null;
  }

  /** spectrum levels 0..1 for `bars` columns */
  spectrum(bars = 10) {
    if (!this.analyser || !this.playing) return new Array(bars).fill(0.04);
    this.analyser.getByteFrequencyData(this.freqData);
    const out = [];
    const step = Math.floor(this.freqData.length / bars);
    for (let b = 0; b < bars; b++) {
      let sum = 0;
      for (let i = 0; i < step; i++) sum += this.freqData[b * step + i];
      out.push(Math.max(0.04, sum / step / 255));
    }
    return out;
  }
}
