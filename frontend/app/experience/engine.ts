/**
 * The 3D experience, one continuous night-space world:
 *
 *  1. A head of light (points sampled from a scan) that faces you and turns to follow the cursor.
 *     The face is rigid; the dust it sheds lives in world space, so it trails off like smoke.
 *  2. On Find the head disperses past the camera and we glide through a gallery of light:
 *     portraits floating in the dark, drawn as dots inside thin frames of light.
 *  3. At the end, a cloud of particles streams into three frames and assembles into the matches,
 *     each point coloured from its photo, then the real photos resolve.
 *
 * Plain three.js; page.tsx drives it through startSearch / showResults / back. The camera rides one
 * Catmull-Rom curve; "where we are" is a single progress value 0..1 along it, and the fades are
 * derived from that value, so the choreography can't fall out of sync.
 */
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

export type FrameRect = { x: number; y: number; width: number; height: number };

const INK = new THREE.Color("#04060c");
const HEAD_SCALE = 1.36;
const HISTORY = 32;            // head poses remembered for the dust...
const HISTORY_STEP = 0.2;      // ...one every 0.2 s, so 6.4 s of trail

// the final frames: square photos (the index thumbnails are 160 x 160)
const WALL_Z = -31;
const FINAL_FRAMES = [
  { x: -2.25, y: 0.5, s: 1.3 },
  { x: 0, y: 0.68, s: 1.7 },     // the best match: centre, larger, a little higher
  { x: 2.25, y: 0.5, s: 1.3 },
];
const RESULT_ORDER = [1, 0, 2];  // matches[0] goes in the centre frame
const GRID = 72;                 // assembly points per frame side (72 x 72)

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------------------------------- shaders
// shared by every point system: a soft round dot, additive
const POINT_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
}`;

const LIGHTING = /* glsl */ `
vec3 lightPoint(vec3 n, vec3 cool, vec3 warm) {
  // a soft warm key from the upper left, a strong cool rim
  float key = max(dot(n, normalize(vec3(-0.45, 0.55, 0.7))), 0.0);
  float rim = pow(1.0 - abs(n.z), 2.2);
  return mix(cool, warm, key * 0.7) * (0.05 + 0.62 * key + 0.68 * rim);
}`;

// the face: rigid, rotates with the head
const HEAD_VERT = /* glsl */ `
attribute float aSeed;
uniform float uTime, uBurst, uSize, uPixelRatio;
uniform vec3 uCool, uWarm;
varying vec3 vColor;
varying float vAlpha;
${LIGHTING}
void main() {
  vec3 p = position + normal * 0.006 * sin(uTime * 1.6 + aSeed * 50.0);   // breathing shimmer
  // the burst: the head blows apart toward and past the camera
  vec3 away = normalize(p + vec3(0.0, 0.0, 0.35)) * (0.6 + aSeed);
  p += away * uBurst * 2.6 + vec3(0.0, 0.0, 5.5 * aSeed) * uBurst * uBurst;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uPixelRatio * (0.55 + 0.9 * aSeed) / -mv.z;
  vColor = lightPoint(normalize(normalMatrix * normal), uCool, uWarm);
  vAlpha = 1.0 - smoothstep(0.55, 1.0, uBurst);
}`;

// the dust: born on the face where the face *was* at its birth (pose history), then drifting in
// world space - so turning the head leaves a trail of light instead of dragging the dust along
const DUST_VERT = /* glsl */ `
attribute float aSeed;
uniform float uTime, uBurst, uSize, uPixelRatio, uScale;
uniform vec3 uHeadPos, uCool, uWarm;
uniform float uYaw[${HISTORY}];
uniform float uPitch[${HISTORY}];
varying vec3 vColor;
varying float vAlpha;
${LIGHTING}
mat3 rotYX(float yaw, float pitch) {
  float cy = cos(yaw), sy = sin(yaw), cx = cos(pitch), sx = sin(pitch);
  mat3 ry = mat3(cy, 0.0, -sy,  0.0, 1.0, 0.0,  sy, 0.0, cy);
  mat3 rx = mat3(1.0, 0.0, 0.0,  0.0, cx, sx,  0.0, -sx, cx);
  return ry * rx;
}
void main() {
  float life = 4.0 + 2.2 * aSeed;                                  // seconds
  float age = mod(uTime + aSeed * 37.0, life);
  float h = min(age / ${HISTORY_STEP.toFixed(2)}, ${(HISTORY - 1.001).toFixed(3)});
  int i = int(floor(h));
  float f = fract(h);
  float yaw = mix(uYaw[i], uYaw[i + 1], f);
  float pitch = mix(uPitch[i], uPitch[i + 1], f);
  mat3 r = rotYX(yaw, pitch);
  vec3 born = r * position * uScale;
  vec3 n = r * normal;
  // drift: out from the surface, lifted and carried right-and-back by a slow breeze, with a curl
  float k = age / life;
  vec3 drift = n * 0.5 * k + vec3(0.55, 0.32, -0.35) * k * k * 3.0
             + vec3(sin(uTime * 0.6 + aSeed * 40.0), cos(uTime * 0.45 + aSeed * 30.0), sin(uTime * 0.5 + aSeed * 20.0)) * 0.06 * k;
  vec3 p = uHeadPos + born + drift;
  p += normalize(born + vec3(0.0, 0.0, 0.5)) * uBurst * 2.6 * (0.6 + aSeed);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uPixelRatio * (0.5 + 0.8 * aSeed) * (1.0 - 0.4 * k) / -mv.z;
  vColor = lightPoint(normalize(mat3(viewMatrix) * n), uCool, uWarm) * (1.25 - 0.55 * k);
  vAlpha = smoothstep(0.0, 0.08, k) * (1.0 - smoothstep(0.55, 1.0, k)) * (1.0 - smoothstep(0.4, 0.9, uBurst));
}`;

const STAR_VERT = /* glsl */ `
attribute float aSeed;
uniform float uTime, uPixelRatio;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (1.0 + 2.2 * aSeed * aSeed) * uPixelRatio;
  vColor = mix(vec3(0.62, 0.72, 1.0), vec3(1.0, 0.9, 0.78), aSeed);
  vAlpha = 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * (0.6 + aSeed * 2.0) + aSeed * 90.0));
}`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// deep navy space with slow nebular haze and diagonal light shafts
const SKY_FRAG = /* glsl */ `
varying vec3 vDir;
uniform float uTime;
float hash(vec3 p) { return fract(sin(dot(p, vec3(17.1, 113.7, 41.3))) * 43758.5453); }
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float haze = fbm(d * 2.6 + vec3(uTime * 0.012, 0.0, uTime * 0.008));
  vec3 base = mix(vec3(0.006, 0.008, 0.02), vec3(0.018, 0.028, 0.075), smoothstep(-0.6, 0.7, d.y + haze * 0.5));
  base += vec3(0.04, 0.055, 0.15) * pow(haze, 2.6) * 0.8;
  float band = d.x * 0.85 + d.y * 0.55 + 0.04 * sin(uTime * 0.07);
  float shafts = pow(0.5 + 0.5 * sin(band * 7.0 + uTime * 0.05), 14.0);
  base += vec3(0.035, 0.055, 0.14) * shafts * (0.5 + haze);
  gl_FragColor = vec4(base, 1.0);
}`;

// a floating portrait: a faint silhouette drawn as a grid of glowing dots
const PORTRAIT_VERT = /* glsl */ `
varying vec2 vUv;
varying float vDist;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const PORTRAIT_FRAG = /* glsl */ `
varying vec2 vUv;
varying float vDist;
uniform float uTime, uFade, uSeed;
float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float ell(vec2 p, vec2 c, vec2 r) { vec2 q = (p - c) / r; return 1.0 - smoothstep(0.75, 1.0, dot(q, q)); }
void main() {
  vec2 cells = vec2(30.0, 39.0);
  vec2 cell = floor(vUv * cells);
  vec2 local = fract(vUv * cells) - 0.5;
  vec2 c = (cell + 0.5) / cells;
  float lean = (uSeed - 0.5) * 0.12;
  float s = max(ell(c, vec2(0.5 + lean, 0.6), vec2(0.17 + uSeed * 0.04, 0.23)), ell(c, vec2(0.5, 0.02), vec2(0.44, 0.3)) * 0.8);
  float h = hash(cell + uSeed * 17.0);
  float tw = 0.65 + 0.35 * sin(uTime * (0.8 + h * 2.0) + h * 30.0);
  float r = 0.1 + 0.28 * s * (0.5 + 0.5 * h);
  float dotA = smoothstep(r, r * 0.4, length(local)) * (0.08 + 0.92 * s) * tw;
  float near = smoothstep(30.0, 9.0, vDist);   // portraits brighten as we approach
  vec3 col = mix(vec3(0.45, 0.58, 1.0), vec3(1.0, 0.92, 0.82), s * 0.5);
  gl_FragColor = vec4(col * dotA * uFade * (0.25 + 0.75 * near), 1.0);
}`;

// the assembly: each point flies from a cloud to its pixel in a frame, coloured by the photo
const ASSEMBLE_VERT = /* glsl */ `
attribute vec3 aStart;
attribute vec2 aUv;
attribute float aFrame;
attribute float aSeed;
uniform float uTime, uSize, uPixelRatio, uOut;
uniform vec3 uAssemble;           // progress per frame (x: left, y: centre, z: right)
uniform vec3 uHasPhoto;
uniform sampler2D uTex0, uTex1, uTex2;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float a = aFrame < 0.5 ? uAssemble.x : (aFrame < 1.5 ? uAssemble.y : uAssemble.z);
  float has = aFrame < 0.5 ? uHasPhoto.x : (aFrame < 1.5 ? uHasPhoto.y : uHasPhoto.z);
  vec3 tex = aFrame < 0.5 ? texture2D(uTex0, aUv).rgb : (aFrame < 1.5 ? texture2D(uTex1, aUv).rgb : texture2D(uTex2, aUv).rgb);
  // each point leaves at its own moment, so the image fills in like a wave
  float t = clamp((a - aSeed * 0.45) / 0.55, 0.0, 1.0);
  t = t * t * (3.0 - 2.0 * t);
  // the waiting cloud swirls slowly around its centre
  vec3 swirl = vec3(sin(uTime * 0.3 + aSeed * 30.0), cos(uTime * 0.25 + aSeed * 20.0), sin(uTime * 0.2 + aSeed * 50.0)) * 0.35;
  vec3 from = aStart + swirl;
  vec3 arc = vec3(0.0, sin(t * 3.14159) * (0.4 + aSeed), sin(t * 3.14159) * 0.8);   // a gentle arc in flight
  vec3 p = mix(from, position, t) + arc * (1.0 - t * 0.5);
  p += (aStart - position) * uOut * (0.6 + aSeed);                                   // on the way back: scatter
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uPixelRatio * mix(0.9 + aSeed, 1.25, t) / -mv.z;
  vec3 ghost = vec3(0.45, 0.58, 1.0) * (0.25 + 0.45 * aSeed);
  vColor = mix(ghost, mix(ghost, tex * 0.75, has), t);
  // once the photo has resolved underneath, the points step back to a faint shimmer
  vAlpha = (0.3 + 0.45 * t) * (1.0 - uOut) * (1.0 - 0.88 * smoothstep(0.9, 1.0, a));
}`;

// a soft halo of light behind each final frame
const HALO_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uIntensity;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = pow(1.0 - smoothstep(0.0, 1.0, d), 2.2);
  gl_FragColor = vec4(vec3(0.42, 0.55, 1.0) * a * uIntensity, 1.0);
}`;
const UV_VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// film look: subtle chromatic aberration toward the edges, vignette and grain
const FILM_SHADER = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 } },
  vertexShader: UV_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime; varying vec2 vUv;
    float rand(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec2 off = c * r2 * 0.012;
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      col *= smoothstep(0.85, 0.15, r2 * 2.2);
      col += (rand(vUv * 1000.0 + fract(uTime)) - 0.5) * 0.035;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

// ------------------------------------------------------------------------------- the engine
export default class Engine {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private film: ShaderPass;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, 0.05, 200);
  private clock = new THREE.Clock();
  private raf = 0;
  private disposed = false;

  private head = new THREE.Group();
  private headMat?: THREE.ShaderMaterial;
  private dustMat?: THREE.ShaderMaterial;
  private yawHistory = new Float32Array(HISTORY);
  private pitchHistory = new Float32Array(HISTORY);
  private historyClock = 0;
  private starMat: THREE.ShaderMaterial;
  private skyMat: THREE.ShaderMaterial;
  private portraitMats: THREE.ShaderMaterial[] = [];
  private lineMats: THREE.LineBasicMaterial[] = [];
  private portraitGroups: THREE.Group[] = [];
  private path: THREE.CatmullRomCurve3;

  private pointer = new THREE.Vector2();
  private look = new THREE.Vector2();
  private progress = 0;
  private tween: { from: number; to: number; start: number; duration: number; ease: (t: number) => number; done?: () => void } | null = null;
  private mode: "landing" | "searching" | "arriving" | "gallery" | "returning" = "landing";

  private assembleMat!: THREE.ShaderMaterial;
  private photos: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  private finalFrameMats: THREE.LineBasicMaterial[] = [];
  private haloMats: THREE.ShaderMaterial[] = [];
  private assemble = [0, 0, 0];
  private assembleTarget = [0, 0, 0];
  private outTarget = 0;
  private onLayout?: (rects: FrameRect[]) => void;

  private frameTimes: number[] = [];
  private pixelRatio: number;

  constructor(private canvas: HTMLCanvasElement, private opts: { lowPower: boolean; reducedMotion: boolean }) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, opts.lowPower ? 1.25 : 1.75);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setClearColor(INK);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false,
      uniforms: { uTime: { value: 0 } },
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(120, 48, 24), this.skyMat));
    this.starMat = this.buildStars(opts.lowPower ? 1400 : 2600);

    this.scene.add(this.head);
    this.buildGallery();
    this.buildFinalFrames();
    this.path = this.buildPath(1.6);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.7, 0.22);
    this.composer.addPass(this.bloom);
    this.film = new ShaderPass(FILM_SHADER);
    this.composer.addPass(this.film);
    this.composer.addPass(new OutputPass());

    this.resize();
    this.placeCamera(0);
  }

  // ------------------------------------------------------------------------- public API
  async load(): Promise<void> {
    const buf = await (await fetch("/head-points.bin")).arrayBuffer();
    const total = new DataView(buf).getUint32(0, true);
    const count = this.opts.lowPower ? Math.min(total, 9000) : total;  // any prefix is an even subsample
    const pos16 = new Int16Array(buf, 4, total * 3);
    const nrm8 = new Int8Array(buf, 4 + total * 6, total * 3);
    const face: number[][] = [[], [], []];   // position, normal, seed
    const dust: number[][] = [[], [], []];
    for (let i = 0; i < count; i++) {
      const p = [pos16[i * 3] / 32767, pos16[i * 3 + 1] / 32767, pos16[i * 3 + 2] / 32767];
      const n = [nrm8[i * 3] / 127, nrm8[i * 3 + 1] / 127, nrm8[i * 3 + 2] / 127];
      // the shoulders and the back of the skull shed dust; a few stray points everywhere
      const isDust = (p[1] < -0.45 && Math.random() < 0.5) || (p[2] < -0.25 && Math.random() < 0.3) || Math.random() < 0.07;
      const into = isDust ? dust : face;
      into[0].push(...p);
      into[1].push(...n);
      into[2].push(Math.random());
    }
    const geometry = ([pos, nrm, seed]: number[][]) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
      geo.setAttribute("aSeed", new THREE.Float32BufferAttribute(seed, 1));
      return geo;
    };
    const common = {
      uTime: { value: 0 }, uBurst: { value: 0 }, uPixelRatio: { value: this.pixelRatio },
      uSize: { value: this.opts.lowPower ? 20 : 15 },
      uCool: { value: new THREE.Color("#8fb2ff") }, uWarm: { value: new THREE.Color("#ffe3c2") },
    };
    this.headMat = new THREE.ShaderMaterial({
      vertexShader: HEAD_VERT, fragmentShader: POINT_FRAG, uniforms: THREE.UniformsUtils.clone(common),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const facePts = new THREE.Points(geometry(face), this.headMat);
    facePts.scale.setScalar(HEAD_SCALE);
    this.head.add(facePts);

    this.dustMat = new THREE.ShaderMaterial({
      vertexShader: DUST_VERT, fragmentShader: POINT_FRAG,
      uniforms: {
        ...THREE.UniformsUtils.clone(common),
        uScale: { value: HEAD_SCALE }, uHeadPos: { value: new THREE.Vector3() },
        uYaw: { value: this.yawHistory }, uPitch: { value: this.pitchHistory },
      },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const dustPts = new THREE.Points(geometry(dust), this.dustMat);
    dustPts.frustumCulled = false;   // positions are computed in the shader, in world space
    this.scene.add(dustPts);
  }

  start() {
    const frame = () => {
      if (this.disposed) return;
      this.tick();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  setPointer(x: number, y: number) {
    this.pointer.set(x, y);
  }

  setLayoutListener(fn: (rects: FrameRect[]) => void) {
    this.onLayout = fn;
  }

  /** Disperse the head and glide through the gallery while the search runs. */
  startSearch() {
    this.mode = "searching";
    this.assembleTarget = [0, 0, 0];
    this.outTarget = 0;
    if (this.opts.reducedMotion) {
      this.progress = 0.8;
      return;
    }
    this.animateTo(0.66, 5.2, easeInOut);
  }

  /** Glide to the final frames and assemble the matches out of the particle cloud. */
  showResults(thumbnails: (string | null)[], onArrived: () => void) {
    this.setPhotos(thumbnails);
    this.mode = "arriving";
    const arrive = () => {
      this.mode = "gallery";
      RESULT_ORDER.forEach((frame, rank) => {
        window.setTimeout(() => (this.assembleTarget[frame] = 1), this.opts.reducedMotion ? 0 : rank * 380);
      });
      window.setTimeout(() => {
        onArrived();
        this.emitLayout();
      }, this.opts.reducedMotion ? 0 : 1700);
    };
    if (this.opts.reducedMotion) {
      this.progress = 1;
      this.assemble = [1, 1, 1];
      arrive();
      return;
    }
    const remaining = 1 - this.progress;
    this.animateTo(1, 1.6 + remaining * 4.5, easeOut, arrive);
  }

  /** Back to the head (after results, or when a search fails). */
  back(onDone?: () => void) {
    this.mode = "returning";
    this.outTarget = this.assemble.some((a) => a > 0.01) ? 1 : 0;
    const done = () => {
      this.mode = "landing";
      this.assemble = [0, 0, 0];
      this.assembleTarget = [0, 0, 0];
      this.outTarget = 0;
      this.assembleMat.uniforms.uOut.value = 0;
      onDone?.();
    };
    if (this.opts.reducedMotion) {
      this.progress = 0;
      done();
      return;
    }
    this.animateTo(0, 1.8 + this.progress * 2.4, easeInOut, done);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);  // also sizes the bloom pass's internal targets
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 0.8 ? 52 : 36;
    this.camera.updateProjectionMatrix();
    this.path = this.buildPath(w / h);
    if (this.mode === "gallery") this.emitLayout();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => {
        (x as THREE.MeshBasicMaterial).map?.dispose();
        x.dispose();
      });
    });
    this.composer.dispose();
    this.renderer.dispose();
  }

  // --------------------------------------------------------------------------- internals
  private animateTo(to: number, duration: number, ease: (t: number) => number, done?: () => void) {
    this.tween = { from: this.progress, to, start: this.clock.elapsedTime, duration, ease, done };
  }

  private tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    this.watchPerformance(dt);

    if (this.tween) {
      const k = Math.min((t - this.tween.start) / this.tween.duration, 1);
      this.progress = this.tween.from + (this.tween.to - this.tween.from) * this.tween.ease(k);
      if (k >= 1) {
        const done = this.tween.done;
        this.tween = null;
        done?.();
      }
    } else if (this.mode === "searching" && !this.opts.reducedMotion) {
      // still waiting for the answer (e.g. a cold start): keep drifting, ever more slowly
      this.progress += (0.86 - this.progress) * dt * 0.05;
    }

    // the head faces you and turns toward the cursor (only while we're facing it)
    const facing = 1 - smoothstep(0.02, 0.12, this.progress);
    const damp = 1 - Math.exp(-dt * 3.2);
    this.look.x += (this.pointer.x * facing - this.look.x) * damp;
    this.look.y += (this.pointer.y * facing - this.look.y) * damp;
    const yaw = this.opts.reducedMotion ? 0 : this.look.x * 0.62;
    const pitch = this.opts.reducedMotion ? 0 : -this.look.y * 0.3;
    this.head.rotation.set(pitch, yaw, 0, "YXZ");
    this.head.position.y = this.opts.reducedMotion ? 0 : Math.sin(t * 0.5) * 0.03;
    this.recordPose(yaw, pitch, dt);

    const burst = smoothstep(0.03, 0.2, this.progress);
    const time = this.opts.reducedMotion ? 4 : t;
    for (const mat of [this.headMat, this.dustMat]) {
      if (!mat) continue;
      mat.uniforms.uTime.value = time;
      mat.uniforms.uBurst.value = burst;
    }
    this.dustMat?.uniforms.uHeadPos.value.copy(this.head.position);
    this.head.visible = burst < 0.999;
    this.skyMat.uniforms.uTime.value = t;
    this.starMat.uniforms.uTime.value = t;

    // the gallery fades in as the head disperses
    const gallery = smoothstep(0.08, 0.3, this.progress);
    this.portraitMats.forEach((m) => {
      m.uniforms.uTime.value = t;
      m.uniforms.uFade.value = gallery;
    });
    // like haze: a portrait's outline only brightens as we approach it
    this.lineMats.forEach((m, i) => {
      const dist = this.camera.position.distanceTo(this.portraitGroups[i].position);
      m.opacity = 0.6 * gallery * smoothstep(22, 7, dist);
    });
    const finalVis = smoothstep(0.45, 0.85, this.progress);
    this.finalFrameMats.forEach((m, i) => (m.opacity = finalVis * (0.35 + 0.65 * this.assemble[i])));
    this.haloMats.forEach((m, i) => (m.uniforms.uIntensity.value = finalVis * (0.06 + 0.22 * this.assemble[i])));

    // assembling: each frame's points fly in; the photo resolves once they've landed
    for (let i = 0; i < 3; i++) {
      const target = this.assembleTarget[i];
      this.assemble[i] += (target - this.assemble[i]) * (1 - Math.exp(-dt * (target ? 1.15 : 3)));
      const resolve = smoothstep(0.82, 1.0, this.assemble[i]) * (1 - this.assembleMat.uniforms.uOut.value);
      this.photos[i].material.opacity = resolve * 0.92;
      this.photos[i].visible = resolve > 0.001;
    }
    const u = this.assembleMat.uniforms;
    u.uTime.value = t;
    u.uAssemble.value.set(this.assemble[0], this.assemble[1], this.assemble[2]);
    u.uOut.value += (this.outTarget - u.uOut.value) * (1 - Math.exp(-dt * 2.5));
    // the waiting cloud only shows near the end of the glide
    (this.assembleMat as THREE.ShaderMaterial).visible = finalVis > 0.01;

    // starlight wants a generous bloom; the resolved photos want almost none
    const resolved = Math.max(...this.assemble.map((a) => smoothstep(0.8, 1, a)));
    this.bloom.strength = 0.6 - 0.3 * resolved;
    this.bloom.threshold = 0.22 + 0.45 * resolved;

    this.placeCamera(this.progress);
    this.film.uniforms.uTime.value = t;
    this.composer.render(dt);
  }

  /** Remember the head's pose every HISTORY_STEP seconds (index 0 = now) for the dust trail. */
  private recordPose(yaw: number, pitch: number, dt: number) {
    this.historyClock += dt;
    if (this.historyClock >= HISTORY_STEP) {
      this.historyClock %= HISTORY_STEP;
      this.yawHistory.copyWithin(1, 0, HISTORY - 1);
      this.pitchHistory.copyWithin(1, 0, HISTORY - 1);
    }
    this.yawHistory[0] = yaw;
    this.pitchHistory[0] = pitch;
  }

  /** The camera path; its last point is set back far enough that all three frames fit the screen. */
  private buildPath(aspect: number) {
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const fitWidth = 3.4 / (Math.tan(halfFov) * aspect);   // the three frames plus a margin
    const fitHeight = 1.9 / Math.tan(halfFov);             // frames, title above, plaques below
    const back = Math.min(Math.max(fitWidth, fitHeight, 7.4), 14);
    const finalZ = WALL_Z + back;
    const route = [
      new THREE.Vector3(0, 0.15, 6.4),
      new THREE.Vector3(0, 0.12, 2.2),
      new THREE.Vector3(0.1, 0.15, -3),
      new THREE.Vector3(-0.6, 0.3, -9),
      new THREE.Vector3(0.6, 0.42, -15),
    ].filter((v) => v.z > finalZ + 2);   // a stop set further back (narrow screens) cuts the route short
    return new THREE.CatmullRomCurve3([...route, new THREE.Vector3(0, 0.55, finalZ)], false, "centripetal");
  }

  private placeCamera(p: number) {
    const pos = this.path.getPointAt(p);
    this.camera.position.copy(pos);
    const ahead = this.path.getPointAt(Math.min(p + 0.035, 1));
    const wall = new THREE.Vector3(0, 0.6, WALL_Z);
    const head = new THREE.Vector3(0, 0.1, 0);
    const target = ahead.clone();
    target.lerp(head, 1 - smoothstep(0.0, 0.08, p));
    target.lerp(wall, smoothstep(0.8, 1.0, p));
    const t = this.clock.elapsedTime;
    if (!this.opts.reducedMotion) {   // a slow handheld drift, so even a still camera feels alive
      this.camera.position.x += Math.sin(t * 0.31) * 0.025;
      this.camera.position.y += Math.sin(t * 0.43) * 0.02;
    }
    this.camera.lookAt(target);
  }

  private watchPerformance(dt: number) {
    // if frames are slow for a couple of seconds, render fewer pixels (once)
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 120) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes = [];
    if (avg > 1 / 40 && this.pixelRatio > 1) {
      this.pixelRatio = 1;
      this.renderer.setPixelRatio(1);
      this.composer.setPixelRatio(1);
      for (const m of [this.headMat, this.dustMat, this.starMat, this.assembleMat]) {
        if (m) m.uniforms.uPixelRatio.value = 1;
      }
      this.resize();
    }
  }

  private emitLayout() {
    if (!this.onLayout) return;
    const w = window.innerWidth, h = window.innerHeight;
    const cam = this.camera.clone();
    cam.position.copy(this.path.getPointAt(1));
    cam.lookAt(0, 0.6, WALL_Z);
    cam.updateMatrixWorld();
    const rects = RESULT_ORDER.map((frame) => {
      const f = FINAL_FRAMES[frame];
      const half = f.s / 2 + 0.08;
      const a = new THREE.Vector3(f.x - half, f.y + half, WALL_Z).project(cam);
      const b = new THREE.Vector3(f.x + half, f.y - half, WALL_Z).project(cam);
      const x0 = (a.x + 1) / 2 * w, y0 = (1 - a.y) / 2 * h, x1 = (b.x + 1) / 2 * w, y1 = (1 - b.y) / 2 * h;
      return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    });
    this.onLayout(rects);
  }

  private buildStars(count: number) {
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const r = 25 + Math.random() * 70;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.7, r * Math.sin(ph) * Math.sin(th)], i * 3);
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT, fragmentShader: POINT_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: this.pixelRatio } },
    });
    this.scene.add(new THREE.Points(geo, mat));
    return mat;
  }

  /** A rectangle (or two, nested) drawn in thin additive light. */
  private lightFrame(w: number, h: number, opacity: number, double = false) {
    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color("#b9cbff").multiplyScalar(1.6), transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const rect = (hw: number, hh: number) =>
      new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-hw, -hh, 0), new THREE.Vector3(hw, -hh, 0),
        new THREE.Vector3(hw, hh, 0), new THREE.Vector3(-hw, hh, 0),
      ]), mat);
    const g = new THREE.Group();
    g.add(rect(w / 2, h / 2));
    if (double) g.add(rect(w / 2 + 0.06, h / 2 + 0.06));
    return { group: g, mat };
  }

  // ---------------------------------------------------------------- the gallery of light
  private buildGallery() {
    const geo = new THREE.PlaneGeometry(1, 1.3);
    // alternate sides and heights, so frames at different depths never line up in view
    const spots = [
      [-2.6, 0.9, -6.5, 0.5], [2.8, -0.4, -9, -0.45], [-3.0, -0.6, -11.5, 0.4], [3.0, 1.3, -14, -0.45],
      [-2.7, 1.5, -16.5, 0.35], [3.2, -0.7, -19, -0.4], [-3.3, 0.2, -21.5, 0.4], [3.4, 1.0, -24, -0.3],
      [-4.4, -0.9, -26.5, 0.25], [4.6, 1.8, -27.5, -0.2],
    ];
    spots.forEach(([x0, y, z, ry], i) => {
      const x = x0 * 1.2;  // wide of the flight line, so they pass either side
      const scale = 0.85 + ((i * 37) % 5) * 0.09;
      const mat = new THREE.ShaderMaterial({
        vertexShader: PORTRAIT_VERT, fragmentShader: PORTRAIT_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uTime: { value: 0 }, uFade: { value: 0 }, uSeed: { value: (i * 0.618) % 1 } },
      });
      const portrait = new THREE.Mesh(geo, mat);
      const { group: frame, mat: lineMat } = this.lightFrame(1.14, 1.44, 0);
      frame.position.z = -0.01;
      const g = new THREE.Group();
      g.add(portrait, frame);
      g.position.set(x, y, z);
      g.rotation.y = ry;
      g.scale.setScalar(scale);
      this.scene.add(g);
      this.portraitMats.push(mat);
      this.lineMats.push(lineMat);
      this.portraitGroups.push(g);
    });
  }

  private buildFinalFrames() {
    const n = GRID * GRID;
    const total = n * 3;
    const position = new Float32Array(total * 3);
    const start = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    const frameIdx = new Float32Array(total);
    const seed = new Float32Array(total);
    // the waiting cloud: a loose nebula in front of the frames
    const cloudCentre = new THREE.Vector3(0, 0.6, WALL_Z + 1.6);
    FINAL_FRAMES.forEach((f, k) => {
      for (let j = 0; j < GRID; j++) {
        for (let i = 0; i < GRID; i++) {
          const idx = k * n + j * GRID + i;
          const u = (i + 0.5) / GRID, v = (j + 0.5) / GRID;
          position.set([f.x + (u - 0.5) * f.s, f.y + (v - 0.5) * f.s, WALL_Z + 0.02], idx * 3);
          uv.set([u, v], idx * 2);
          // each frame's points wait in a loose cloud drifting in front of their own frame
          const r = 0.5 + Math.pow(Math.random(), 0.7) * 1.4;
          const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
          start.set([
            cloudCentre.x + f.x * 0.75 + r * Math.sin(ph) * Math.cos(th) * 1.1,
            cloudCentre.y + (f.y - 0.6) + r * Math.cos(ph) * 0.55,
            cloudCentre.z + r * Math.sin(ph) * Math.sin(th) * 0.5,
          ], idx * 3);
          frameIdx[idx] = k;
          seed[idx] = Math.random();
        }
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geo.setAttribute("aStart", new THREE.BufferAttribute(start, 3));
    geo.setAttribute("aUv", new THREE.BufferAttribute(uv, 2));
    geo.setAttribute("aFrame", new THREE.BufferAttribute(frameIdx, 1));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    const blank = new THREE.DataTexture(new Uint8Array([140, 150, 170, 255]), 1, 1);
    blank.needsUpdate = true;
    this.assembleMat = new THREE.ShaderMaterial({
      vertexShader: ASSEMBLE_VERT, fragmentShader: POINT_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 }, uSize: { value: this.opts.lowPower ? 19 : 14 }, uPixelRatio: { value: this.pixelRatio },
        uOut: { value: 0 }, uAssemble: { value: new THREE.Vector3() }, uHasPhoto: { value: new THREE.Vector3() },
        uTex0: { value: blank }, uTex1: { value: blank }, uTex2: { value: blank },
      },
    });
    const pts = new THREE.Points(geo, this.assembleMat);
    pts.frustumCulled = false;
    this.scene.add(pts);

    FINAL_FRAMES.forEach((f) => {
      const halo = new THREE.ShaderMaterial({
        vertexShader: UV_VERT, fragmentShader: HALO_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uIntensity: { value: 0 } },
      });
      const haloMesh = new THREE.Mesh(new THREE.PlaneGeometry(f.s * 2.6, f.s * 2.6), halo);
      haloMesh.position.set(f.x, f.y, WALL_Z - 0.05);
      this.scene.add(haloMesh);
      this.haloMats.push(halo);

      const photo = new THREE.Mesh(
        new THREE.PlaneGeometry(f.s, f.s),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
      );
      photo.position.set(f.x, f.y, WALL_Z + 0.01);
      photo.visible = false;
      this.scene.add(photo);
      this.photos.push(photo);

      const { group, mat } = this.lightFrame(f.s + 0.14, f.s + 0.14, 0, true);
      group.position.set(f.x, f.y, WALL_Z + 0.03);
      this.scene.add(group);
      this.finalFrameMats.push(mat);
    });
  }

  private setPhotos(thumbnails: (string | null)[]) {
    const loader = new THREE.TextureLoader();
    const uniforms = [this.assembleMat.uniforms.uTex0, this.assembleMat.uniforms.uTex1, this.assembleMat.uniforms.uTex2];
    const has = this.assembleMat.uniforms.uHasPhoto.value as THREE.Vector3;
    has.set(0, 0, 0);
    RESULT_ORDER.forEach((frame, rank) => {
      const src = thumbnails[rank];
      if (!src) return;
      loader.load(src, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        const photo = this.photos[frame];
        photo.material.map?.dispose();
        photo.material.map = tex;
        photo.material.needsUpdate = true;
        uniforms[frame].value = tex;
        has.setComponent(frame, 1);
      });
    });
  }
}
