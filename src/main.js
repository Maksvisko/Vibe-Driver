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

// near/far tuned: 0.5 avoids clipping the car/road, 600 matches fog — no cut geometry
const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.5, 600);
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
const camPos = new THREE.Vector3();
const camTarget = new THREE.Vector3();
const tmpFwd = new THREE.Vector3();

function updateCamera(dt, introMode = false) {
  const fwd = physics.forwardVec(tmpFwd);
  const speed = Math.max(0, physics.speed); // reverse shouldn't shrink distance

  if (introMode) {
    // slow orbit around car
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

  // chase cam — sits high & far enough to never sink into asphalt/barriers
  const back = 7.5 + speed * 0.07;
  const height = 3.8 + speed * 0.015;
  camPos.set(
    physics.pos.x - fwd.x * back,
    height,
    physics.pos.z - fwd.z * back
  );
  // aim down at the road ahead of the car (never at the sky/underground)
  camTarget.set(
    physics.pos.x + fwd.x * 5.5,
    0.8,
    physics.pos.z + fwd.z * 5.5
  );

  const stiff = 1 - Math.exp(-14 * dt); // was 6.5 — much snappier
  camera.position.lerp(camPos, stiff);
  if (camera.position.y < 1.6) camera.position.y = 1.6; // hard floor: never under the road
  camera.lookAt(camTarget);

  // speed FOV kick (gentler)
  const targetFov = 66 + Math.min(14, speed * 0.3);
  camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-4 * dt));
  camera.updateProjectionMatrix();
}

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
    let input;
    if (inRadio) {
      input = { throttle: 0, steer: 0, handbrake: true };
    } else {
      input = {
        throttle: keys.throttle,
        steer: -keys.steer, // A = left → steer -1? keys.steer: A→+1... flip so A = left
        handbrake: keys.handbrake,
      };
      // keys.steer: A → 1? check keyboard: steer = A(1) - D(1)... A pressed → 1, D → -1
      // physics expects: -1 = left, +1 = right → pass -keys.steer
    }
    physics.update(dt * timeScale, input);
  }

  // car visuals: heading + wheel spin/steer
  car.group.position.set(physics.pos.x, 0, physics.pos.z);
  car.group.rotation.y = physics.heading;

  // body roll & pitch from lateral/long accel (visual only)
  const roll = THREE.MathUtils.clamp(-physics.accelLat * 0.012, -0.09, 0.09);
  const pitch = THREE.MathUtils.clamp(physics.accelLong * 0.008, -0.07, 0.07);
  car.group.rotation.z += (roll - car.group.rotation.z) * Math.min(1, dt * 8);
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

  // underglow pulse with music
  if (car.glow) {
    const lvl = music.playing ? music.spectrum(4)[0] : 0.25;
    car.glow.material.opacity = 0.3 + lvl * 0.5;
  }

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

  // First gesture ANYWHERE on the page unlocks audio contexts (browser autoplay policy)
  const unlockOnce = () => {
    try { music.unlock(); } catch { /* ok */ }
    try { engine.unlock(); } catch { /* ok */ }
    window.removeEventListener('pointerdown', unlockOnce);
    window.removeEventListener('keydown', unlockOnce);
  };
  window.addEventListener('pointerdown', unlockOnce);
  window.addEventListener('keydown', unlockOnce);

  if (music.tracks.length === 0) {
    toast('📻 Свои треки: public/music/ → npm run scan-music. Пока играет встроенный synthwave', 6000);
  }

  // expose for debugging
  window.__vibe = { music, physics, track, engine, wheel };

  requestAnimationFrame(frame);
})().catch((e) => {
  showFatal('Ошибка инициализации: ' + (e?.message || e));
  throw e;
});
