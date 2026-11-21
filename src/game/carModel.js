/**
 * Simple dark low-poly car — PS1 vibe, no fancy textures.
 * Model faces +Z at rotation.y = 0.
 */
import * as THREE from 'three';

export function buildCar(patch) {
  const p = patch || ((m) => m);
  const car = new THREE.Group();

  const bodyMat = p(new THREE.MeshLambertMaterial({ color: 0x16161f }));
  const darkMat = p(new THREE.MeshLambertMaterial({ color: 0x0a0a10 }));
  const glassMat = p(new THREE.MeshLambertMaterial({ color: 0x1a2438, emissive: 0x0a1526 }));
  const headMat = p(new THREE.MeshBasicMaterial({ color: 0xfff6c8 }));
  const tailMat = p(new THREE.MeshBasicMaterial({ color: 0xff2a4d }));
  const underMat = p(new THREE.MeshBasicMaterial({ color: 0xff4df3 }));

  // chassis (wide, low)
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.55, 4.2), bodyMat);
  body.position.y = 0.55;
  car.add(body);

  // hood taper
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.34, 0.9), bodyMat);
  nose.position.set(0, 0.42, 2.35);
  car.add(nose);

  // cabin
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 1.9), glassMat);
  cabin.position.set(0, 1.05, -0.25);
  car.add(cabin);

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

  // headlights
  for (const sx of [-0.6, 0.6]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.18, 0.1), headMat);
    h.position.set(sx, 0.52, 2.81);
    car.add(h);
  }
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
  const wheelMat = p(new THREE.MeshLambertMaterial({ color: 0x05050a }));
  const rimMat = p(new THREE.MeshLambertMaterial({ color: 0x3a3a55 }));

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
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.04;
  car.add(blob);

  return { group: car, wheels, glow, blob };
}
