/**
 * The 3D experience, one continuous night-space world:
 *
 *  1. A head of light (points sampled from a scan) that faces you and turns to follow the cursor.
 *     The face is rigid; the dust it sheds lives in world space, so it trails off like smoke.
 *  2. On Find the head disperses past the camera and we cruise, at a steady speed, through an
 *     endless gallery of light: portraits drawn as dots inside thin frames of light, recycled
 *     from behind the camera to far ahead, so the flight can last as long as the search does.
 *  3. Once the matches are in, we cruise one more stretch, then bank round to a composition that
 *     was placed off to the side, out of sight: your photo in the centre, the three matches in a
 *     triangle around it, joined by lines of light. Each assembles out of a particle cloud
 *     (every point coloured from its photo), then the real photos resolve.
 *
 * Plain three.js; page.tsx drives it through startSearch / showResults / back.
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

const START = new THREE.Vector3(0, 0.15, 6.4);
const CRUISE_SPEED = 4.2;      // units per second while the search runs
const MIN_CRUISE = 15;         // units: even an instant answer gets a short flight first
const ONE_MORE = 9;            // units: once the matches are in, one more stretch of gallery
const TURN_TIME = 3.2;         // seconds to bank round to the composition
const LOOP = 30;               // length of the recycled gallery band

// the composition, in its own plane (x right, y up, facing the camera): you in the centre,
// the best match above, the other two lower left and right
const FRAMES = [
  { x: 0, y: 1.5, s: 1.25 },     // matches[0]
  { x: -2.6, y: -0.75, s: 1.05 },  // matches[1]
  { x: 2.6, y: -0.75, s: 1.05 },   // matches[2]
  { x: 0, y: -0.45, s: 0.95 },     // you
];
const YOU = 3;
const COMPOSITION_CENTRE_Y = 0.55;   // look a little above the middle: the title sits overhead
const GRID = 64;                 // assembly points per frame side (64 x 64)

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------------------------------- shaders
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
  vec3 away = normalize(p + vec3(0.0, 0.0, 0.35)) * (0.6 + aSeed);       // the burst
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
  mat3 r = rotYX(mix(uYaw[i], uYaw[i + 1], f), mix(uPitch[i], uPitch[i + 1], f));
  vec3 born = r * position * uScale;
  vec3 n = r * normal;
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

// stars wrap around the camera, so the starfield is endless but keeps its parallax
const STAR_VERT = /* glsl */ `
attribute float aSeed;
uniform float uTime, uPixelRatio;
uniform vec3 uCam;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec3 rel = mod(position - uCam + 60.0, 120.0) - 60.0;
  vec4 mv = viewMatrix * vec4(uCam + rel, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (1.0 + 2.2 * aSeed * aSeed) * uPixelRatio;
  vColor = mix(vec3(0.62, 0.72, 1.0), vec3(1.0, 0.9, 0.78), aSeed);
  float twinkle = 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * (0.6 + aSeed * 2.0) + aSeed * 90.0));
  vAlpha = twinkle * smoothstep(60.0, 40.0, length(rel)) * smoothstep(1.5, 6.0, length(rel));
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
  float near = smoothstep(26.0, 8.0, vDist) * smoothstep(0.5, 2.5, vDist);   // fade in from the haze
  vec3 col = mix(vec3(0.45, 0.58, 1.0), vec3(1.0, 0.92, 0.82), s * 0.5);
  gl_FragColor = vec4(col * dotA * uFade * near, 1.0);
}`;

// the assembly: each point flies from a cloud to its pixel in a frame, coloured by the photo
const ASSEMBLE_VERT = /* glsl */ `
attribute vec3 aStart;
attribute vec2 aUv;
attribute float aFrame;
attribute float aSeed;
uniform float uTime, uSize, uPixelRatio, uOut;
uniform vec4 uAssemble;           // progress per frame
uniform vec4 uHasPhoto;
uniform sampler2D uTex0, uTex1, uTex2, uTex3;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float a, has; vec3 tex;
  if (aFrame < 0.5)      { a = uAssemble.x; has = uHasPhoto.x; tex = texture2D(uTex0, aUv).rgb; }
  else if (aFrame < 1.5) { a = uAssemble.y; has = uHasPhoto.y; tex = texture2D(uTex1, aUv).rgb; }
  else if (aFrame < 2.5) { a = uAssemble.z; has = uHasPhoto.z; tex = texture2D(uTex2, aUv).rgb; }
  else                   { a = uAssemble.w; has = uHasPhoto.w; tex = texture2D(uTex3, aUv).rgb; }
  // each point leaves at its own moment, so the image fills in like a wave
  float t = clamp((a - aSeed * 0.45) / 0.55, 0.0, 1.0);
  t = t * t * (3.0 - 2.0 * t);
  vec3 swirl = vec3(sin(uTime * 0.3 + aSeed * 30.0), cos(uTime * 0.25 + aSeed * 20.0), sin(uTime * 0.2 + aSeed * 50.0)) * 0.35;
  vec3 arc = vec3(0.0, sin(t * 3.14159) * (0.4 + aSeed), sin(t * 3.14159) * 0.8);
  vec3 p = mix(aStart + swirl, position, t) + arc * (1.0 - t * 0.5);
  p += (aStart - position) * uOut * (0.6 + aSeed);                     // on the way out: scatter
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uPixelRatio * mix(0.9 + aSeed, 1.25, t) / -mv.z;
  vec3 ghost = vec3(0.45, 0.58, 1.0) * (0.25 + 0.45 * aSeed);
  vColor = mix(ghost, mix(ghost, tex * 0.75, has), t);
  // once the photo has resolved underneath, the points step back to a faint shimmer
  vAlpha = (0.3 + 0.45 * t) * (1.0 - uOut) * (1.0 - 0.94 * smoothstep(0.9, 1.0, a));
}`;

const HALO_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uIntensity;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = pow(1.0 - smoothstep(0.0, 1.0, d), 2.2);
  gl_FragColor = vec4(vec3(0.42, 0.55, 1.0) * a * uIntensity, 1.0);
}`;
const UV_VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// film look: subtle chromatic aberration toward the edges, vignette, grain, and a fade to black
const FILM_SHADER = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uBlack: { value: 0 } },
  vertexShader: UV_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime, uBlack; varying vec2 vUv;
    float rand(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec2 off = c * r2 * 0.012;
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      col *= smoothstep(0.85, 0.15, r2 * 2.2);
      col += (rand(vUv * 1000.0 + fract(uTime)) - 0.5) * 0.035;
      gl_FragColor = vec4(col * (1.0 - uBlack), 1.0);
    }`,
};

type Mode = "landing" | "cruise" | "turning" | "arrived" | "leaving";

// ------------------------------------------------------------------------------- the engine
export default class Engine {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private film: ShaderPass;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, 0.05, 200);
  private clock = new THREE.Timer();
  private raf = 0;
  private disposed = false;

  private head = new THREE.Group();
  private headMat?: THREE.ShaderMaterial;
  private dustMat?: THREE.ShaderMaterial;
  private yawHistory = new Float32Array(HISTORY);
  private pitchHistory = new Float32Array(HISTORY);
  private historyClock = 0;
  private sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  private starMat: THREE.ShaderMaterial;

  // the endless gallery
  private portraits: { group: THREE.Group; mat: THREE.ShaderMaterial; line: THREE.LineBasicMaterial; offset: number; x: number; y: number; ry: number }[] = [];
  private galleryFade = 0;

  // flight state
  private mode: Mode = "landing";
  private travelled = 0;           // units flown since Find
  private speed = 0;
  private turnAt = Infinity;       // travelled distance at which to start the turn
  private turn: { start: number; p0: THREE.Vector3; b1: THREE.Vector3; b2: THREE.Vector3; p1: THREE.Vector3; look0: THREE.Vector3; look1: THREE.Vector3 } | null = null;
  private arrivedCallback: (() => void) | null = null;
  private black = 0;
  private blackTarget = 0;
  private reform = 0;              // 1 -> 0 as the head re-forms after coming back
  private pointer = new THREE.Vector2();
  private look = new THREE.Vector2();
  private roll = 0;
  private lookTarget = new THREE.Vector3();

  // the composition
  private composition = new THREE.Group();
  private assembleMat!: THREE.ShaderMaterial;
  private photos: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  private frameMats: THREE.LineBasicMaterial[] = [];
  private linkMats: THREE.LineBasicMaterial[] = [];
  private haloMats: THREE.ShaderMaterial[] = [];
  private assemble = [0, 0, 0, 0];
  private assembleTarget = [0, 0, 0, 0];
  private outTarget = 0;
  private timers: number[] = [];
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
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(120, 48, 24), this.skyMat);
    this.scene.add(this.sky);
    this.starMat = this.buildStars(opts.lowPower ? 1600 : 3000);

    this.scene.add(this.head);
    this.buildGallery();
    this.buildComposition();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.7, 0.22);
    this.composer.addPass(this.bloom);
    this.film = new ShaderPass(FILM_SHADER);
    this.composer.addPass(this.film);
    this.composer.addPass(new OutputPass());

    this.camera.position.copy(START);
    this.lookTarget.set(0, 0.1, 0);
    this.resize();
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

  /** Disperse the head and cruise through the gallery until the matches are in. */
  startSearch() {
    this.clearTimers();
    this.mode = "cruise";
    this.travelled = 0;
    this.speed = 0;
    this.turnAt = Infinity;
    this.arrivedCallback = null;
    this.assemble = [0, 0, 0, 0];
    this.assembleTarget = [0, 0, 0, 0];
    this.outTarget = 0;
    this.assembleMat.uniforms.uOut.value = 0;
    this.composition.visible = false;
    if (this.opts.reducedMotion) this.travelled = 14;   // a still view inside the gallery
  }

  /**
   * The matches are in: fly one more stretch, then bank round to the composition (placed off to
   * the side only now, so it was never visible in the distance) and assemble it.
   */
  showResults(thumbnails: (string | null)[], userPhoto: string | null, onArrived: () => void) {
    this.setPhotos(thumbnails, userPhoto);
    this.arrivedCallback = onArrived;
    this.turnAt = Math.max(this.travelled + ONE_MORE, MIN_CRUISE);
    if (this.opts.reducedMotion) this.beginTurn(true);
  }

  /** Back to the head (after results, or when a search fails): a fade through black. */
  back(onDone?: () => void) {
    this.clearTimers();
    this.mode = "leaving";
    this.outTarget = 1;
    this.arrivedCallback = null;
    const reset = () => {
      this.mode = "landing";
      this.travelled = 0;
      this.speed = 0;
      this.turn = null;
      this.turnAt = Infinity;
      this.composition.visible = false;
      this.assemble = [0, 0, 0, 0];
      this.assembleTarget = [0, 0, 0, 0];
      this.outTarget = 0;
      this.assembleMat.uniforms.uOut.value = 0;
      this.camera.position.copy(START);
      this.lookTarget.set(0, 0.1, 0);
      this.reform = this.opts.reducedMotion ? 0 : 1;
      this.blackTarget = 0;
      onDone?.();
    };
    if (this.opts.reducedMotion) {
      reset();
      return;
    }
    this.blackTarget = 1;
    this.timers.push(window.setTimeout(reset, 750));
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);  // also sizes the bloom pass's internal targets
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 0.8 ? 52 : 36;
    this.camera.updateProjectionMatrix();
    if (this.mode === "arrived" && this.turn) {
      // keep the whole composition in view at the new aspect ratio
      this.turn.p1.copy(this.viewpointFor(this.composition));
      this.emitLayout();
    }
  }

  dispose() {
    this.disposed = true;
    this.clearTimers();
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
    this.clock.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }

  // --------------------------------------------------------------------------- internals
  private clearTimers() {
    this.timers.forEach((id) => window.clearTimeout(id));
    this.timers = [];
  }

  private tick() {
    this.clock.update();
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.getElapsed();
    this.watchPerformance(dt);
    const still = this.opts.reducedMotion;

    // ---- flight
    if (this.mode === "cruise") {
      if (!still) {
        this.speed += (CRUISE_SPEED - this.speed) * (1 - Math.exp(-dt * 0.9));
        this.travelled += this.speed * dt;
      }
      if (this.travelled >= this.turnAt) this.beginTurn(false);
    }
    const cam = this.camera;
    if (this.mode === "landing" || this.mode === "cruise") {
      cruisePoint(this.travelled, cam.position);
      // look along the path, a little way ahead, so the camera banks with each weave
      const ahead = cruisePoint(this.travelled + 12, new THREE.Vector3());
      ahead.y += 0.1;
      this.lookTarget.lerpVectors(new THREE.Vector3(0, 0.1, 0), ahead, smoothstep(0, 4, this.travelled));
    } else if (this.mode === "turning" && this.turn) {
      const u = Math.min((t - this.turn.start) / TURN_TIME, 1);
      const s = 1 - (1 - u) * (1 - u);   // starts at cruising speed, eases to a stop
      cubic(this.turn.p0, this.turn.b1, this.turn.b2, this.turn.p1, s, cam.position);
      this.lookTarget.lerpVectors(this.turn.look0, this.turn.look1, smoothstep(0.1, 0.8, u));
      if (u >= 1) this.arrive();
    } else if (this.mode === "arrived" && this.turn) {
      cam.position.lerp(this.turn.p1, 1 - Math.exp(-dt * 3));
      this.lookTarget.lerp(this.turn.look1, 1 - Math.exp(-dt * 3));
    }
    if (!still) {   // a slow handheld drift, so even a still camera feels alive
      cam.position.x += Math.sin(t * 0.31) * 0.02;
      cam.position.y += Math.sin(t * 0.43) * 0.016;
    }
    cam.lookAt(this.lookTarget);
    // roll into the weave while cruising, level out for the turn
    const rollTarget = this.mode === "cruise" && !still ? cruiseRoll(this.travelled) : 0;
    this.roll += (rollTarget - this.roll) * (1 - Math.exp(-dt * 2));
    cam.rotateZ(this.roll);
    this.sky.position.copy(cam.position);
    this.starMat.uniforms.uCam.value.copy(cam.position);

    // ---- the head
    const facing = this.mode === "landing" ? 1 : 0;
    const damp = 1 - Math.exp(-dt * 3.2);
    this.look.x += (this.pointer.x * facing - this.look.x) * damp;
    this.look.y += (this.pointer.y * facing - this.look.y) * damp;
    const yaw = still ? 0 : this.look.x * 0.62;
    const pitch = still ? 0 : -this.look.y * 0.3;
    this.head.rotation.set(pitch, yaw, 0, "YXZ");
    this.head.position.y = still ? 0 : Math.sin(t * 0.5) * 0.03;
    this.recordPose(yaw, pitch, dt);
    this.reform = Math.max(0, this.reform - dt / 1.4);
    const burst = this.mode === "landing" ? this.reform * this.reform : smoothstep(0.2, 4.0, this.travelled);
    for (const mat of [this.headMat, this.dustMat]) {
      if (!mat) continue;
      mat.uniforms.uTime.value = still ? 4 : t;
      mat.uniforms.uBurst.value = burst;
    }
    this.dustMat?.uniforms.uHeadPos.value.copy(this.head.position);
    this.head.visible = burst < 0.999;

    // ---- the gallery: recycled around the camera while cruising, fading out as we turn
    const galleryTarget = this.mode === "cruise" ? smoothstep(1, 6, this.travelled) : 0;
    this.galleryFade += (galleryTarget - this.galleryFade) * (1 - Math.exp(-dt * (galleryTarget ? 1.5 : 1.2)));
    const camZ = START.z - this.travelled;
    for (const p of this.portraits) {
      if (this.mode === "landing" || this.mode === "cruise") {
        const ahead = -4 + ((((p.offset - this.travelled) % LOOP) + LOOP) % LOOP);
        p.group.position.set(p.x, p.y, camZ - ahead);
      }
      p.mat.uniforms.uTime.value = t;
      p.mat.uniforms.uFade.value = this.galleryFade;
      const dist = cam.position.distanceTo(p.group.position);
      p.line.opacity = 0.6 * this.galleryFade * smoothstep(22, 7, dist) * smoothstep(0.5, 2.5, dist);
      p.group.visible = this.galleryFade > 0.002;
    }
    this.skyMat.uniforms.uTime.value = t;
    this.starMat.uniforms.uTime.value = t;

    // ---- the composition
    for (let i = 0; i < 4; i++) {
      const target = this.assembleTarget[i];
      this.assemble[i] += (target - this.assemble[i]) * (1 - Math.exp(-dt * (target ? 1.15 : 3)));
      const resolve = smoothstep(0.82, 1.0, this.assemble[i]) * (1 - this.assembleMat.uniforms.uOut.value);
      this.photos[i].material.opacity = resolve * 0.92;
      this.photos[i].visible = resolve > 0.001;
      const on = this.assemble[i];
      this.frameMats[i].opacity = 0.25 + 0.75 * on;
      this.haloMats[i].uniforms.uIntensity.value = 0.05 + 0.13 * on;
      if (i < 3) this.linkMats[i].opacity = 0.5 * smoothstep(0.6, 1.0, Math.min(on, this.assemble[YOU]));
    }
    const u = this.assembleMat.uniforms;
    u.uTime.value = t;
    u.uAssemble.value.set(...(this.assemble as [number, number, number, number]));
    u.uOut.value += (this.outTarget - u.uOut.value) * (1 - Math.exp(-dt * 2.5));

    // starlight wants a generous bloom; resolved photos want almost none
    const resolved = Math.max(...this.assemble.map((a) => smoothstep(0.8, 1, a)));
    this.bloom.strength = 0.6 - 0.42 * resolved;
    this.bloom.threshold = 0.22 + 0.58 * resolved;

    this.black += (this.blackTarget - this.black) * (1 - Math.exp(-dt * 7));
    this.film.uniforms.uBlack.value = this.black;
    this.film.uniforms.uTime.value = t;
    this.composer.render(dt);
  }

  /** Place the composition off to the right of the flight line and bank round to face it. */
  private beginTurn(instant: boolean) {
    const p0 = cruisePoint(this.travelled, new THREE.Vector3());
    const forward = new THREE.Vector3(0, 0, -1);
    const right = new THREE.Vector3(1, 0, 0);
    // the composition sits well to the right and ahead: 90 degrees off the flight line, so it
    // can't have been seen until we turn toward it
    const centre = p0.clone().addScaledVector(forward, 8).addScaledVector(right, 14);
    centre.y = 0.35;
    this.composition.position.copy(centre);
    this.composition.lookAt(centre.clone().sub(right));   // facing back toward the flight line
    this.composition.updateMatrixWorld(true);
    this.composition.visible = true;

    const p1 = this.viewpointFor(this.composition);
    const look1 = this.composition.localToWorld(new THREE.Vector3(0, COMPOSITION_CENTRE_Y, 0));
    // match the cruising speed at the start of the curve (s = 1-(1-u)^2 has slope 2 at u = 0)
    const lead = (this.speed || CRUISE_SPEED) * TURN_TIME / 6;
    this.turn = {
      start: this.clock.getElapsed(), p0,
      b1: p0.clone().addScaledVector(forward, lead),
      b2: p1.clone().addScaledVector(right, -3),
      p1, look0: this.lookTarget.clone(), look1,
    };
    this.mode = "turning";
    if (instant) {
      this.camera.position.copy(p1);
      this.lookTarget.copy(look1);
      this.assemble = [1, 1, 1, 1];
      this.arrive();
    }
  }

  /** Where the camera stops: straight in front of the composition, far enough to fit it all. */
  private viewpointFor(group: THREE.Group) {
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const fitWidth = 4.1 / (Math.tan(halfFov) * this.camera.aspect);
    const fitHeight = 3.5 / Math.tan(halfFov);
    const back = Math.min(Math.max(fitWidth, fitHeight, 8.5), 19);
    return group.localToWorld(new THREE.Vector3(0, COMPOSITION_CENTRE_Y, back));
  }

  private arrive() {
    this.mode = "arrived";
    // you first, then the matches, best first
    const order = [YOU, 0, 1, 2];
    order.forEach((frame, k) => {
      this.timers.push(window.setTimeout(() => (this.assembleTarget[frame] = 1), this.opts.reducedMotion ? 0 : k * 420));
    });
    this.timers.push(window.setTimeout(() => {
      this.arrivedCallback?.();
      this.arrivedCallback = null;
      this.emitLayout();
    }, this.opts.reducedMotion ? 0 : 2100));
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

  /** Screen rectangles of the four frames (matches 0..2, then you), for the HTML plaques. */
  private emitLayout() {
    if (!this.onLayout || !this.turn) return;
    const w = window.innerWidth, h = window.innerHeight;
    const cam = this.camera.clone();
    cam.position.copy(this.turn.p1);
    cam.lookAt(this.turn.look1);
    cam.updateMatrixWorld();
    const rects = FRAMES.map((f) => {
      const half = f.s / 2 + (f === FRAMES[YOU] ? 0.07 : 0.13);   // the outer light frame
      const a = this.composition.localToWorld(new THREE.Vector3(f.x - half, f.y + half, 0)).project(cam);
      const b = this.composition.localToWorld(new THREE.Vector3(f.x + half, f.y - half, 0)).project(cam);
      const x0 = (Math.min(a.x, b.x) + 1) / 2 * w, x1 = (Math.max(a.x, b.x) + 1) / 2 * w;
      const y0 = (1 - Math.max(a.y, b.y)) / 2 * h, y1 = (1 - Math.min(a.y, b.y)) / 2 * h;
      return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    });
    this.onLayout(rects);
  }

  private buildStars(count: number) {
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos.set([(Math.random() - 0.5) * 120, (Math.random() - 0.5) * 84, (Math.random() - 0.5) * 120], i * 3);
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT, fragmentShader: POINT_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: this.pixelRatio }, uCam: { value: new THREE.Vector3() } },
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.scene.add(pts);
    return mat;
  }

  /** A rectangle (or two, nested) drawn in thin additive light. */
  private lightFrame(w: number, h: number, double = false) {
    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color("#b9cbff").multiplyScalar(1.6), transparent: true, opacity: 0,
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
    // alternate sides and heights; positions repeat every LOOP units of flight
    const spots = [
      [-3.1, 0.9, 0.5], [3.4, -0.4, -0.45], [-3.6, -0.6, 0.4], [3.6, 1.3, -0.45], [-3.2, 1.5, 0.35],
      [3.8, -0.7, -0.4], [-4.0, 0.2, 0.4], [4.1, 1.0, -0.3], [-3.4, -0.9, 0.3], [3.3, 1.7, -0.25],
    ];
    spots.forEach(([x, y, ry], i) => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: PORTRAIT_VERT, fragmentShader: PORTRAIT_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uTime: { value: 0 }, uFade: { value: 0 }, uSeed: { value: (i * 0.618) % 1 } },
      });
      const portrait = new THREE.Mesh(geo, mat);
      const { group: frame, mat: line } = this.lightFrame(1.14, 1.44);
      frame.position.z = -0.01;
      const group = new THREE.Group();
      group.add(portrait, frame);
      group.rotation.y = ry;
      group.scale.setScalar(0.85 + ((i * 37) % 5) * 0.09);
      group.visible = false;
      this.scene.add(group);
      this.portraits.push({ group, mat, line, offset: (i / spots.length) * LOOP + 6, x, y, ry });
    });
  }

  private buildComposition() {
    const g = this.composition;
    g.visible = false;
    this.scene.add(g);
    const n = GRID * GRID;
    const total = n * FRAMES.length;
    const position = new Float32Array(total * 3);
    const start = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    const frameIdx = new Float32Array(total);
    const seed = new Float32Array(total);
    FRAMES.forEach((f, k) => {
      for (let j = 0; j < GRID; j++) {
        for (let i = 0; i < GRID; i++) {
          const idx = k * n + j * GRID + i;
          const u = (i + 0.5) / GRID, v = (j + 0.5) / GRID;
          position.set([f.x + (u - 0.5) * f.s, f.y + (v - 0.5) * f.s, 0.02], idx * 3);
          uv.set([u, v], idx * 2);
          // each frame's points wait in a loose cloud drifting in front of their own frame
          const r = 0.4 + Math.pow(Math.random(), 0.7) * 1.2;
          const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
          start.set([
            f.x * 0.8 + r * Math.sin(ph) * Math.cos(th),
            f.y * 0.8 + r * Math.cos(ph) * 0.55,
            1.4 + r * Math.sin(ph) * Math.sin(th) * 0.5,
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
        uOut: { value: 0 }, uAssemble: { value: new THREE.Vector4() }, uHasPhoto: { value: new THREE.Vector4() },
        uTex0: { value: blank }, uTex1: { value: blank }, uTex2: { value: blank }, uTex3: { value: blank },
      },
    });
    const pts = new THREE.Points(geo, this.assembleMat);
    pts.frustumCulled = false;
    g.add(pts);

    FRAMES.forEach((f, k) => {
      const halo = new THREE.ShaderMaterial({
        vertexShader: UV_VERT, fragmentShader: HALO_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uIntensity: { value: 0 } },
      });
      const haloMesh = new THREE.Mesh(new THREE.PlaneGeometry(f.s * 2.6, f.s * 2.6), halo);
      haloMesh.position.set(f.x, f.y, -0.05);
      g.add(haloMesh);
      this.haloMats.push(halo);

      const photo = new THREE.Mesh(
        new THREE.PlaneGeometry(f.s, f.s),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
      );
      photo.position.set(f.x, f.y, 0.01);
      photo.visible = false;
      g.add(photo);
      this.photos.push(photo);

      const { group, mat } = this.lightFrame(f.s + 0.14, f.s + 0.14, k !== YOU);
      group.position.set(f.x, f.y, 0.03);
      g.add(group);
      this.frameMats.push(mat);
    });

    // lines of light from you to each match, edge to edge
    const you = FRAMES[YOU];
    for (let k = 0; k < 3; k++) {
      const f = FRAMES[k];
      const a = new THREE.Vector3(you.x, you.y, 0.02);
      const b = new THREE.Vector3(f.x, f.y, 0.02);
      const dir = b.clone().sub(a).normalize();
      const from = a.clone().addScaledVector(dir, edgeDistance(dir, you.s / 2 + 0.16));
      const to = b.clone().addScaledVector(dir, -edgeDistance(dir, f.s / 2 + 0.16));
      const mat = new THREE.LineBasicMaterial({
        color: new THREE.Color("#c9d6ff").multiplyScalar(1.4), transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([from, to]), mat));
      this.linkMats.push(mat);
    }
  }

  private setPhotos(thumbnails: (string | null)[], userPhoto: string | null) {
    const u = this.assembleMat.uniforms;
    const slots = [u.uTex0, u.uTex1, u.uTex2, u.uTex3];
    const has = u.uHasPhoto.value as THREE.Vector4;
    has.set(0, 0, 0, 0);
    const sources = [...thumbnails.slice(0, 3), userPhoto];
    sources.forEach((src, frame) => {
      if (!src) return;
      squareTexture(src).then((tex) => {
        const photo = this.photos[frame];
        photo.material.map?.dispose();
        photo.material.map = tex;
        photo.material.needsUpdate = true;
        slots[frame].value = tex;
        has.setComponent(frame, 1);
      }).catch(() => {});
    });
  }
}

/**
 * The cruise line: straight down -z with a slow weave left/right and up/down (as a function of
 * distance, so it keeps its shape at any speed), easing in after take-off. The portraits sit at
 * |x| > 3, well clear of the +-0.6 weave.
 */
function cruisePoint(d: number, out: THREE.Vector3) {
  const k = smoothstep(3, 12, d);
  return out.set(
    START.x + 0.6 * Math.sin(d * 0.15) * k,
    START.y + 0.25 * Math.sin(d * 0.1 + 1.3) * k,
    START.z - d,
  );
}

/** Bank gently into the weave (the sign follows the sideways acceleration). */
function cruiseRoll(d: number) {
  return 0.05 * Math.sin(d * 0.15) * smoothstep(3, 12, d);
}

/** Distance from a square's centre to its edge along a direction (half = half the side). */
function edgeDistance(dir: THREE.Vector3, half: number) {
  return half / Math.max(Math.abs(dir.x), Math.abs(dir.y), 1e-6);
}

function cubic(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, s: number, out: THREE.Vector3) {
  const a = (1 - s) ** 3, b = 3 * (1 - s) ** 2 * s, c = 3 * (1 - s) * s * s, d = s ** 3;
  out.set(
    a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    a * p0.z + b * p1.z + c * p2.z + d * p3.z,
  );
}

/** Load any image (thumbnail data URI or the user's photo) as a centre-cropped square texture. */
function squareTexture(src: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement("canvas");
      c.width = c.height = Math.min(side, 512);
      c.getContext("2d")!.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, c.width, c.height);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      resolve(tex);
    };
    img.onerror = reject;
    img.src = src;
  });
}
