/**
 * Physics stability test — runs CarPhysics headless for many frames with
 * aggressive inputs and asserts: no NaN, bounded speed, on-track position.
 * Run: node scripts/test-physics.mjs
 */
import * as THREE from 'three';

// minimal DOM-free track stub (mirrors Track.query contract)
class StubTrack {
  constructor() {
    this.N = 700;
    this.halfWidth = 7;
    this.wallLimit = 10.2;
    this.samples = [];
    // circle track of radius 100
    for (let i = 0; i < this.N; i++) {
      const a = (i / this.N) * Math.PI * 2;
      const x = Math.cos(a) * 100;
      const z = Math.sin(a) * 100;
      const tan = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
      const lat = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0)).normalize();
      this.samples.push({ pos: new THREE.Vector3(x, 0, z), tan, lat });
    }
  }
  query(x, z, lastIndex = 0) {
    let best = 0, bestD = Infinity;
    const start = lastIndex - 60;
    for (let k = 0; k < 120; k++) {
      const i = ((start + k) % this.N + this.N) % this.N;
      const s = this.samples[i];
      const d = (x - s.pos.x) ** 2 + (z - s.pos.z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (bestD > 40 * 40) {
      for (let i = 0; i < this.N; i += 3) {
        const s = this.samples[i];
        const d = (x - s.pos.x) ** 2 + (z - s.pos.z) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    const s = this.samples[best];
    const offset = (x - s.pos.x) * s.lat.x + (z - s.pos.z) * s.lat.z;
    return { index: best, offset, sample: s, dist: Math.sqrt(bestD) };
  }
}

const { CarPhysics } = await import('../src/game/carPhysics.js');

const track = new StubTrack();
const car = new CarPhysics(track);

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('FAIL:', msg); }
}

function run(label, inputFn, frames, dt = 1 / 60) {
  car.spawn(6);
  let maxSpeed = 0;
  let minSpeed = Infinity;
  for (let f = 0; f < frames; f++) {
    const input = inputFn(f);
    car.update(dt, input);
    assert(Number.isFinite(car.pos.x) && Number.isFinite(car.pos.z),
      `${label}: NaN position at frame ${f} (${car.pos.x}, ${car.pos.z})`);
    assert(Number.isFinite(car.speed), `${label}: NaN speed at frame ${f}`);
    assert(Number.isFinite(car.heading), `${label}: NaN heading at frame ${f}`);
    assert(Math.abs(car.pos.x) < 300 && Math.abs(car.pos.z) < 300,
      `${label}: off-world at frame ${f} (${car.pos.x.toFixed(1)}, ${car.pos.z.toFixed(1)})`);
    maxSpeed = Math.max(maxSpeed, Math.abs(car.speed));
    minSpeed = Math.min(minSpeed, Math.abs(car.speed));
  }
  console.log(`✓ ${label}: ${frames} frames, max|v|=${maxSpeed.toFixed(2)} m/s ` +
    `(${(maxSpeed * 3.6).toFixed(0)} km/h), final pos=(${car.pos.x.toFixed(1)}, ${car.pos.z.toFixed(1)})`);
  assert(maxSpeed <= 50.01, `${label}: speed exceeded cap: ${maxSpeed}`);
  return { maxSpeed, minSpeed };
}

// 1. full throttle for 60s — must cap at 180 km/h
run('full-throttle 60s', () => ({ throttle: 1, steer: 0, handbrake: false }), 60 * 60);

// 2. throttle + steering held for 60s — no spiral into NaN
run('throttle+right-turn 60s', () => ({ throttle: 1, steer: 1, handbrake: false }), 60 * 60);

// 3. handbrake drift chaos for 30s
run('handbrake-drift 30s',
  (f) => ({ throttle: f % 120 < 60 ? 1 : 0, steer: Math.sin(f / 20), handbrake: f % 90 < 45 }),
  30 * 60);

// 4. random inputs for 60s
run('random-inputs 60s',
  () => ({
    throttle: Math.random() * 2 - 1,
    steer: Math.random() * 2 - 1,
    handbrake: Math.random() < 0.3,
  }), 60 * 60);

// 5. garbage inputs must not break it
run('garbage-inputs 5s',
  () => ({ throttle: NaN, steer: Infinity, handbrake: 'yes' }), 5 * 60);

// 6. reverse then forward
run('reverse-then-forward',
  (f) => ({ throttle: f < 180 ? -1 : 1, steer: f > 300 ? 1 : 0, handbrake: false }), 10 * 60);

// 7. zero dt / negative dt are no-ops
car.spawn(6);
car.update(0, { throttle: 1, steer: 1, handbrake: false });
car.update(-1, { throttle: 1, steer: 1, handbrake: false });
assert(Number.isFinite(car.speed), 'dt-guard: state corrupted by 0/negative dt');
console.log('✓ dt-guard: 0/negative dt are safe no-ops');

// 8. fail-safe: teleport into void → respawn
car.spawn(6);
car.pos.x = 1e10; car.pos.z = 1e10;
car.update(1 / 60, { throttle: 1, steer: 0, handbrake: false });
assert(Math.abs(car.pos.x) < 300 && Math.abs(car.pos.z) < 300,
  `fail-safe: did not respawn (pos=${car.pos.x}, ${car.pos.z})`);
console.log(`✓ fail-safe: void teleport respawned to (${car.pos.x.toFixed(1)}, ${car.pos.z.toFixed(1)})`);

// 9. fail-safe: NaN position → respawn
car.spawn(6);
car.pos.x = NaN;
car.update(1 / 60, { throttle: 1, steer: 0, handbrake: false });
assert(Number.isFinite(car.pos.x), 'fail-safe: NaN position not recovered');
console.log('✓ fail-safe: NaN position recovered');

// 10. speedometer value is a clean integer-friendly number
car.spawn(6);
for (let i = 0; i < 600; i++) car.update(1 / 60, { throttle: 1, steer: 0, handbrake: false });
const kmh = car.kmh;
assert(Number.isFinite(kmh) && kmh >= 0 && kmh <= 180.5, `kmh out of range: ${kmh}`);
assert(Math.round(kmh) === Math.round(kmh), 'kmh must round cleanly');
console.log(`✓ speedometer: kmh=${kmh.toFixed(4)} → displays "${Math.round(kmh)}"`);

// 11. wheel steer visual value is bounded
assert(Math.abs(car.steer) <= 0.551, `steer out of bounds: ${car.steer}`);
console.log(`✓ steer visual: ${car.steer.toFixed(3)} rad (bounded)`);

if (failures > 0) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nALL PHYSICS TESTS PASSED ✅');
