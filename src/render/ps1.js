/**
 * PS1-style rendering pipeline:
 *  - scene rendered into a low-res target (pixelation)
 *  - vertex snapping in the vertex shader (classic PS1 "wobble")
 *  - color quantization + Bayer ordered dithering + vignette on upscale
 */
import * as THREE from 'three';

const BAYER_4X4 = `
const mat4 bayer = mat4(
  0.0, 8.0, 2.0, 10.0,
  12.0, 4.0, 14.0, 6.0,
  3.0, 11.0, 1.0, 9.0,
  15.0, 7.0, 13.0, 5.0
);
`;

const POST_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const POST_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform vec2 uRes;
  uniform float uLevels;
  uniform float uDither;
  varying vec2 vUv;

  ${BAYER_4X4}

  void main() {
    vec3 col = texture2D(tDiffuse, vUv).rgb;

    // ordered dithering before quantization
    int xi = int(mod(gl_FragCoord.x, 4.0));
    int yi = int(mod(gl_FragCoord.y, 4.0));
    // manual mat4 index (WebGL1-safe)
    float bay = 0.0;
    if (yi == 0) { if (xi==0) bay=0.0; else if (xi==1) bay=8.0; else if (xi==2) bay=2.0; else bay=10.0; }
    else if (yi == 1) { if (xi==0) bay=12.0; else if (xi==1) bay=4.0; else if (xi==2) bay=14.0; else bay=6.0; }
    else if (yi == 2) { if (xi==0) bay=3.0; else if (xi==1) bay=11.0; else if (xi==2) bay=1.0; else bay=9.0; }
    else { if (xi==0) bay=15.0; else if (xi==1) bay=7.0; else if (xi==2) bay=13.0; else bay=15.0; }
    float d = (bay / 16.0 - 0.5) * uDither;

    col += d;
    col = floor(col * uLevels + 0.5) / uLevels;

    // subtle vignette
    vec2 q = vUv - 0.5;
    float vig = 1.0 - dot(q, q) * 0.55;
    col *= vig;

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

export class PS1Renderer {
  constructor(canvas, { pixelHeight = 240 } = {}) {
    this.pixelHeight = pixelHeight;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.target = new THREE.WebGLRenderTarget(320, pixelHeight, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.target.texture.colorSpace = THREE.SRGBColorSpace;

    // post quad
    this.postScene = new THREE.Scene();
    this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.postMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.target.texture },
        uRes: { value: new THREE.Vector2(320, pixelHeight) },
        uLevels: { value: 32.0 },
        uDither: { value: 0.035 },
      },
      vertexShader: POST_VERT,
      fragmentShader: POST_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMat);
    quad.frustumCulled = false;
    this.postScene.add(quad);

    this._patched = new WeakSet();
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);

    const aspect = w / h;
    const ph = this.pixelHeight;
    const pw = Math.max(160, Math.round(ph * aspect / 2) * 2);
    this.target.setSize(pw, ph);
    this.postMat.uniforms.uRes.value.set(pw, ph);
  }

  get snapResolution() {
    return this.postMat.uniforms.uRes.value;
  }

  /** Patch a material so its vertices snap to the low-res grid (PS1 wobble). */
  patch(material) {
    if (!material || this._patched.has(material)) return material;
    this._patched.add(material);

    const snap = this.postMat.uniforms.uRes.value;
    const apply = (shader) => {
      shader.uniforms.uSnapRes = { value: snap };
      shader.vertexShader = `uniform vec2 uSnapRes;\n` + shader.vertexShader.replace(
        '#include <project_vertex>',
        /* glsl */ `
        vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;
        // PS1 vertex snap in NDC
        vec2 ndc = gl_Position.xy / max(gl_Position.w, 0.0001);
        vec2 grid = uSnapRes * 0.5;
        ndc = floor(ndc * grid + 0.5) / grid;
        gl_Position.xy = ndc * gl_Position.w;
        `
      );
    };

    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      if (prev) prev(shader, renderer);
      apply(shader);
    };
    material.customProgramCacheKey = () => 'ps1-snap';
    material.needsUpdate = true;
    return material;
  }

  /** Convenience: patch every material on an object tree. */
  patchTree(root) {
    root.traverse((obj) => {
      if (!obj.material) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => this.patch(m));
    });
    return root;
  }

  render(scene, camera) {
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear();
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.postScene, this.postCamera);
  }
}
