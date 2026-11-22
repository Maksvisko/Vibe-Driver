/**
 * Procedural night-city circuit:
 * closed Catmull-Rom spline → road ribbon, barriers, start gate,
 * street lights, skyline. Provides centerline queries for physics/laps.
 */
import * as THREE from 'three';

const ROAD_HALF = 7;
const WALL_OFFSET = ROAD_HALF + 3.2;

export class Track {
  constructor(scene, patchFn) {
    this.scene = scene;
    this.patch = patchFn || ((m) => m);

    // --- control points (closed loop) ---
    const pts = [
      [0, 0], [70, -4], [130, -18], [175, -55], [186, -110],
      [160, -155], [110, -168], [70, -150], [30, -158], [-20, -175],
      [-75, -165], [-115, -125], [-128, -70], [-110, -25], [-70, -8], [-32, -6],
    ].map(([x, z]) => new THREE.Vector3(x, 0, z));

    this.curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.6);

    // --- samples for physics/minimap ---
    this.N = 700;
    this.samples = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < this.N; i++) {
      const t = i / this.N;
      const pos = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t).setY(0).normalize();
      const lat = new THREE.Vector3().crossVectors(tan, up).normalize(); // right side
      this.samples.push({ pos, tan, lat });
    }

    this._buildRoad();
    this._buildWalls();
    this._buildStartGate();
    this._buildScenery();
    this._buildGround();

    this.halfWidth = ROAD_HALF;
    this.wallLimit = WALL_OFFSET;
    this._lastIdx = 0;
  }

  _roadTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#1a1a24';
    g.fillRect(0, 0, 256, 256);
    // asphalt noise
    for (let i = 0; i < 2600; i++) {
      const v = 20 + Math.random() * 26;
      g.fillStyle = `rgba(${v},${v},${v + 8},0.55)`;
      g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
    }
    // edges (neon)
    g.fillStyle = '#ff4df3';
    g.fillRect(6, 0, 6, 256);
    g.fillStyle = '#4df3ff';
    g.fillRect(244, 0, 6, 256);
    // center dashes
    g.fillStyle = '#ffe94d';
    g.fillRect(124, 18, 8, 64);
    g.fillStyle = 'rgba(255,233,77,0.35)';
    g.fillRect(124, 82, 8, 6);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _buildRoad() {
    const n = this.N;
    const posArr = new Float32Array((n + 1) * 2 * 3);
    const uvArr = new Float32Array((n + 1) * 2 * 2);
    const idx = [];

    let dist = 0;
    for (let i = 0; i <= n; i++) {
      const s = this.samples[i % n];
      if (i > 0) dist += this.samples[i - 1].pos.distanceTo(s.pos);
      const L = s.pos.clone().addScaledVector(s.lat, -ROAD_HALF);
      const R = s.pos.clone().addScaledVector(s.lat, ROAD_HALF);
      const vi = i * 6;
      posArr[vi] = L.x; posArr[vi + 1] = 0.02; posArr[vi + 2] = L.z;
      posArr[vi + 3] = R.x; posArr[vi + 4] = 0.02; posArr[vi + 5] = R.z;
      const ui = i * 4;
      uvArr[ui] = 0; uvArr[ui + 1] = dist / 9;
      uvArr[ui + 2] = 1; uvArr[ui + 3] = dist / 9;
      if (i < n) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const mat = this.patch(new THREE.MeshLambertMaterial({ map: this._roadTexture() }));
    const road = new THREE.Mesh(geo, mat);
    road.receiveShadow = false;
    this.scene.add(road);
    this.roadLength = dist;
  }

  _buildWalls() {
    const n = this.N;
    const posArr = new Float32Array((n + 1) * 2 * 2 * 3); // 2 walls × 2 verts
    const colors = new Float32Array((n + 1) * 2 * 2 * 3);
    const idx = [];
    const H = 1.6;

    const cA = new THREE.Color('#4df3ff');
    const cB = new THREE.Color('#ff4df3');

    for (let i = 0; i <= n; i++) {
      const s = this.samples[i % n];
      const seg = Math.floor(i / 14) % 2;
      const col = seg ? cB : cA;
      const sideSigns = [-1, 1];
      for (let w = 0; w < 2; w++) {
        const off = sideSigns[w] * WALL_OFFSET;
        const base = (i * 2 + w) * 6;
        const p = s.pos.clone().addScaledVector(s.lat, off);
        posArr[base] = p.x; posArr[base + 1] = 0; posArr[base + 2] = p.z;
        posArr[base + 3] = p.x; posArr[base + 4] = H; posArr[base + 5] = p.z;
        for (let v = 0; v < 2; v++) {
          const ci = (i * 2 + w) * 6 + v * 3;
          colors[ci] = col.r; colors[ci + 1] = col.g; colors[ci + 2] = col.b;
        }
        if (i < n) {
          const a = (i * 2 + w) * 2;
          const b = ((i + 1) * 2 + w) * 2;
          if (w === 0) idx.push(a, a + 1, b, a + 1, b + 1, b);
          else idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const mat = this.patch(new THREE.MeshLambertMaterial({
      vertexColors: true,
      emissive: 0xffffff,
      emissiveIntensity: 0.55,
      side: THREE.DoubleSide,
    }));
    // emissive tint via vertex colors won't glow alone — bump with emissive map? keep simple:
    mat.emissive = new THREE.Color(0x888888);
    this.barrierMat = mat; // reactive to music bass (see pulse())
    this.scene.add(new THREE.Mesh(geo, mat));
  }

  _buildStartGate() {
    const s = this.samples[0];
    const group = new THREE.Group();
    const gateMat = this.patch(new THREE.MeshLambertMaterial({ color: 0x141227 }));
    const glowMat = this.patch(new THREE.MeshBasicMaterial({ color: 0xffe94d }));

    const pillarGeo = new THREE.BoxGeometry(1.2, 9, 1.2);
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(pillarGeo, gateMat);
      const offset = s.pos.clone().addScaledVector(s.lat, side * (WALL_OFFSET + 0.6));
      p.position.set(offset.x, 4.5, offset.z);
      group.add(p);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.8, 1.6), glowMat);
      cap.position.set(offset.x, 9.4, offset.z);
      group.add(cap);
    }
    // banner
    const banner = new THREE.Mesh(new THREE.BoxGeometry(WALL_OFFSET * 2 + 2, 1.8, 0.5), glowMat);
    banner.position.set(s.pos.x, 8.2, s.pos.z);
    banner.rotation.y = Math.atan2(s.tan.x, s.tan.z);
    group.add(banner);

    // checkered strip on road
    const stripGeo = new THREE.PlaneGeometry(WALL_OFFSET * 2, 3);
    const stripMat = this.patch(new THREE.MeshBasicMaterial({
      map: this._checkerTexture(), transparent: false,
    }));
    const strip = new THREE.Mesh(stripGeo, stripMat);
    strip.rotation.x = -Math.PI / 2;
    strip.rotation.z = -Math.atan2(s.tan.x, s.tan.z);
    strip.position.set(s.pos.x, 0.05, s.pos.z);
    group.add(strip);

    this.scene.add(group);
  }

  _checkerTexture() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 16;
    const g = c.getContext('2d');
    for (let x = 0; x < 8; x++) for (let y = 0; y < 2; y++) {
      g.fillStyle = (x + y) % 2 ? '#111' : '#eee';
      g.fillRect(x * 8, y * 8, 8, 8);
    }
    const t = new THREE.CanvasTexture(c);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  _buildScenery() {
    // street lights along track + random skyline blocks
    const lampPole = this.patch(new THREE.MeshLambertMaterial({ color: 0x0e0c1e }));
    const lampHead = this.patch(new THREE.MeshBasicMaterial({ color: 0x9df8ff }));
    const poleGeo = new THREE.BoxGeometry(0.3, 6, 0.3);
    const headGeo = new THREE.BoxGeometry(1.6, 0.5, 0.7);
    this.lampMats = [lampHead]; // reactive to music bass (see pulse())

    for (let i = 20; i < this.N; i += 34) {
      const s = this.samples[i];
      const side = (Math.floor(i / 34) % 2) ? 1 : -1;
      // strictly beyond the barriers: 24 m from the road edge (20–30 m rule)
      const p = s.pos.clone().addScaledVector(s.lat, side * (ROAD_HALF + 24));
      const pole = new THREE.Mesh(poleGeo, lampPole);
      pole.position.set(p.x, 3, p.z);
      this.scene.add(pole);
      const head = new THREE.Mesh(headGeo, lampHead);
      head.position.set(p.x - s.lat.x * side * 0.6, 6.1, p.z - s.lat.z * side * 0.6);
      head.rotation.y = Math.atan2(s.tan.x, s.tan.z);
      this.scene.add(head);
    }

    // skyline: buildings placed away from track
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const winTex = this._windowTexture();
    const buildingMat = this.patch(new THREE.MeshLambertMaterial({
      color: 0x12102a, emissive: 0xffffff, emissiveMap: winTex, emissiveIntensity: 0.9,
    }));
    this.buildingMat = buildingMat; // subtle bass reactive glow
    const placed = [];
    let tries = 0;
    while (placed.length < 90 && tries < 2500) {
      tries++;
      const a = Math.random() * Math.PI * 2;
      const r = 40 + Math.random() * 260;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r - 85;
      const w = 8 + Math.random() * 16;
      const d = 8 + Math.random() * 16;
      // whole footprint ≥ 20 m clear of the road edge: centerline distance
      // must exceed ROAD_HALF + 20 + half-diagonal of the building
      const clear = ROAD_HALF + 20 + Math.hypot(w, d) / 2;
      const clear2 = clear * clear;
      const near = this.samples.some((s) =>
        (x - s.pos.x) * (x - s.pos.x) + (z - s.pos.z) * (z - s.pos.z) < clear2);
      if (near) continue;
      placed.push([x, z]);
      const h = 12 + Math.random() * 46;
      const b = new THREE.Mesh(boxGeo, buildingMat);
      b.scale.set(w, h, d);
      b.position.set(x, h / 2 - 0.1, z);
      b.rotation.y = Math.random() * 0.6;
      this.scene.add(b);
    }
  }

  _windowTexture() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, 64, 64);
    const cols = ['#4df3ff', '#ff4df3', '#ffe94d', '#7dff9a'];
    for (let y = 4; y < 64; y += 8) {
      for (let x = 4; x < 64; x += 8) {
        if (Math.random() < 0.55) {
          g.fillStyle = cols[(Math.random() * cols.length) | 0];
          g.globalAlpha = 0.5 + Math.random() * 0.5;
          g.fillRect(x, y, 4, 4);
        }
      }
    }
    g.globalAlpha = 1;
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  _buildGround() {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#0a0818';
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(77,243,255,0.14)';
    g.lineWidth = 1;
    for (let i = 0; i <= 128; i += 16) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke();
      g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(60, 60);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = this.patch(new THREE.MeshLambertMaterial({ map: tex, color: 0x8888aa }));
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), mat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    this.scene.add(ground);
  }

  // ---------- queries ----------

  /**
   * Nearest centerline sample with local search around lastIndex.
   * @returns {{index:number, offset:number, sample:object}}
   */
  query(x, z, lastIndex = 0, windowSize = 60) {
    const N = this.N;
    let best = -1;
    let bestD = Infinity;
    const start = lastIndex - windowSize;
    for (let k = 0; k < windowSize * 2; k++) {
      const i = ((start + k) % N + N) % N;
      const s = this.samples[i];
      const dx = x - s.pos.x;
      const dz = z - s.pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    // occasional global fallback if far away (e.g. after reset)
    if (bestD > 40 * 40) {
      for (let i = 0; i < N; i += 3) {
        const s = this.samples[i];
        const dx = x - s.pos.x;
        const dz = z - s.pos.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    const s = this.samples[best];
    const dx = x - s.pos.x;
    const dz = z - s.pos.z;
    const offset = dx * s.lat.x + dz * s.lat.z; // + = right of centerline
    return { index: best, offset, sample: s, dist: Math.sqrt(bestD) };
  }

  /** progress0..1 for minimap / anti-cheat */
  progress(index) { return index / this.N; }

  spawnPose(index = 0) {
    const s = this.samples[index];
    const heading = Math.atan2(s.tan.x, s.tan.z); // model faces +Z at rot.y=0? see car
    return { x: s.pos.x, z: s.pos.z, heading: Math.atan2(s.tan.x, s.tan.z) };
  }

  /** draw minimap path into a 2D canvas context (normalized) */
  drawMinimapPath(ctx, w, h, pad = 12) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of this.samples) {
      minX = Math.min(minX, s.pos.x); maxX = Math.max(maxX, s.pos.x);
      minZ = Math.min(minZ, s.pos.z); maxZ = Math.max(maxZ, s.pos.z);
    }
    const sx = (w - pad * 2) / (maxX - minX);
    const sy = (h - pad * 2) / (maxZ - minZ);
    const sc = Math.min(sx, sy);
    const ox = pad + ((w - pad * 2) - (maxX - minX) * sc) / 2;
    const oy = pad + ((h - pad * 2) - (maxZ - minZ) * sc) / 2;
    this._map = { minX, minZ, sc, ox, oy };
    ctx.strokeStyle = 'rgba(77,243,255,0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i <= this.N; i += 4) {
      const s = this.samples[i % this.N];
      const px = ox + (s.pos.x - minX) * sc;
      const py = oy + (s.pos.z - minZ) * sc;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
    // start mark
    const s0 = this.samples[0];
    ctx.fillStyle = '#ffe94d';
    ctx.fillRect(ox + (s0.pos.x - minX) * sc - 3, oy + (s0.pos.z - minZ) * sc - 3, 6, 6);
  }

  mapPoint(x, z) {
    const m = this._map;
    if (!m) return null;
    return { x: m.ox + (x - m.minX) * m.sc, y: m.oy + (z - m.minZ) * m.sc };
  }

  // ---------- music-reactive world ----------

  /**
   * Called every frame: makes neon barriers + street lamps pulse with the
   * bass. On a beat hit the emissiveIntensity spikes, then decays smoothly
   * toward the base value via lerp. No-op when no bass data is available.
   *
   * @param {number} bass 0..1 low-frequency level from MusicPlayer.bass()
   * @param {number} dt   frame delta in seconds
   */
  pulse(bass, dt) {
    const k = Math.min(1, dt * 6.5); // smoothing factor (frame-rate safe lerp)

    // barriers: sharp attack, slow release — target follows bass with a floor
    if (this.barrierMat) {
      const target = 0.45 + bass * 2.2;
      this.barrierMat.emissiveIntensity +=
        (target - this.barrierMat.emissiveIntensity) * k;
    }

    // lamp heads (MeshBasicMaterial → scale color brightness instead of emissive)
    if (this.lampMats) {
      const target = THREE.MathUtils.clamp(0.5 + bass * 2.0, 0.5, 1.6);
      for (const m of this.lampMats) {
        m.color.setRGB(
          THREE.MathUtils.clamp(0.61 + target * 0.39, 0, 1), // R
          THREE.MathUtils.clamp(0.97 - target * 0.07, 0, 1), // G
          1.0                                                // B
        );
      }
    }

    // buildings: very subtle extra glow on strong beats
    if (this.buildingMat) {
      const target = 0.85 + bass * 0.7;
      this.buildingMat.emissiveIntensity +=
        (target - this.buildingMat.emissiveIntensity) * k * 0.6;
    }
  }
}
