/**
 * PS1-style rendering pipeline:
 *  - scene rendered into a low-res target (pixelation)
 *  - vertex snapping in the vertex shader (classic PS1 "wobble")
 *  - color quantization + Bayer ordered dithering + vignette on upscale
 *
 * Stability: any failure (context, shader, post-process) degrades to a
 * plain direct Three.js render without crashing the game.
 */
import * as THREE from 'three';

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
  uniform float uLevels;
  uniform float uDither;
  varying vec2 vUv;

  void main() {
    vec3 col = texture2D(tDiffuse, vUv).rgb;

    // manual 4x4 Bayer index (WebGL1-safe)
    int xi = int(mod(gl_FragCoord.x, 4.0));
    int yi = int(mod(gl_FragCoord.y, 4.0));
    float bay = 0.0;
    if (yi == 0) { if (xi==0) bay=0.0; else if (xi==1) bay=8.0; else if (xi==2) bay=2.0; else bay=10.0; }
    else if (yi == 1) { if (xi==0) bay=12.0; else if (xi==1) bay=4.0; else if (xi==2) bay=14.0; else bay=6.0; }
    else if (yi == 2) { if (xi==0) bay=3.0; else if (xi==1) bay=11.0; else if (xi==2) bay=1.0; else bay=9.0; }
    else { if (xi==0) bay=15.0; else if (xi==1) bay=7.0; else if (xi==2) bay=13.0; else bay=15.0; }
    float d = (bay / 16.0 - 0.5) * uDither;

    col += d;
    col = floor(col * uLevels + 0.5) / uLevels;

    vec2 q = vUv - 0.5;
    float vig = 1.0 - dot(q, q) * 0.55;
    col *= vig;

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

export class PS1Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{pixelHeight?: number}} opts
   * @throws if WebGL is completely unavailable (caller should handle)
   */
  constructor(canvas, { pixelHeight = 240 } = {}) {
    this.pixelHeight = pixelHeight;
    this.canvas = canvas;
    this.mode = 'ps1';          // 'ps1' | 'plain'
    this.failed = false;        // true → render() becomes a no-op (context lost)

    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: false,
        powerPreference: 'high-performance',
        failIfMajorPerformanceCaveat: false,
      });
      this.renderer.setPixelRatio(1);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    } catch (e) {
      this.failed = true;
      this.mode = 'plain';
      throw e; // no WebGL at all — caller shows a friendly message
    }

    // context loss / restore — don't crash, just pause rendering
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.failed = true;
      console.warn('WebGL context lost');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.failed = false;
      console.info('WebGL context restored');
      this._setupPost();
    });

    // stable vector: patched materials keep referencing it across post rebuilds
    this._snapRes = new THREE.Vector2(320, this.pixelHeight);
    this._setupPost();
    this._patched = new WeakSet();

    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _setupPost() {
    try {
      this.target = new THREE.WebGLRenderTarget(320, this.pixelHeight, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
        stencilBuffer: false,
      });
      this.target.texture.colorSpace = THREE.SRGBColorSpace;

      this.postScene = new THREE.Scene();
      this.postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this.postMat = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: this.target.texture },
          uRes: { value: this._snapRes },
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
      this._postReady = true;
      this._resize();
    } catch (e) {
      console.warn('PS1 post-process setup failed, falling back to plain render', e);
      this._postReady = false;
      this.mode = 'plain';
    }
  }

  _resize() {
    if (!this.renderer) return;
    try {
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.renderer.setSize(w, h, false);

      if (this.target && this.postMat) {
        const aspect = w / h;
        const ph = this.pixelHeight;
        const pw = Math.max(160, Math.round(ph * aspect / 2) * 2);
        this.target.setSize(pw, ph);
        this.postMat.uniforms.uRes.value.set(pw, ph);
      }
    } catch (e) {
      console.warn('resize failed', e);
    }
  }

  get snapResolution() {
    return this.postMat?.uniforms?.uRes?.value || new THREE.Vector2(320, 240);
  }

  /**
   * Patch a material so its vertices snap to the low-res grid (PS1 wobble).
   * If shader patching throws, the material is left unpatched (still renders).
   */
  patch(material) {
    if (!material || this.mode !== 'ps1' || this._patched.has(material)) return material;
    this._patched.add(material);

    try {
      const snap = this.snapResolution;
      const prev = material.onBeforeCompile;
      material.onBeforeCompile = (shader, renderer) => {
        if (prev) prev(shader, renderer);
        try {
          if (shader.vertexShader.includes('#include <project_vertex>')) {
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
              vec2 ndc = gl_Position.xy / max(abs(gl_Position.w), 0.0001);
              vec2 grid = uSnapRes * 0.5;
              ndc = floor(ndc * grid + 0.5) / grid;
              gl_Position.xy = ndc * gl_Position.w;
              `
            );
          }
        } catch (e) {
          console.warn('vertex snap patch failed (rendering unpatched):', e);
        }
      };
      material.customProgramCacheKey = () => 'ps1-snap';
      material.needsUpdate = true;
    } catch (e) {
      console.warn('material patch failed:', e);
      this.mode = 'plain';
    }
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

  /** Switch permanently to plain direct rendering (no post). */
  _goPlain(reason) {
    if (this.mode === 'plain') return;
    console.warn(`PS1 pipeline disabled (${reason}) → plain Three.js render`);
    this.mode = 'plain';
  }

  render(scene, camera) {
    if (this.failed || !this.renderer) return;

    if (this.mode === 'ps1' && this._postReady && this.target && this.postScene) {
      try {
        this.renderer.setRenderTarget(this.target);
        this.renderer.clear();
        this.renderer.render(scene, camera);
        this.renderer.setRenderTarget(null);
        this.renderer.render(this.postScene, this.postCamera);
        return;
      } catch (e) {
        this._goPlain(e?.message || 'post render error');
        try { this.renderer.setRenderTarget(null); } catch { /* ok */ }
      }
    }

    // plain fallback — direct render, never uses the post pipeline
    try {
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, camera);
    } catch (e) {
      this.failed = true;
      console.error('Plain render also failed:', e);
    }
  }
}
