/**
 * Arcade driving physics — simple & stable (OutRun / Ridge Racer style).
 *
 * No tire formulas, no slip angles, no weight transfer — just:
 *  - speed scalar: speed += throttle * accel * dt, hard-capped at 180 km/h
 *  - steering: heading += steer * rate * dt, only while the car is moving
 *  - coast drag: smooth exponential deceleration when throttle is released
 *  - velocity alignment: world velocity smoothly follows the heading
 *    (grip lerp) → gentle arcade drift, handbrake lowers grip
 *  - walls: clamp position inside the track, kill outward velocity (no
 *    bounce), scrub speed, gentle inward assist
 *  - fail-safe: NaN / off-world → instant respawn, never diverges
 *
 * Units: meters, seconds, radians.
 */
import * as THREE from 'three';

// --- longitudinal ---
const MAX_SPEED = 50;              // m/s = 180 km/h (hard cap)
const MAX_REVERSE = 12;            // m/s
const ACCEL = 12;                  // m/s² (0-100 km/h ≈ 2.3 s)
const BRAKE = 22;                  // m/s²
const REVERSE_ACCEL = 8;           // m/s²
const COAST_DRAG = 0.6;            // 1/s exponential drag
const COAST_FRICTION = 1.5;        // m/s² rolling friction
const HANDBRAKE_DECEL = 16;        // m/s²

// --- steering ---
const MAX_STEER = 0.55;            // rad, wheel visual angle
const TURN_RATE = 1.9;             // rad/s at full lock, low speed
const STEER_SMOOTH = 10;           // 1/s input responsiveness
const MIN_SPEED_FOR_STEER = 4;     // m/s — no turning when nearly stopped
const TURN_TAPER = 0.35;           // turn-rate reduction at top speed

// --- grip (velocity alignment) ---
const GRIP = 7.0;                  // 1/s on road
const GRIP_HANDBRAKE = 2.0;        // 1/s — slides
const GRIP_OFFROAD = 4.5;          // 1/s — sloppier off road

// --- track limits ---
const OFFROAD_DRAG = 0.8;          // 1/s grass scrub
const WALL_SCRUB = 0.9;            // speed multiplier on impact
const WALL_INWARD = 2.5;           // m/s² gentle push back to road
const WALL_HIT_DECAY = 2.0;        // 1/s
const WALL_MARGIN = 1.1;           // m — car half-width inside wall limit

// --- fail-safe ---
const BOUND = 300;                 // |x|,|z| beyond this = fell off world
const FAR_FROM_TRACK = 80;         // m to centerline beyond this = respawn

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function finite(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

export class CarPhysics {
  constructor(track) {
    this.track = track;

    // --- state ---
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();    // world velocity used for integration
    this.heading = 0;                  // radians; forward = (sin h, cos h)
    this.speed = 0;                    // signed scalar (m/s), + = forward
    this.steer = 0;                    // current wheel angle (rad), + = right
    this.yawRate = 0;                  // rad/s (derived, bounded)
    this.onRoad = true;
    this.reversing = false;
    this.slipAmount = 0;               // 0..1 drift intensity (fx/audio)
    this.accelLong = 0;                // m/s² (visual pitch)
    this.accelLat = 0;                 // m/s² (visual roll)
    this.gearRpm = 0;                  // 0..1 (engine sound)
    this.wallHit = 0;                  // 0..1 impact flash (visual squash)

    // --- lap tracking ---
    this.lastIndex = 0;
    this.lapIndex = 0;
    this.lap = 0;
    this.passedHalf = false;
    this.lapTime = 0;
    this.bestLap = null;
    this.lastLapTime = 0;

    this._loadBest();
  }

  spawn(index = 4) {
    const N = this.track.samples.length;
    const i = ((Math.floor(finite(index, 0)) % N) + N) % N;
    const s = this.track.samples[i];

    this.pos.set(s.pos.x, 0, s.pos.z);
    this.vel.set(0, 0, 0);
    this.heading = Math.atan2(s.tan.x, s.tan.z);
    this.speed = 0;
    this.steer = 0;
    this.yawRate = 0;
    this.onRoad = true;
    this.reversing = false;
    this.slipAmount = 0;
    this.accelLong = 0;
    this.accelLat = 0;
    this.gearRpm = 0;
    this.wallHit = 0;

    this.lastIndex = i;
    this.lapIndex = i;
    this.lap = 1;
    this.passedHalf = false;
    this.lapTime = 0;
  }

  get kmh() {
    const v = Math.abs(finite(this.speed)) * 3.6;
    return Number.isFinite(v) ? v : 0;
  }

  forwardVec(out) {
    const h = finite(this.heading);
    out.set(Math.sin(h), 0, Math.cos(h));
    return out;
  }

  /**
   * @param {number} dt seconds
   * @param {{throttle:number, steer:number, handbrake:boolean}} input
   *   throttle: -1..1 (W/S), steer: -1..1 (A=-left, D=+right), handbrake: bool
   */
  update(dt, input) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    dt = Math.min(dt, 0.05); // clamp spiral of death

    // guard entry state (e.g. after external tampering)
    if (!this._stateOk()) { this._failSafe(); return; }

    input = input || {};
    const thr = Number.isFinite(input.throttle) ? clamp(input.throttle, -1, 1) : 0;
    const steerIn = Number.isFinite(input.steer) ? clamp(input.steer, -1, 1) : 0;
    const handbrake = !!input.handbrake;

    const prevSpeed = this.speed;

    // ---------- longitudinal: accel / brake / reverse / drag ----------
    if (thr > 0) {
      if (this.speed < -0.2) {
        this.speed = Math.min(0, this.speed + BRAKE * dt); // brake out of reverse
      } else {
        this.speed = Math.min(MAX_SPEED, this.speed + ACCEL * dt);
      }
      this.reversing = false;
    } else if (thr < 0) {
      if (this.speed > 0.2) {
        this.speed = Math.max(0, this.speed - BRAKE * dt);
        this.reversing = false;
      } else {
        this.speed = Math.max(-MAX_REVERSE, this.speed - REVERSE_ACCEL * dt);
        this.reversing = true;
      }
    } else {
      // coast: smooth exponential drag + rolling friction
      const dec = (COAST_DRAG * Math.abs(this.speed) + COAST_FRICTION) * dt;
      if (Math.abs(this.speed) <= dec) this.speed = 0;
      else this.speed -= Math.sign(this.speed) * dec;
      this.reversing = false;
    }

    if (handbrake) {
      const dec = HANDBRAKE_DECEL * dt;
      if (Math.abs(this.speed) <= dec) this.speed = 0;
      else this.speed -= Math.sign(this.speed) * dec;
    }

    // absolute safety cap — speed can never escape these bounds
    this.speed = clamp(finite(this.speed), -MAX_REVERSE, MAX_SPEED);

    // ---------- steering: only while moving ----------
    const targetSteer = steerIn * MAX_STEER;
    this.steer += (targetSteer - this.steer) * Math.min(1, STEER_SMOOTH * dt);
    if (Math.abs(this.steer) < 1e-4) this.steer = 0;

    const speedAbs = Math.abs(this.speed);
    const gate = Math.min(1, speedAbs / MIN_SPEED_FOR_STEER); // stopped → no turn
    const taper = 1 - TURN_TAPER * Math.min(1, speedAbs / MAX_SPEED);
    const hbTurn = handbrake ? 1.25 : 1; // handbrake turns a bit sharper
    const turn = (this.steer / MAX_STEER) * TURN_RATE * gate * taper * hbTurn;

    // +steer (D/right) must DECREASE heading: forward=(sin h,cos h);
    // car's right side is -X when facing +Z, so h↓ turns right.
    this.heading -= turn * dt;
    this.heading = Math.atan2(Math.sin(this.heading), Math.cos(this.heading));
    this.yawRate = -turn; // bounded: |yawRate| ≤ TURN_RATE * 1.25

    // ---------- grip: velocity smoothly follows heading ----------
    const fwdX = Math.sin(this.heading);
    const fwdZ = Math.cos(this.heading);
    const grip = handbrake ? GRIP_HANDBRAKE : (this.onRoad ? GRIP : GRIP_OFFROAD);
    const a = 1 - Math.exp(-grip * dt); // always in (0,1) — unconditionally stable
    this.vel.x += (fwdX * this.speed - this.vel.x) * a;
    this.vel.z += (fwdZ * this.speed - this.vel.z) * a;

    // ---------- integrate position ----------
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    // fail-safe before touching the track query with possibly-bad values
    if (!this._stateOk()) { this._failSafe(); return; }

    // ---------- track limits: walls + off-road ----------
    const q = this.track.query(this.pos.x, this.pos.z, this.lastIndex);
    if (!q || !Number.isFinite(q.offset) || !Number.isFinite(q.dist) ||
        q.dist > FAR_FROM_TRACK) {
      this._failSafe();
      return;
    }
    this.lastIndex = q.index;

    const offset = q.offset;
    const limit = this.track.wallLimit - WALL_MARGIN;
    const edge = this.track.halfWidth + 0.5;
    this.onRoad = Math.abs(offset) <= edge;

    // off-road: extra scrub (grass/gravel)
    if (!this.onRoad) {
      const m = Math.max(0, 1 - OFFROAD_DRAG * dt);
      this.speed *= m;
      this.vel.x *= m;
      this.vel.z *= m;
    }

    // wall: clamp inside, kill outward velocity (no bounce!), gentle return
    if (Math.abs(offset) > limit) {
      const s = q.sample;
      const sign = offset >= 0 ? 1 : -1;
      const nX = s.lat.x * sign; // outward normal
      const nZ = s.lat.z * sign;
      const over = Math.abs(offset) - limit;

      // push back onto the road
      this.pos.x -= nX * over;
      this.pos.z -= nZ * over;

      // remove ONLY the outward component — exact, never amplifies
      const outV = this.vel.x * nX + this.vel.z * nZ;
      if (outV > 0) {
        this.vel.x -= nX * outV;
        this.vel.z -= nZ * outV;
        this.wallHit = Math.min(1, this.wallHit + Math.min(1, outV * 0.12));
        this.speed *= WALL_SCRUB; // scrub forward speed on impact
      }

      // gentle inward assist → smooth return to the road
      this.vel.x -= nX * WALL_INWARD * dt;
      this.vel.z -= nZ * WALL_INWARD * dt;
    }
    this.wallHit = Math.max(0, this.wallHit - WALL_HIT_DECAY * dt);

    // ---------- derived values (visuals / audio) — all bounded ----------
    this.accelLong = clamp(finite((this.speed - prevSpeed) / dt), -40, 40);
    this.accelLat = clamp(finite(-this.yawRate * this.speed), -40, 40);

    const frac = Math.min(1, speedAbs / MAX_SPEED);
    this.gearRpm = thr !== 0
      ? 0.25 + 0.75 * ((frac * 3.5) % 1) // faux gearbox rev pattern
      : 0.12 + 0.15 * frac;
    this.gearRpm = clamp(this.gearRpm, 0, 1);

    const slipTarget = Math.min(1,
      (Math.abs(turn) / TURN_RATE) * frac * 1.5 +
      (handbrake && speedAbs > 3 ? 0.6 : 0)
    );
    this.slipAmount += (slipTarget - this.slipAmount) * Math.min(1, dt * 6);
    this.slipAmount = clamp(finite(this.slipAmount), 0, 1);

    // ---------- lap logic ----------
    this._updateLap(dt);
  }

  /** True if every simulated value is finite and within sane bounds. */
  _stateOk() {
    return Number.isFinite(this.pos.x) && Number.isFinite(this.pos.z) &&
      Number.isFinite(this.speed) && Number.isFinite(this.heading) &&
      Number.isFinite(this.steer) &&
      Number.isFinite(this.vel.x) && Number.isFinite(this.vel.z) &&
      Math.abs(this.pos.x) < BOUND && Math.abs(this.pos.z) < BOUND &&
      Math.abs(this.speed) <= MAX_SPEED * 1.5;
  }

  /**
   * Instant respawn on track. Preserves lap progress so a glitch
   * never nukes the current race.
   */
  _failSafe() {
    const lap = this.lap;
    const lapTime = this.lapTime;
    const passedHalf = this.passedHalf;
    const lapIndex = this.lapIndex;
    const lastLapTime = this.lastLapTime;

    this.spawn(Number.isFinite(this.lastIndex) ? this.lastIndex : 0);

    this.lap = lap;
    this.lapTime = lapTime;
    this.passedHalf = passedHalf;
    this.lapIndex = lapIndex;
    this.lastLapTime = lastLapTime;

    console.warn('CarPhysics fail-safe: respawned on track');
  }

  _updateLap(dt) {
    this.lapTime += dt;
    const N = this.track.N;
    const idx = this.lastIndex;
    const prev = this.lapIndex;

    // crossed halfway
    if (prev < N * 0.5 && idx >= N * 0.5) this.passedHalf = true;

    // crossed start/finish (index wraps N→0)
    if (prev > N * 0.85 && idx < N * 0.15) {
      if (this.passedHalf) {
        this.lastLapTime = this.lapTime;
        if (this.bestLap === null || this.lapTime < this.bestLap) {
          this.bestLap = this.lapTime;
          this._saveBest();
        }
        this.lap += 1;
        this.passedHalf = false;
        this.lapTime = 0;
      }
    }
    // going backwards over line
    if (prev < N * 0.15 && idx > N * 0.85) {
      this.passedHalf = false;
    }
    this.lapIndex = idx;
  }

  _saveBest() {
    try { localStorage.setItem('vibe_best_lap', String(this.bestLap)); } catch { /* ok */ }
  }

  _loadBest() {
    try {
      const v = localStorage.getItem('vibe_best_lap');
      if (v) {
        const n = parseFloat(v);
        if (Number.isFinite(n) && n > 0) this.bestLap = n;
      }
    } catch { /* ok */ }
  }
}
