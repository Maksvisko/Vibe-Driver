/**
 * Simple dark low-poly car — PS1 vibe, no fancy textures.
 * Model faces +Z at rotation.y = 0.
 */
import * as THREE from 'three';

export function buildCar(patch) {
  const p = patch || ((m) => m);
  const car = new THREE.Group();

  // NOTE: every car material is DoubleSide — polygons must never vanish
  // from a different viewing angle (chase cam sees the car from behind,
  // cockpit cam from inside).
  // Body: pearl-white / light metallic with a subtle gloss — roughness
  // 0.35 / metalness 0.2 gives clear facet highlights and shadows from
  // the street lamps and neon (NFS1 / OutRun look), never a black blob.
  const bodyMat = p(new THREE.MeshStandardMaterial({
    color: 0xe8ecf4, roughness: 0.35, metalness: 0.2, side: THREE.DoubleSide,
  }));
  const darkMat = p(new THREE.MeshStandardMaterial({
    color: 0x1b1b28, roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide,
  }));
  // translucent glass so the cockpit view isn't blocked by the cabin face
  // (hidden entirely in cockpit view — see main.js camera toggle)
  const glassMat = p(new THREE.MeshLambertMaterial({
    color: 0x1a2438, emissive: 0x0a1526, transparent: true, opacity: 0.5,
    side: THREE.DoubleSide,
  }));
  const headMat = p(new THREE.MeshBasicMaterial({ color: 0xfff6c8, side: THREE.DoubleSide }));
  const tailMat = p(new THREE.MeshBasicMaterial({ color: 0xff2a4d, side: THREE.DoubleSide }));
  const underMat = p(new THREE.MeshBasicMaterial({ color: 0xff4df3, side: THREE.DoubleSide }));

  // chassis (wide, low)
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.55, 4.2), bodyMat);
  body.position.y = 0.55;
  car.add(body);

  // neon side accent — thin turquoise strip running along both boards
  // (NFS / Miami Vice style neon accent)
  const sideStripMat = p(new THREE.MeshBasicMaterial({ color: 0x4df3ff, side: THREE.DoubleSide }));
  for (const sx of [-0.94, 0.94]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 3.9), sideStripMat);
    strip.position.set(sx, 0.52, 0.1);
    car.add(strip);
  }

  // hood taper
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.34, 0.9), bodyMat);
  nose.position.set(0, 0.42, 2.35);
  car.add(nose);

  // neon hood strip — thin turquoise line along the front edge of the hood
  const hoodStrip = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.05, 0.08), sideStripMat);
  hoodStrip.position.set(0, 0.58, 2.62);
  car.add(hoodStrip);

  // cabin (windshield glass — hidden in cockpit view so the road stays
  // clear; shown in chase view as a translucent windshield)
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 1.9), glassMat);
  cabin.position.set(0, 1.05, -0.25);
  car.add(cabin);
  const glass = cabin; // exposed for the camera-mode toggle in main.js

  // roof
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.54, 0.12, 1.94), darkMat);
  roof.position.set(0, 1.33, -0.25);
  car.add(roof);

  // spoiler
  const spoilerWing = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.1, 0.5), darkMat);
  spoilerWing.position.set(0, 1.15, -2.15);
  car.add(spoilerWing);
  for (const sx of [-0.7, 0.7]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.35, 0.1), darkMat);
    post.position.set(sx, 0.95, -2.1);
    car.add(post);
  }

  // headlights — meshes (emissive toggled by F) + two warm-white
  // spotlights that illuminate the road and barriers ahead
  const headLights = [];
  const headTarget = new THREE.Object3D(); // shared spotlight target
  headTarget.position.set(0, 0.4, 5); // aimed forward, down slightly
  car.add(headTarget);
  for (const sx of [-0.6, 0.6]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.18, 0.1), headMat);
    h.position.set(sx, 0.52, 2.81);
    car.add(h);

    const spot = new THREE.SpotLight(0xfff8e7, 0, 80, 0.65, 0.5, 2);
    spot.position.set(sx, 0.52, 2.81);
    spot.target = headTarget;
    car.add(spot);
    headLights.push(spot);
  }
  // headlights start OFF — toggled with F (see main.js)
  // taillights (full-width strip — very PS1)
  const tail = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.14, 0.08), tailMat);
  tail.position.set(0, 0.7, -2.13);
  car.add(tail);

  // underglow
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 4.4), underMat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.06;
  glow.material.transparent = true;
  glow.material.opacity = 0.5;
  car.add(glow);

  // wheels
  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.34, 10);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheelMat = p(new THREE.MeshLambertMaterial({ color: 0x14141c, side: THREE.DoubleSide }));
  // silver / chrome rims — wheel rotation reads clearly in motion
  const rimMat = p(new THREE.MeshStandardMaterial({
    color: 0xcccccc, roughness: 0.3, metalness: 0.85, side: THREE.DoubleSide,
  }));

  const wheels = [];
  const wheelPos = [
    [-0.95, 0.42, 1.45], [0.95, 0.42, 1.45],
    [-0.95, 0.42, -1.45], [0.95, 0.42, -1.45],
  ];
  wheelPos.forEach(([x, y, z], i) => {
    const w = new THREE.Group();
    const tire = new THREE.Mesh(wheelGeo, wheelMat);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.36, 8), rimMat);
    rim.rotation.z = Math.PI / 2;
    w.add(tire, rim);
    w.position.set(x, y, z);
    car.add(w);
    wheels.push({ group: w, front: i < 2 });
  });

  // ---------- cockpit interior (first-person view) ----------
  const cockpit = new THREE.Group();
  // dash: light gray so the torpedo reads as a distinct surface, clearly
  // separated from the dark road below
  const dashMat = p(new THREE.MeshLambertMaterial({ color: 0x1a1b24, side: THREE.DoubleSide }));
  const darkCockMat = p(new THREE.MeshLambertMaterial({ color: 0x07060d, side: THREE.DoubleSide }));
  const dashTopMat = p(new THREE.MeshLambertMaterial({ color: 0x181527, side: THREE.DoubleSide }));
  const armMat = p(new THREE.MeshLambertMaterial({ color: 0x05050a, side: THREE.DoubleSide })); // matte black

  // dashboard — WIDE angular PS1 slab (≈1.9 m) across the front of the
  // cabin, styled like a wide retro supercar (Testarossa / Diablo) dash
  const dash = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.45, 0.55), dashMat);
  dash.position.set(0, 0.74, 1.0);
  cockpit.add(dash);
  const dashTop = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.14, 0.32), dashTopMat);
  dashTop.position.set(0, 1.02, 1.06);
  dashTop.rotation.x = -0.32;
  cockpit.add(dashTop);

  // neon facia strip along the dash's top-front edge — a thin glowing
  // line that makes the torpedo contour read clearly (bass-pulsed)
  const faciaMat = p(new THREE.MeshBasicMaterial({ color: 0x4df3ff, side: THREE.DoubleSide }));
  const facia = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.04, 0.07), faciaMat);
  facia.position.set(0, 0.98, 1.24);
  cockpit.add(facia);

  // windshield A-pillars — wider dark struts framing the view on both
  // sides of the windshield (carcass), thin enough to never block the
  // camera's forward look
  for (const sx of [-0.95, 0.95]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.32, 0.24), darkCockMat);
    pillar.position.set(sx, 1.14, 0.82);
    pillar.rotation.x = -0.28;
    cockpit.add(pillar);
  }

  // center console — wider retro box between the seats
  const consoleBox = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.3, 0.5), darkCockMat);
  consoleBox.position.set(0.0, 0.68, 0.72);
  cockpit.add(consoleBox);

  // ---- steering wheel + driver's arms (rotate together around Z) ----
  const wheelRimMat = p(new THREE.MeshLambertMaterial({ color: 0x101018, side: THREE.DoubleSide }));
  const steeringWheelGroup = new THREE.Group();
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.045, 6, 14), wheelRimMat);
  steeringWheelGroup.add(rim);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.08, 6), wheelRimMat);
  hub.rotation.x = Math.PI / 2; // cylinder axis → Z (wheel axis)
  steeringWheelGroup.add(hub);

  // matte black arm/glove silhouettes BELOW and BESIDE the wheel at
  // 9 and 3 o'clock (driver's hands stay low, wheel not blocking the view)
  for (const [ax, ay] of [[0.19, 0.02], [-0.19, 0.02]]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.11, 0.09), armMat);
    arm.position.set(ax, ay, -0.02);
    arm.rotation.z = ax > 0 ? 0.55 : -0.55;
    steeringWheelGroup.add(arm);
  }
  // lower & lefter wheel: clear of the windshield, road visible above it
  steeringWheelGroup.position.set(-0.35, 0.85, 0.62);
  cockpit.add(steeringWheelGroup);

  // ---- spinning neon vinyl record on the console (right of the wheel) ----
  // flat round disc with a glowing neon center (turquoise/pink) — spins
  // during music playback and pulses with audioData.bass
  const vinylGroup = new THREE.Group();
  const vinylMat = p(new THREE.MeshLambertMaterial({ color: 0x0a0a12, side: THREE.DoubleSide }));
  const vinyl = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.025, 18), vinylMat);
  vinyl.rotation.x = Math.PI / 2; // flat disc
  vinylGroup.add(vinyl);
  // grooves: subtle ring lines
  for (let r = 0.04; r < 0.14; r += 0.03) {
    const groove = new THREE.Mesh(
      new THREE.TorusGeometry(r, 0.004, 4, 16),
      new THREE.MeshBasicMaterial({ color: 0x15151f, side: THREE.DoubleSide })
    );
    groove.rotation.x = Math.PI / 2;
    vinylGroup.add(groove);
  }
  // neon center — bright turquoise disc
  const neonMat = p(new THREE.MeshBasicMaterial({ color: 0x4df3ff, side: THREE.DoubleSide }));
  const neonDisc = new THREE.Mesh(new THREE.CircleGeometry(0.06, 12), neonMat);
  neonDisc.position.z = 0.014;
  vinylGroup.add(neonDisc);
  vinylGroup.userData.neon = neonDisc; // for bass pulse in main.js
  vinylGroup.position.set(0.3, 0.79, 0.6);
  vinylGroup.rotation.z = 0.25; // tilt so the disc is visible from the seat
  cockpit.add(vinylGroup);

  // mini retro radio — dark body + weakly glowing screen on the console
  const radioBody = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.14, 0.1), darkCockMat);
  radioBody.position.set(0.0, 0.78, 0.42);
  cockpit.add(radioBody);

  // neon dash indicator bars + speedo rings + radio screen — all pulse
  // with the music bass. Instruments are neon-glowing (turquoise / orange)
  // so they read beautifully in the dark cabin.
  const dashLights = [];
  // dash facia strip pulses with the bass too
  dashLights.push({ mat: faciaMat, base: new THREE.Color(0x4df3ff) });
  // neon strips along the torpedo (dash front edge) — cyan left, orange right
  for (const [sx, col] of [[-0.75, 0x4df3ff], [0.75, 0xff8a3d]]) {
    const lm = p(new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide }));
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.09, 0.07), lm);
    bar.position.set(sx, 0.78, 1.15);
    cockpit.add(bar);
    dashLights.push({ mat: lm, base: new THREE.Color(col) });
  }
  // neon buttons row on the dash (small glowing "chips")
  for (const [bx, col] of [[-0.45, 0x4df3ff], [-0.15, 0xff8a3d], [0.15, 0x4df3ff], [0.45, 0xff8a3d]]) {
    const lm = p(new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide }));
    const btn = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.07, 0.05), lm);
    btn.position.set(bx, 0.95, 1.02);
    cockpit.add(btn);
    dashLights.push({ mat: lm, base: new THREE.Color(col) });
  }
  // retro speedo backlight: cyan outer ring + orange inner ring
  for (const [radius, tube, col] of [[0.12, 0.018, 0x4df3ff], [0.075, 0.014, 0xff8a3d]]) {
    const lm = p(new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide }));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 6, 18), lm);
    ring.position.set(0.18, 1.02, 1.03);
    cockpit.add(ring);
    dashLights.push({ mat: lm, base: new THREE.Color(col) });
  }
  // radio screen — weakly glowing
  const radioScreenMat = p(new THREE.MeshBasicMaterial({ color: 0x0a3a4a, side: THREE.DoubleSide }));
  const radioScreen = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 0.02), radioScreenMat);
  radioScreen.position.set(0.0, 0.78, 0.47);
  cockpit.add(radioScreen);
  dashLights.push({ mat: radioScreenMat, base: new THREE.Color(0x0a3a4a) });
  // vinyl neon center also pulses with bass
  dashLights.push({ mat: neonMat, base: new THREE.Color(0x4df3ff) });

  car.add(cockpit);
  cockpit.visible = false; // shown only in COCKPIT_VIEW

  // fake blob shadow (PS1 had blob shadows!)
  const shadowTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 4, 32, 32, 30);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    return t;
  })();
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 5.2),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, side: THREE.DoubleSide })
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.04;
  car.add(blob);

  return { group: car, wheels, glow, blob, glass, cockpit, steeringWheelGroup, vinylGroup, dashLights, headLights, headMat };
}
