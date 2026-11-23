/**
 * VIBE DRIVER — main entry: PS1 render loop, camera, HUD, game states.
 */
import '@fontsource/press-start-2p';
import '@fontsource/vt323';
import './style.css';

import * as THREE from 'three';
import { PS1Renderer } from './render/ps1.js';
import { Keyboard } from './input/keyboard.js';
import { Track } from './game/track.js';
import { buildCar } from './game/carModel.js';
import { CarPhysics } from './game/carPhysics.js';
import { MusicPlayer } from './audio/music.js';
import { EngineSound } from './audio/engineSound.js';
import { RadioWheel } from './ui/radioWheel.js';

// ---------------- boot ----------------
const canvas = document.getElementById('game');

/** Friendly fatal screen instead of a white-page crash. */
function showFatal(msg) {
  const el = document.getElementById('fatal');
  if (el) {
    if (msg) el.querySelector('p').innerHTML = msg;
    el.classList.remove('hidden');
  }
  console.error(msg);
}

let ps1 = null;
try {
  ps1 = new PS1Renderer(canvas, { pixelHeight: 260 });
} catch (e) {
  showFatal('Браузер не смог запустить WebGL.<br>Попробуй другой браузер или включи аппаратное ускорение.');
  throw e; // nothing to render without WebGL — message already shown
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07060f);
scene.fog = new THREE.Fog(0x0b0820, 60, 340);

// near tuned for cockpit view: 0.1 so dash/wheel never clip; far 600 matches fog
const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.1, 600);
camera.position.set(0, 6.5, 16); // start above ground (never lerp up from y=0)

// lights — moonlit night
const hemi = new THREE.HemisphereLight(0x3a3a7a, 0x14101f, 1.15);
scene.add(hemi);
const moon = new THREE.DirectionalLight(0x8fa8ff, 1.4);
moon.position.set(-120, 180, -60);
scene.add(moon);
const neonFill = new THREE.DirectionalLight(0xff4df3, 0.35);
neonFill.position.set(80, 40, 120);
scene.add(neonFill);

// stars — sky layer that follows the camera position (world orientation kept),
// so they always sit inside camera.far and never pop while driving
const starField = new THREE.Group();
{
  const starGeo = new THREE.BufferGeometry();
  const n = 500;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 420 + Math.random() * 130;   // ≤550 → max dist from cam ≈585 < far 600
    const y = 40 + Math.random() * 160;
    arr[i * 3] = Math.cos(a) * r;
    arr[i * 3 + 1] = y;
    arr[i * 3 + 2] = Math.sin(a) * r;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
    color: 0xcdd8ff, size: 2.4, sizeAttenuation: false, fog: false,
  }));
  starField.add(stars);
  scene.add(starField);
}

// world
const track = new Track(scene, (m) => ps1.patch(m));
const car = buildCar((m) => ps1.patch(m));
scene.add(car.group);
ps1.patchTree(car.group);

const physics = new CarPhysics(track);
physics.spawn(6);

// ---------------- state ----------------
const keys = new Keyboard();
const music = new MusicPlayer();
const engine = new EngineSound();

let state = 'intro'; // intro | driving | paused
let radioOpen = false;

const wheel = new RadioWheel({
  disc: document.getElementById('wheel-disc'),
  music,
  onSelect: () => updateHudTrack(),
  onClose: () => { radioOpen = false; },
});

// ---------------- DOM refs ----------------
const $ = (id) => document.getElementById(id);
const dom = {
  hud: $('hud'), intro: $('intro'), pause: $('pause'),
  speed: $('speed-value'), lapCount: $('lap-count'),
  lapTime: $('lap-time'), bestTime: $('best-time'),
  hudTrack: $('hud-track'), hudEq: $('hud-eq'),
  minimap: $('minimap'), toast: $('toast'),
};

// EQ bars
const EQ_BARS = 10;
for (let i = 0; i < EQ_BARS; i++) dom.hudEq.appendChild(document.createElement('i'));
const eqEls = [...dom.hudEq.children];

// ---------------- helpers ----------------
function fmtTime(s) {
  if (s == null) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 100);
  return `${m}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

let toastTimer = null;
function toast(msg, ms = 3200) {
  dom.toast.textContent = msg;
  dom.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.add('hidden'), ms);
}

function updateHudTrack() {
  const t = music.current;
  dom.hudTrack.textContent = t
    ? `♪ ${t.artist} — ${t.title}${music.playing ? '' : ' (П)'}`
    : '♪ РАДИО ПУСТО — TAB';
}

// ---------------- minimap (static path once) ----------------
const mmCtx = dom.minimap.getContext('2d');
track.drawMinimapPath(mmCtx, dom.minimap.width, dom.minimap.height);

// ---------------- camera rig ----------------
// ONE camera, two modes — switching only changes cameraMode.
// NO allocations in the loop: all vectors below are declared once here
// and reused via .set()/.copy()/.add().
const CAM_CHASE = 'CHASE_VIEW';
const CAM_COCKPIT = 'COCKPIT_VIEW';

const camPos = new THREE.Vector3();
const camTarget = new THREE.Vector3();
const tmpFwd = new THREE.Vector3();
const tmpLocal = new THREE.Vector3();

// first-person state
let cameraMode = CAM_CHASE;

// reused physics input object (no per-frame allocation)
const inputState = { throttle: 0, steer: 0, handbrake: false };

function updateCamera(dt, introMode = false) {
  const fwd = physics.forwardVec(tmpFwd);
  const speed = Math.max(0, physics.speed);

  // horizon is FIXED — the camera never spins around its axis or tilts
  // under the ground, in any mode
  camera.up.set(0, 1, 0);

  if (introMode) {
    // slow orbit around car — steady
    const t = performance.now() * 0.00022;
    camPos.set(
      physics.pos.x + Math.cos(t) * 14,
      6.5,
      physics.pos.z + Math.sin(t) * 14
    );
    camera.position.lerp(camPos, 1 - Math.exp(-4 * dt));
    camera.lookAt(physics.pos.x, 1.2, physics.pos.z);
    return;
  }

  if (cameraMode === CAM_COCKPIT) {
    // ---- first-person: HARD-ATTACHED to the car, zero position smoothing ----
    // eye anchor: driver-left seat (local X=-0.3, Y=1.15, Z=0.1) — the
    // world position is copied instantly every frame, the camera never
    // lags, drifts or falls through the floor
    car.group.updateMatrixWorld(true);
    tmpLocal.set(-0.3, 1.15, 0.1);
    car.group.localToWorld(tmpLocal);
    camera.position.copy(tmpLocal);

    // look strictly forward through the windshield — a point far ahead
    // along the car's forward vector at eye/horizon height
    tmpLocal.set(-0.3, 1.15, 20);
    car.group.localToWorld(tmpLocal);
    camera.lookAt(tmpLocal);

    // FIXED field of view in the cockpit — no speed kick, no music pulse
    camera.fov = 72;
    camera.updateProjectionMatrix();
    return;
  }

  // ---- third-person (chase): RIGIDLY behind the car ----
  // camera sits exactly back 7.5 m / up 3.2 m along the car's forward
  // vector — no lerp, no distance scaling, no shake. It turns exactly
  // with the car, so there can be no fishtail.
  camPos.set(
    physics.pos.x - fwd.x * 7.5,
    physics.pos.y + 3.2,
    physics.pos.z - fwd.z * 7.5
  );
  camera.position.copy(camPos);

  // look at a point 5 m ahead of the car at 1.2 m height
  camTarget.set(
    physics.pos.x + fwd.x * 5,
    1.2,
    physics.pos.z + fwd.z * 5
  );
  camera.lookAt(camTarget);

  // speed FOV kick (gentle) — no music pulse on the camera
  const targetFov = 66 + Math.min(14, speed * 0.3);
  camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-4 * dt));
  camera.updateProjectionMatrix();
}

// ---------------- viewport / fullscreen ----------------
function onWindowResize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (width === 0 || height === 0) return; // guard: never resize to nothing

  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  // PS1Renderer.resize updates the canvas, the low-res render target
  // (height ~260px, width proportional) and the dither uniform
  if (ps1 && typeof ps1.resize === 'function') {
    ps1.resize(width, height);
  }
}
window.addEventListener('resize', onWindowResize);
document.addEventListener('fullscreenchange', onWindowResize);

// ---------------- input handling per frame ----------------
/** Start the game: unlock audio (user gesture), begin music, show HUD. */
async function startGame() {
  if (state !== 'intro') return;
  state = 'driving';
  dom.intro.classList.add('hidden');
  dom.hud.classList.remove('hidden');

  try {
    const mode = await music.startDefault();
    engine.unlock();
    if (mode === 'synth') {
      toast('📻 Играет встроенный SYNTHWAVE LOOP — свои треки: public/music/ → npm run scan-music', 6000);
    }
  } catch (e) {
    console.warn('audio start failed:', e);
  }
  updateHudTrack();
}

function handleGlobalKeys() {
  if (state === 'intro') {
    if (keys.wasPressed('Enter') || keys.wasPressed('NumpadEnter') || keys.wasPressed('Space')) {
      startGame();
    }
    return;
  }

  // camera mode toggle: CHASE_VIEW ↔ COCKPIT_VIEW (works anytime while playing)
  if (keys.wasPressed('KeyC') && state !== 'paused') {
    cameraMode = cameraMode === CAM_CHASE ? CAM_COCKPIT : CAM_CHASE;
    const inCockpit = cameraMode === CAM_COCKPIT;
    car.cockpit.visible = inCockpit;
    // windshield glass hidden in the cockpit view (road stays clear),
    // shown in chase view as a translucent windshield
    if (car.glass) car.glass.visible = !inCockpit;
    dom.hud.classList.toggle('cockpit', inCockpit);
    toast(inCockpit ? '🎥 Вид: САЛОН (C)' : '🎥 Вид: СПОЗАД (C)', 1600);
  }

  if (radioOpen) {
    wheel.handleInput(keys);
    if (keys.wasPressed('Tab') || keys.wasPressed('Escape')) {
      // wheel hides itself via handleInput too; guard double
    }
    return;
  }

  // pause
  if (keys.wasPressed('Escape')) {
    if (state === 'driving') {
      state = 'paused';
      dom.pause.classList.remove('hidden');
      music.pause();
      engine.cut();
    } else if (state === 'paused') {
      state = 'driving';
      dom.pause.classList.add('hidden');
      music.resume();
    }
  }

  if (state !== 'driving') return;

  // radio wheel
  if (keys.wasPressed('Tab')) {
    radioOpen = true;
    wheel.show();
    return;
  }

  // reset to track
  if (keys.wasPressed('KeyR')) {
    physics.spawn(physics.lastIndex);
    toast('Возврат на трассу');
  }

  // engine sound toggle
  if (keys.wasPressed('KeyM')) {
    const on = engine.toggle();
    toast(`Звук двигателя: ${on ? 'ВКЛ' : 'ВЫКЛ'}`, 1400);
  }

  // quick music controls
  if (keys.wasPressed('BracketRight')) { music.next(); updateHudTrack(); }
  if (keys.wasPressed('BracketLeft')) { music.prev(); updateHudTrack(); }
  if (keys.wasPressed('KeyP')) {
    music.playing ? music.pause() : music.resume();
    updateHudTrack();
  }
}

// ---------------- HUD update ----------------
let hudAccum = 0;
function updateHud(dt) {
  hudAccum += dt;
  // speed & times every frame cheap; eq throttled
  dom.speed.textContent = String(Math.round(Math.abs(physics.kmh)));
  dom.lapCount.textContent = String(physics.lap);
  dom.lapTime.textContent = fmtTime(physics.lapTime);
  dom.bestTime.textContent = fmtTime(physics.bestLap);

  if (hudAccum > 0.08) {
    hudAccum = 0;
    const levels = music.spectrum(EQ_BARS);
    eqEls.forEach((el, i) => {
      el.style.height = `${Math.round(levels[i] * 22)}px`;
    });

    // minimap car dot
    mmCtx.save();
    // we only drew path once; redraw path+dot cheaply (180px canvas)
    mmCtx.clearRect(0, 0, 180, 180);
    track.drawMinimapPath(mmCtx, 180, 180);
    const p = track.mapPoint(physics.pos.x, physics.pos.z);
    if (p) {
      mmCtx.fillStyle = '#ff2a4d';
      mmCtx.beginPath();
      mmCtx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      mmCtx.fill();
      // heading tick
      mmCtx.strokeStyle = '#fff';
      mmCtx.lineWidth = 2;
      mmCtx.beginPath();
      mmCtx.moveTo(p.x, p.y);
      mmCtx.lineTo(p.x + Math.sin(physics.heading) * 9, p.y + Math.cos(physics.heading) * 9);
      mmCtx.stroke();
    }
    mmCtx.restore();
  }
}

// ---------------- main loop ----------------
let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  handleGlobalKeys();

  const inRadio = radioOpen;
  const paused = state === 'paused' || state === 'intro';

  // physics — slows way down while radio open (chill, not stopped)
  if (state === 'driving') {
    const timeScale = inRadio ? 0.25 : 1.0;
    // REUSED input object — no per-frame allocation in the render loop
    inputState.throttle = inRadio ? 0 : keys.throttle;
    inputState.steer = inRadio ? 0 : -keys.steer; // A = left → steer -1... flip so A = left
    inputState.handbrake = inRadio ? true : keys.handbrake;
    physics.update(dt * timeScale, inputState);
  }

  // car visuals: heading + wheel spin/steer
  car.group.position.set(physics.pos.x, 0, physics.pos.z);
  car.group.rotation.y = physics.heading;

  // body pitch from longitudinal accel (visual only). NO body roll: the
  // car screws into turns cleanly — no rubbery sideways banking (the
  // physics model itself never tilts the body; the visual roll is zeroed).
  const pitch = THREE.MathUtils.clamp(physics.accelLong * 0.008, -0.07, 0.07);
  car.group.rotation.z = 0; // locked: no roll, monolithic chassis
  car.group.rotation.x += (pitch - car.group.rotation.x) * Math.min(1, dt * 8);

  // suspension bounce when wall hit
  const squash = physics.wallHit * 0.15;
  car.group.scale.y = 1 - squash;

  // wheels
  const wheelSpin = physics.speed * dt / 0.42;
  car.wheels.forEach((w) => {
    w.group.rotation.x += wheelSpin;
    if (w.front) w.group.rotation.y = -physics.steer * 1.1;
  });

  // steering wheel — physically rotates with A/D (first-person view),
  // angle = steerAngle * 2.5 around Z (wheel plane is XY)
  if (car.steeringWheelGroup) {
    car.steeringWheelGroup.rotation.z = physics.steer * 2.5;
  }

  // dash neon indicators — pulse with the music bass (first-person view only)
  if (car.dashLights && car.dashLights.length && car.cockpit.visible) {
    const b = music.bass();
    const boost = 0.45 + b * 1.9; // brightness multiplier
    car.dashLights.forEach(({ mat, base }) => {
      mat.color.setRGB(
        THREE.MathUtils.clamp(base.r * boost, 0, 1),
        THREE.MathUtils.clamp(base.g * boost, 0, 1),
        THREE.MathUtils.clamp(base.b * boost, 0, 1)
      );
    });
  }

  // spinning neon vinyl on the console: rotates while music plays,
  // neon center pulses with the bass (inside cockpit — visible in
  // first-person view only)
  if (car.vinylGroup && car.cockpit.visible && music.playing) {
    car.vinylGroup.rotation.z += dt * 1.8;
    const b = music.bass();
    const neon = car.vinylGroup.userData.neon;
    if (neon) {
      const pulse = 0.55 + b * 1.15;
      neon.material.color.setRGB(
        THREE.MathUtils.clamp(0.3 * pulse, 0, 1),
        THREE.MathUtils.clamp(0.95 * pulse, 0, 1),
        THREE.MathUtils.clamp(1.0 * pulse, 0, 1)
      );
    }
  }

  // underglow pulse with music
  if (car.glow) {
    const lvl = music.playing ? music.spectrum(4)[0] : 0.25;
    car.glow.material.opacity = 0.3 + lvl * 0.5;
  }

  // neon world reacts to bass: barriers/lamps pulse, buildings glow softer
  track.pulse(music.bass(), dt);

  // camera
  updateCamera(dt, state === 'intro' || (state === 'paused' && !inRadio));
  starField.position.copy(camera.position); // sky follows cam, world orientation kept

  // engine audio
  if (state === 'driving' && !paused) {
    engine.update(physics.gearRpm, Math.abs(keys.throttle) * (inRadio ? 0 : 1) + (inRadio ? 0 : 0.4));
  } else {
    engine.cut();
  }

  // HUD
  if (state !== 'intro') updateHud(dt);

  // render
  ps1.render(scene, camera);
  keys.endFrame();
}

// ---------------- drag & drop music ----------------
const dropOverlay = document.getElementById('drop-overlay');
let dropActive = false;

function isAudioFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('audio/')) return true;
  return /\.(mp3|ogg|oga|wav|m4a|flac|aac|opus)$/i.test(file.name || '');
}

function handleDroppedFiles(files) {
  let added = 0;
  let firstIndex = -1;
  for (const file of files) {
    if (!isAudioFile(file)) continue;
    const idx = music.addCustomTrack(file);
    if (firstIndex < 0) firstIndex = idx;
    added++;
  }
  if (!added) {
    toast('Не audio-файл — нужен mp3/ogg/wav/m4a', 2600);
    return;
  }
  // drop is a user gesture — unlock audio, then dynamic radio rebuild
  // + play the first dropped track instantly
  music.unlock();
  wheel.build();
  radioOpen = true;
  wheel.show();
  music.play(firstIndex);
  updateHudTrack();
  toast(`♪ Добавлено: ${music.tracks[firstIndex].title} — играет`, 4200);
}

function setupDragDrop() {
  // only react to file drags (ignore text/element drags inside the UI)
  const fileDrag = (e) =>
    Array.isArray(e.dataTransfer?.types) && e.dataTransfer.types.includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!fileDrag(e)) return;
    e.preventDefault();
    if (!dropActive) {
      dropActive = true;
      dropOverlay.classList.remove('hidden');
    }
  });

  window.addEventListener('dragover', (e) => {
    if (!fileDrag(e)) return;
    e.preventDefault(); // allow drop
    e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    if (!fileDrag(e)) return;
    // only hide when leaving the window entirely
    if (e.relatedTarget === null || !document.contains(e.relatedTarget)) {
      if (dropActive) {
        dropActive = false;
        dropOverlay.classList.add('hidden');
      }
    }
  });

  window.addEventListener('drop', (e) => {
    if (!fileDrag(e)) return;
    e.preventDefault();
    if (dropActive) {
      dropActive = false;
      dropOverlay.classList.add('hidden');
    }
    const files = e.dataTransfer?.files;
    if (files && files.length) handleDroppedFiles(files);
  });
}

// ---------------- init ----------------
(async function init() {
  try {
    await music.load();
  } catch (e) {
    console.warn('playlist load failed:', e);
  }
  try {
    wheel.build();
  } catch (e) {
    console.warn('radio wheel build failed:', e);
  }
  updateHudTrack();

  // Start button + any click on intro = user gesture → unlock audio
  const startBtn = document.getElementById('start-btn');
  startBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    startGame();
  });
  dom.intro.addEventListener('click', () => startGame());

  // drag & drop of music files onto the whole window
  setupDragDrop();

  // First gesture ANYWHERE on the page unlocks audio contexts (browser autoplay policy)
  const unlockOnce = () => {
    try { music.unlock(); } catch { /* ok */ }
    try { engine.unlock(); } catch { /* ok */ }
    window.removeEventListener('pointerdown', unlockOnce);
    window.removeEventListener('keydown', unlockOnce);
  };
  window.addEventListener('pointerdown', unlockOnce);
  window.addEventListener('keydown', unlockOnce);

  if (music.usedFallback) {
    toast('📻 Включен built-in Synthwave-плейлист — свои треки: public/music/ или перетащи в окно', 6000);
  }

  // expose for debugging
  window.__vibe = { music, physics, track, engine, wheel };

  requestAnimationFrame(frame);
})().catch((e) => {
  showFatal('Ошибка инициализации: ' + (e?.message || e));
  throw e;
});
