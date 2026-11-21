/**
 * Car physics — arcade-sim hybrid ("bicycle model" with slip angles):
 *  - engine power curve, drag, rolling resistance, braking, reverse
 *  - tire lateral slip with saturation → natural drift when grip exceeded
 *  - weight transfer affects grip (longitudinal + lateral)
 *  - handbrake cuts rear grip for slides
 *  - wall collision against track limits
 * Units: meters, seconds, radians.
 */
import * as THREE from 'three';

const GRAVITY = 9.81;

export class CarPhysics {
  constructor(track) {
    this.track = track;

    // --- tune params ---
    this.mass = 1350;            // kg
    this.inertia = 2200;         // yaw inertia
    this.wheelBase = 2.9;
    this.lf = 1.45;              // CG → front axle
    this.lr = 1.45;              // CG → rear axle
    this.cgHeight = 0.52;
    this.wheelTrack = 1.7;

    this.maxEngineForce = 11500; // N at full throttle (low speed)
    this.topSpeed = 62;          // m/s ≈ 223 km/h
    this.brakeForce = 15000;
    this.reverseForce = 4500;
    this.maxReverseSpeed = 12;

    this.tireGrip = 2.6;         // μ peak
    this.tireStiffness = 14.0;   // slip curve steepness
    this.handbrakeGripMul = 0.38;

    this.maxSteer = 0.62;        // rad
    this.steerSpeed = 7.0;
    this.steerReturn = 9.0;

    this.dragCoef = 0.42;        // ½ρCdA
    this.rollResist = 22;        // N

    // --- state ---
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();  // world-space, y unused
    this.heading = 0;                 // radians, atan2(fwd.x, fwd.z)
    this.yawRate = 0;
    this.steer = 0;                   // current steer angle
    this.onRoad = true;
    this.slipAmount = 0;              // 0..1 for fx/audio
    this.speedLong = 0;               // forward velocity (body frame)
    this.speedLat = 0;
    this.accelLong = 0;
    this.accelLat = 0;
    this.gearRpm = 0;
    this.reversing = false;

    // collision flash
    this.wallHit = 0;

    // lap tracking
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
    const s = this.track.samples[index];
    this.pos.set(s.pos.x, 0, s.pos.z);
    this.vel.set(0, 0, 0);
    this.heading = Math.atan2(s.tan.x, s.tan.z);
    this.yawRate = 0;
    this.steer = 0;
    this.lastIndex = index;
    this.lapIndex = index;
    this.lap = 1;
    this.passedHalf = false;
    this.lapTime = 0;
    this.slipAmount = 0;
    this.speedLong = 0;
    this.speedLat = 0;
  }

  get speed() { return Math.hypot(this.vel.x, this.vel.z); }
  get kmh() { return this.speed * 3.6; }

  forwardVec(out) {
    out.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    return out;
  }

  /**
   * @param {number} dt
   * @param {{throttle:number, steer:number, handbrake:boolean}} input
   *   steer: -1 = left (A), +1 = right (D)
   */
  update(dt, input) {
    if (dt <= 0) return;
    dt = Math.min(dt, 0.05); // clamp spiral of death

    const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x); // rotate -90° about Y... check: fwd×up?
    // right side of car: for fwd=(0,0,1), right should be (-1,0,0)? No — right of +Z facing is -X? Let's derive:
    // three.js: looking down -Y (top view), +X right, +Z down-screen. Facing +Z (down-screen), right hand → -X? If I face +Z, my right is -X? Facing +Z with top view: right = cross(fwd, up)? cross((0,0,1),(0,1,0)) = (0*0-1*1, 1*0-0*0, 0*1-0*0) = (-1,0,0). Yes right = cross(fwd, up).
    right.crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();

    // body-frame velocities
    let vLong = this.vel.x * fwd.x + this.vel.z * fwd.z;
    let vLat = this.vel.x * right.x + this.vel.z * right.z;

    const speed = Math.hypot(vLong, vLat);

    // --- steering input (speed-sensitive) ---
    const steerTarget = input.steer * this.maxSteer / (1 + speed * 0.035);
    const rate = Math.abs(steerTarget) > Math.abs(this.steer) ? this.steerSpeed : this.steerReturn;
    this.steer += (steerTarget - this.steer) * Math.min(1, rate * dt);

    // --- throttle / brake / reverse ---
    let throttle = input.throttle;
    let brake = 0;
    if (throttle > 0 && vLong < -0.5) { brake = 1; throttle = 0; } // braking while reversing
    if (throttle < 0) {
      if (vLong > 0.5) { brake = 1; throttle = 0; }
      else { throttle = -1; } // reverse
    }
    this.reversing = throttle < 0;

    // engine force with power falloff
    let engineF = 0;
    if (throttle > 0) {
      const t = Math.max(0, 1 - Math.max(0, vLong) / this.topSpeed);
      engineF = this.maxEngineForce * throttle * (0.35 + 0.65 * t);
    } else if (throttle < 0) {
      const t = Math.max(0, 1 - Math.max(0, -vLong) / this.maxReverseSpeed);
      engineF = this.reverseForce * t;
    }

    // rpm proxy for engine sound / HUD
    const speedFrac = Math.min(1, Math.abs(vLong) / this.topSpeed);
    this.gearRpm = throttle !== 0
      ? 0.25 + 0.75 * ((speedFrac * 3.2) % 1)
      : 0.12 + 0.1 * speedFrac;

    // --- weight transfer (based on previous frame accel) ---
    const staticF = this.mass * GRAVITY * this.lr / (this.lf + this.lr);
    const staticR = this.mass * GRAVITY * this.lf / (this.lf + this.lr);
    const transferL = this.mass * this.accelLong * this.cgHeight / (this.lf + this.lr);
    const loadF = Math.max(200, staticF - transferL);
    const loadR = Math.max(200, staticR + transferL);

    // --- tire slip angles ---
    const eps = 0.8;
    const absVLong = Math.abs(vLong) < eps ? (vLong >= 0 ? eps : -eps) : vLong;
    const slipFront = Math.atan2(vLat + this.yawRate * this.lf, Math.abs(absVLong)) - this.steer;
    const slipRear = Math.atan2(vLat - this.yawRate * this.lr, Math.abs(absVLong));

    // lateral grip per axle
    const gripMul = input.handbrake ? this.handbrakeGripMul : 1;
    const latF = this._tireForce(slipFront, loadF, this.tireGrip);
    const latR = this._tireForce(slipRear, loadR, this.tireGrip * gripMul);

    // combined slip: reduce lateral when braking/accel hard (friction circle)
    const availF = this.tireGrip * loadF;
    const availR = this.tireGrip * loadR * gripMul;
    const longShareF = brake > 0 ? Math.min(1, (this.brakeForce * 0.6) / Math.max(1, availF)) : 0;
    const longShareR = brake > 0 ? Math.min(1, (this.brakeForce * 0.4) / Math.max(1, availR)) : 0;
    const latScaleF = Math.sqrt(Math.max(0.05, 1 - longShareF * longShareF));
    const latScaleR = Math.sqrt(Math.max(0.05, 1 - longShareR * longShareR));

    const FyF = latF * latScaleF;
    const FyR = latR * latScaleR;

    // --- longitudinal forces ---
    let Fx = engineF;
    if (brake > 0) {
      const dir = vLong > 0.3 ? -1 : vLong < -0.3 ? 1 : 0;
      if (dir !== 0) Fx += dir * this.brakeForce;
      else Fx += (throttle >= 0 ? -1 : 1) * this.reverseForce; // locked stop
    }
    // drag + rolling
    Fx -= this.dragCoef * vLong * Math.abs(vLong);
    Fx -= this.rollResist * Math.tanh(vLong * 2);
    if (input.handbrake) Fx -= Math.sign(vLong) * 6000 * Math.min(1, speed / 5);

    // --- body-frame accel ---
    // include yaw coupling
    let aLong = (Fx + FyF * Math.sin(this.steer)) / this.mass + this.yawRate * vLat;
    let aLat = (FyF * Math.cos(this.steer) + FyR) / this.mass - this.yawRate * vLong;

    // yaw moment
    const yawAccel = (this.lf * FyF * Math.cos(this.steer) - this.lr * FyR) / this.inertia;
    this.yawRate += yawAccel * dt;
    this.yawRate *= Math.exp(-1.2 * dt); // self-align damping at low speed

    // integrate body velocities
    vLong += aLong * dt;
    vLat += aLat * dt;

    // grip limit sanity: don't let lateral exceed friction
    const maxLat = this.tireGrip * GRAVITY * 1.6;
    if (Math.abs(vLat) > maxLat * 2) vLat = Math.sign(vLat) * maxLat * 2;

    // --- convert back to world ---
    const newVLong = vLong;
    const newVLat = vLat;
    this.vel.x = fwd.x * newVLong + right.x * newVLat;
    this.vel.z = fwd.z * newVLong + right.z * newVLat;

    this.heading += this.yawRate * dt;

    // world accel for next-frame weight transfer
    const prevVx = this.vel.x - aLong * fwd.x * dt; // rough; simpler: store
    this.accelLong = (newVLong - this.speedLong) / dt;
    this.accelLat = (newVLat - this.speedLat) / dt;
    this.speedLong = newVLong;
    this.speedLat = newVLat;

    // --- integrate position ---
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    // --- track limits ---
    this._resolveTrack();

    // slip amount (drift intensity) 0..1
    const slipNorm = Math.min(1, Math.abs(slipRear) / 0.45);
    const lateralNorm = Math.min(1, Math.abs(vLat) / 8);
    this.slipAmount += (Math.max(slipNorm, lateralNorm * 0.8) - this.slipAmount) * Math.min(1, dt * 8);

    // --- lap logic ---
    this._updateLap(dt);
  }

  _tireForce(slipAngle, load, grip) {
    // saturating tire curve: F = μ·Fz·sin(C·atan(B·α)) style
    const Fz = load;
    const raw = grip * Fz * Math.sin(
      Math.atan(slipAngle * this.tireStiffness)
    );
    return raw;
  }

  _resolveTrack() {
    const q = this.track.query(this.pos.x, this.pos.z, this.lastIndex);
    this.lastIndex = q.index;
    const offset = q.offset;
    const limit = this.track.wallLimit - 1.1; // car half-width margin

    this.onRoad = Math.abs(offset) <= this.track.halfWidth + 0.5;

    // grip penalty off-road
    if (!this.onRoad) {
      // extra rolling resistance applied next frame via velocity scrub
      this.vel.multiplyScalar(0.985);
    }

    if (Math.abs(offset) > limit) {
      // push back in
      const s = q.sample;
      const over = Math.abs(offset) - limit;
      const sign = Math.sign(offset);
      this.pos.x -= s.lat.x * sign * over;
      this.pos.z -= s.lat.z * sign * over;

      // kill outward velocity + bounce
      const outV = this.vel.x * s.lat.x * sign + this.vel.z * s.lat.z * sign;
      if (outV > 0) {
        this.vel.x -= s.lat.x * sign * outV * 1.35;
        this.vel.z -= s.lat.z * sign * outV * 1.35;
        // scrub some speed
        this.vel.multiplyScalar(0.86);
        this.wallHit = Math.min(1, this.wallHit + Math.abs(outV) * 0.15);
        this.yawRate += (Math.random() - 0.5) * 0.6;
      }
    }
    this.wallHit = Math.max(0, this.wallHit - 0.03);
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
      if (v) this.bestLap = parseFloat(v);
    } catch { /* ok */ }
  }
}
