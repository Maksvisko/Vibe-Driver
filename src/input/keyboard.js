/**
 * Keyboard input: simple edge-tracked key state.
 */
export class Keyboard {
  constructor() {
    this.down = new Set();
    this.pressed = new Set(); // edge: pressed this frame

    this._onDown = (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressed.add(e.code);
      // prevent page scroll / focus steal
      if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    };
    this._onUp = (e) => this.down.delete(e.code);
    this._onBlur = () => this.down.clear();

    window.addEventListener('keydown', this._onDown);
    window.addEventListener('keyup', this._onUp);
    window.addEventListener('blur', this._onBlur);
  }

  isDown(code) {
    return this.down.has(code);
  }

  wasPressed(code) {
    return this.pressed.has(code);
  }

  /** call at end of each frame */
  endFrame() {
    this.pressed.clear();
  }

  get throttle() {
    return (this.isDown('KeyW') || this.isDown('ArrowUp') ? 1 : 0) -
           (this.isDown('KeyS') || this.isDown('ArrowDown') ? 1 : 0);
  }

  get steer() {
    return (this.isDown('KeyA') || this.isDown('ArrowLeft') ? 1 : 0) -
           (this.isDown('KeyD') || this.isDown('ArrowRight') ? 1 : 0);
  }

  get handbrake() {
    return this.isDown('Space');
  }
}
