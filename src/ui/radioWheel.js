/**
 * Radio wheel — the centerpiece menu.
 * A rotating wheel of tracks: A/D or arrows spin it, the top item
 * under the pointer is selected, Enter plays it.
 */
export class RadioWheel {
  constructor({ disc, music, onSelect, onClose }) {
    this.disc = disc;
    this.music = music;
    this.onSelect = onSelect;
    this.onClose = onClose;

    this.open = false;
    this.selected = 0;
    this.angle = 0;         // current disc rotation (deg)
    this.targetAngle = 0;
    this.spinVel = 0;       // keyboard spin velocity
    this.items = [];

    this._raf = null;
    this._lastTs = 0;
  }

  build() {
    this.disc.innerHTML = '';
    this.items = [];
    const n = this.music.tracks.length;
    const step = 360 / Math.max(1, n);
    const compact = n > 10;

    this.music.tracks.forEach((t, i) => {
      const el = document.createElement('div');
      el.className = 'wheel-item' + (compact ? ' compact' : '');
      const a = i * step;
      // place around circle: rotate(a) translateY(-R) then un-rotate text
      const R = 42; // % of radius
      el.style.transform =
        `rotate(${a}deg) translateY(-${R}cqw) rotate(${-a}deg)`;
      el.style.transformOrigin = 'center';
      // use container query units fallback → just use % of stage via translate trick:
      el.style.transform =
        `rotate(${a}deg) translateY(calc(var(--wheel-r, 240px) * -1)) rotate(${-a}deg)`;
      el.innerHTML = `<span class="num">${String(i + 1).padStart(2, '0')}</span>${escapeHtml(t.title)}`;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selected = i;
        this._snapTo(true);
        this._commit();
      });
      this.disc.appendChild(el);
      this.items.push(el);
    });

    // set wheel radius from stage size
    this._resizeRadius();
    window.addEventListener('resize', this._resizeRadius = this._resizeRadius.bind(this));
  }

  _resizeRadius() {
    const stage = this.disc.parentElement;
    if (!stage) return;
    const r = stage.clientWidth * 0.36;
    this.disc.style.setProperty('--wheel-r', `${r}px`);
  }

  show() {
    if (!this.open) {
      this.open = true;
      this.selected = Math.max(0, this.music.index);
      this._snapTo(false);
      document.getElementById('radio').classList.remove('hidden');
      this._lastTs = performance.now();
      this._loop();
      this._updateSelectionUI();
      this._updateNowPlaying();
    }
  }

  hide() {
    if (this.open) {
      this.open = false;
      document.getElementById('radio').classList.add('hidden');
      cancelAnimationFrame(this._raf);
      this.onClose?.();
    }
  }

  toggle() {
    this.open ? this.hide() : this.show();
  }

  /** called every frame while open with input state */
  handleInput(keys) {
    if (!this.open) return;

    let dir = 0;
    if (keys.isDown('KeyA') || keys.isDown('ArrowLeft')) dir -= 1;
    if (keys.isDown('KeyD') || keys.isDown('ArrowRight')) dir += 1;

    const n = this.music.tracks.length;
    if (!n) return;

    if (dir !== 0) {
      this.spinVel += dir * 420; // deg/s²
      this.spinVel = Math.max(-900, Math.min(900, this.spinVel));
    }

    if (keys.wasPressed('Enter') || keys.wasPressed('NumpadEnter')) {
      this._commit();
    }
    if (keys.wasPressed('Space')) {
      if (this.music.playing) this.music.pause();
      else this.music.resume();
      this._updateNowPlaying();
    }
    if (keys.wasPressed('KeyE') || keys.wasPressed('ArrowUp') || keys.wasPressed('KeyW')) {
      this.selectBy(-1);
    }
    if (keys.wasPressed('KeyQ') || keys.wasPressed('ArrowDown') || keys.wasPressed('KeyS')) {
      this.selectBy(1);
    }
    if (keys.wasPressed('Tab')) {
      this.hide();
    }
    if (keys.wasPressed('Escape')) {
      this.hide();
    }
  }

  selectBy(d) {
    const n = this.music.tracks.length;
    if (!n) return;
    this.selected = ((this.selected + d) % n + n) % n;
    this._snapTo(true);
    this._updateSelectionUI();
  }

  _snapTo(animate) {
    const n = this.music.tracks.length;
    if (!n) return;
    const step = 360 / n;
    // rotate disc so selected item is at top (pointer at -90°... item0 at angle 0 = top by default?)
    // items placed with rotate(a) translateY(-R) → item 0 at top. So disc rotation = -selected*step.
    this.targetAngle = -this.selected * step;
    // choose shortest path
    const diff = ((this.targetAngle - this.angle + 540) % 360) - 180;
    this.targetAngle = this.angle + diff;
    if (!animate) this.angle = this.targetAngle;
    this.spinVel = 0;
  }

  _commit() {
    const ok = this.music.toggle(this.selected);
    this._updateSelectionUI();
    this._updateNowPlaying();
    this.onSelect?.(this.selected, ok);
  }

  _updateSelectionUI() {
    this.items.forEach((el, i) => {
      el.classList.toggle('is-selected', i === this.selected);
      el.classList.toggle('is-playing', i === this.music.index && this.music.playing);
    });
    // hint selected title in hub if nothing playing
    const t = this.music.tracks[this.selected];
    if (t && !this.music.playing) {
      document.getElementById('now-title').textContent = t.title;
      document.getElementById('now-artist').textContent = t.artist + ' — ENTER?';
    }
  }

  _updateNowPlaying() {
    const t = this.music.current;
    const titleEl = document.getElementById('now-title');
    const artistEl = document.getElementById('now-artist');
    const vinyl = document.getElementById('vinyl');
    if (t) {
      titleEl.textContent = t.title;
      artistEl.textContent = this.music.playing ? t.artist : `${t.artist} — ПАУЗА`;
    } else {
      titleEl.textContent = '— НЕТ ТРЕКОВ —';
      artistEl.textContent = 'клади mp3 в public/music/';
    }
    vinyl.classList.toggle('spinning', this.music.playing);
    vinyl.classList.toggle('stopped', !this.music.playing);
  }

  _loop = () => {
    if (!this.open) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this._lastTs) / 1000);
    this._lastTs = now;

    // spin physics
    if (Math.abs(this.spinVel) > 1) {
      this.angle += this.spinVel * dt;
      this.spinVel *= Math.exp(-3.2 * dt);
      // snap selection to nearest
      const n = this.music.tracks.length;
      if (n) {
        const step = 360 / n;
        const nearest = Math.round(-this.angle / step);
        const wrapped = ((nearest % n) + n) % n;
        if (wrapped !== this.selected) {
          this.selected = wrapped;
          this._updateSelectionUI();
        }
      }
    } else {
      this.spinVel = 0;
      // ease to target
      const diff = ((this.targetAngle - this.angle + 540) % 360) - 180;
      this.angle += diff * Math.min(1, dt * 12);
    }

    this.disc.style.transform = `rotate(${this.angle}deg)`;
    // counter-rotate items? items already un-rotate statically relative to disc —
    // text will rotate with disc. Fix: counter-rotate each item by -angle.
    const n = this.music.tracks.length;
    const step = 360 / Math.max(1, n);
    this.items.forEach((el, i) => {
      const a = i * step;
      const R = `calc(var(--wheel-r, 240px) * -1)`;
      el.style.transform =
        `rotate(${a}deg) translateY(${R}) rotate(${-a - this.angle}deg)`;
    });

    // spectrum in hub
    this._drawSpectrum();

    this._raf = requestAnimationFrame(this._loop);
  };

  _drawSpectrum() {
    const canvas = document.getElementById('spectrum');
    if (!canvas) return;
    const g = canvas.getContext('2d');
    const levels = this.music.spectrum(16);
    g.clearRect(0, 0, canvas.width, canvas.height);
    const bw = canvas.width / levels.length;
    levels.forEach((v, i) => {
      const h = v * canvas.height;
      g.fillStyle = i % 2 ? '#ff4df3' : '#4df3ff';
      g.fillRect(i * bw + 1, canvas.height - h, bw - 2, h);
    });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
