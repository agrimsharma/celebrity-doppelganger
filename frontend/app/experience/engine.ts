/**
 * The 3D experience: a particle head that watches the cursor, and a gallery the camera glides
 * through while a search runs, ending at a wall where three spotlights reveal the matches.
 *
 * Plain three.js, no React: page.tsx drives it through a handful of methods (startSearch,
 * showResults, back) and gets told when the camera arrives. One camera path (a Catmull-Rom curve)
 * runs from the head to the final wall; "where we are" is a single progress value 0..1 along it,
 * and everything else - the head bursting into light, the backdrop fading, the gallery revealing
 * itself through fog - is derived from that value, so the choreography can't fall out of sync.
 */
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export type FrameRect = { x: number; y: number; width: number; height: number };

const INK = new THREE.Color("#04060c");
const BRASS = new THREE.Color("#b8925a");
const WARM = new THREE.Color("#ffd9a8");

// gallery geometry (world units ~ metres)
const HALL_START = -7;
const HALL_END = -39;
const HALL_HALF_WIDTH = 3.2;
const FLOOR_Y = -1.7;
const CEIL_Y = 3.1;
const WALL_Z = HALL_END + 0.05;
const FINAL_FRAMES = [
  { x: -2.15, y: 0.55, w: 1.15, h: 1.45 },
  { x: 0, y: 0.75, w: 1.5, h: 1.9 },   // the best match: centre, larger, a little higher
  { x: 2.15, y: 0.55, w: 1.15, h: 1.45 },
];
const RESULT_ORDER = [1, 0, 2];        // matches[0] goes in the centre frame

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------------------------------- shaders
const HEAD_VERT = /* glsl */ `
attribute float aSeed;
attribute float aDust;
uniform float uTime, uBurst, uSize, uPixelRatio;
varying vec3 vColor;
varying float vAlpha;
uniform vec3 uCool, uWarm;

void main() {
  vec3 p = position;
  float alpha = 1.0;

  // dust: some points drift off the shoulders and back of the head, like a thought dissolving
  if (aDust > 0.5) {
    float life = fract(uTime * (0.035 + 0.05 * aSeed) + aSeed * 13.0);
    p += vec3(0.9, 0.25, -0.5) * life * (0.6 + aSeed)
       + vec3(sin(uTime * 0.7 + aSeed * 40.0), cos(uTime * 0.5 + aSeed * 30.0), 0.0) * 0.05 * life;
    alpha = sin(life * 3.14159) * 0.8;
  }
  // breathing shimmer
  p += normal * 0.006 * sin(uTime * 1.6 + aSeed * 50.0);

  // the burst when a search starts: the head blows apart toward and past the camera
  vec3 away = normalize(p + vec3(0.0, 0.0, 0.35)) * (0.6 + aSeed);
  p += away * uBurst * 2.6 + vec3(0.0, 0.0, 5.5 * aSeed) * uBurst * uBurst;
  alpha *= 1.0 - smoothstep(0.55, 1.0, uBurst);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uPixelRatio * (0.55 + 0.9 * aSeed) / -mv.z;

  // light the points by their surface normal: a soft key from upper left, a strong cool rim
  vec3 n = normalize(normalMatrix * normal);
  float key = max(dot(n, normalize(vec3(-0.45, 0.55, 0.7))), 0.0);
  float rim = pow(1.0 - abs(n.z), 2.2);
  float lum = 0.05 + 0.62 * key + 0.68 * rim;
  vColor = mix(uCool, uWarm, key * 0.7) * lum;
  vAlpha = alpha;
}`;

const POINT_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
}`;

const STAR_VERT = /* glsl */ `
attribute float aSeed;
uniform float uTime, uPixelRatio, uFade;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (1.0 + 2.2 * aSeed * aSeed) * uPixelRatio;
  vColor = mix(vec3(0.62, 0.72, 1.0), vec3(1.0, 0.9, 0.78), aSeed);
  vAlpha = (0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * (0.6 + aSeed * 2.0) + aSeed * 90.0))) * uFade;
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
uniform float uTime, uFade;
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
  // shafts: soft diagonal bands drifting across the backdrop
  float band = d.x * 0.85 + d.y * 0.55 + 0.04 * sin(uTime * 0.07);
  float shafts = pow(0.5 + 0.5 * sin(band * 7.0 + uTime * 0.05), 14.0) * smoothstep(0.2, -0.9, d.z);
  base += vec3(0.035, 0.055, 0.14) * shafts * (0.5 + haze);
  gl_FragColor = vec4(base * uFade, 1.0);
}`;

// a soft cone of light (spotlight beam), brightest at the lamp and fading toward the wall
const BEAM_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vView;
void main() {
  vUv = uv;
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const BEAM_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vView;
uniform float uIntensity;
uniform vec3 uColor;
void main() {
  float edge = pow(abs(dot(normalize(vN), normalize(vView))), 1.6);
  float along = smoothstep(0.0, 0.15, vUv.y) * (0.25 + 0.75 * vUv.y);
  gl_FragColor = vec4(uColor * edge * along * uIntensity * 0.11, 1.0);
}`;

// film look: subtle chromatic aberration toward the edges, vignette and grain
const FILM_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 1.0 },
    uBlack: { value: 0 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime, uVignette, uBlack; varying vec2 vUv;
    float rand(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec2 off = c * r2 * 0.012;
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      col *= mix(1.0, smoothstep(0.85, 0.15, r2 * 2.2), uVignette);
      col += (rand(vUv * 1000.0 + fract(uTime)) - 0.5) * 0.035;
      col *= 1.0 - uBlack;
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
  private gallery = new THREE.Group();
  private headMat?: THREE.ShaderMaterial;
  private starMat: THREE.ShaderMaterial;
  private skyMat: THREE.ShaderMaterial;
  private path: THREE.CatmullRomCurve3;

  private pointer = new THREE.Vector2();
  private look = new THREE.Vector2();
  private progress = 0;
  private tween: { from: number; to: number; start: number; duration: number; ease: (t: number) => number; done?: () => void } | null = null;
  private mode: "landing" | "searching" | "arriving" | "gallery" | "returning" = "landing";

  private finalPaintings: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  private finalBeams: THREE.ShaderMaterial[] = [];
  private finalSpots: THREE.SpotLight[] = [];
  private lightsOn = [0, 0, 0];
  private lightsTarget = [0, 0, 0];
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

    this.scene.fog = new THREE.FogExp2(INK, 0.045);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;

    // backdrop
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uTime: { value: 0 }, uFade: { value: 1 } },
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(120, 48, 24), this.skyMat));
    this.starMat = this.buildStars(opts.lowPower ? 1400 : 2600);

    this.scene.add(this.head);
    this.head.position.set(0.35, 0, 0);
    this.buildGallery();

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
    const position = new Float32Array(count * 3);
    const normal = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const dust = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 3; k++) {
        position[i * 3 + k] = pos16[i * 3 + k] / 32767;
        normal[i * 3 + k] = nrm8[i * 3 + k] / 127;
      }
      seed[i] = Math.random();
      const y = position[i * 3 + 1], z = position[i * 3 + 2];
      // the shoulders and the back of the skull dissolve; a few stray points everywhere
      dust[i] = (y < -0.45 && Math.random() < 0.55) || (z < -0.25 && Math.random() < 0.25) || Math.random() < 0.04 ? 1 : 0;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    geo.setAttribute("aDust", new THREE.BufferAttribute(dust, 1));
    this.headMat = new THREE.ShaderMaterial({
      vertexShader: HEAD_VERT, fragmentShader: POINT_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: {
        uTime: { value: 0 }, uBurst: { value: 0 }, uSize: { value: this.opts.lowPower ? 20 : 15 },
        uPixelRatio: { value: this.pixelRatio },
        uCool: { value: new THREE.Color("#8fb2ff") }, uWarm: { value: new THREE.Color("#ffe3c2") },
      },
    });
    const pts = new THREE.Points(geo, this.headMat);
    pts.scale.setScalar(1.36);
    pts.rotation.y = -0.6;  // three-quarter view: the face looks a little to the left of the page
    this.head.add(pts);
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

  /** Fly from the head into the gallery and keep walking while the search runs. */
  startSearch() {
    this.mode = "searching";
    this.lightsTarget = [0, 0, 0];
    if (this.opts.reducedMotion) {
      this.progress = 0.8;
      return;
    }
    this.animateTo(0.62, 4.6, easeInOut);
  }

  /** Put the matches in the frames, walk to the wall and light them one by one. */
  showResults(thumbnails: (string | null)[], onArrived: () => void) {
    this.setPaintings(thumbnails);
    this.mode = "arriving";
    const arrive = () => {
      this.mode = "gallery";
      RESULT_ORDER.forEach((frame, rank) => {
        window.setTimeout(() => (this.lightsTarget[frame] = 1), this.opts.reducedMotion ? 0 : 250 + rank * 420);
      });
      window.setTimeout(() => {
        onArrived();
        this.emitLayout();
      }, this.opts.reducedMotion ? 0 : 1250);
    };
    if (this.opts.reducedMotion) {
      this.progress = 1;
      arrive();
      return;
    }
    const remaining = 1 - this.progress;
    this.animateTo(1, 1.4 + remaining * 4.2, easeOut, arrive);
  }

  /** Back to the head (after results, or when a search fails). */
  back(onDone?: () => void) {
    this.mode = "returning";
    this.lightsTarget = [0, 0, 0];
    const done = () => {
      this.mode = "landing";
      onDone?.();
    };
    if (this.opts.reducedMotion) {
      this.progress = 0;
      done();
      return;
    }
    this.animateTo(0, 1.6 + this.progress * 2.4, easeInOut, done);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);  // also sizes the bloom pass's internal targets
    this.camera.aspect = w / h;
    // keep the head comfortably framed on portrait screens
    this.camera.fov = w / h < 0.8 ? 52 : 36;
    this.camera.updateProjectionMatrix();
    this.path = this.buildPath(w / h);
    this.head.position.x = w / h < 0.8 ? 0 : 0.35;
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
      // still waiting for the answer (e.g. a cold start): keep strolling, ever more slowly
      this.progress += (0.84 - this.progress) * dt * 0.05;
    }

    // the head watches the cursor (only while we're facing it)
    const facing = 1 - smoothstep(0.02, 0.12, this.progress);
    const damp = 1 - Math.exp(-dt * 3.2);
    this.look.x += (this.pointer.x * facing - this.look.x) * damp;
    this.look.y += (this.pointer.y * facing - this.look.y) * damp;
    if (!this.opts.reducedMotion) {
      this.head.rotation.y = this.look.x * 0.6;
      this.head.rotation.x = -this.look.y * 0.28;
      this.head.position.y = Math.sin(t * 0.5) * 0.03;
    }

    const burst = smoothstep(0.03, 0.2, this.progress);
    if (this.headMat) {
      this.headMat.uniforms.uTime.value = this.opts.reducedMotion ? 4 : t;
      this.headMat.uniforms.uBurst.value = burst;
    }
    this.head.visible = burst < 0.999;
    // the cut: a moment of darkness between space and the gallery, which appears during it
    const black = smoothstep(0.16, 0.26, this.progress) * (1 - smoothstep(0.3, 0.38, this.progress));
    this.film.uniforms.uBlack.value = this.opts.reducedMotion ? 0 : black;
    this.gallery.visible = this.progress > 0.27;
    // starlight wants a generous bloom; lit paintings want almost none
    const inside = smoothstep(0.3, 0.5, this.progress);
    this.bloom.strength = 0.6 - 0.38 * inside;
    this.bloom.threshold = 0.22 + 0.4 * inside;
    this.skyMat.uniforms.uTime.value = t;
    this.skyMat.uniforms.uFade.value = 1 - 0.75 * smoothstep(0.15, 0.4, this.progress);
    this.starMat.uniforms.uTime.value = t;
    this.starMat.uniforms.uFade.value = 1 - 0.6 * smoothstep(0.2, 0.45, this.progress);
    (this.scene.fog as THREE.FogExp2).density = 0.045 - 0.022 * smoothstep(0.3, 0.9, this.progress);

    for (let i = 0; i < 3; i++) {
      this.lightsOn[i] += (this.lightsTarget[i] - this.lightsOn[i]) * (1 - Math.exp(-dt * (this.lightsTarget[i] ? 2.4 : 6)));
      const on = this.lightsOn[i];
      // a little flicker as each lamp warms up
      const flicker = on < 0.98 && on > 0.05 ? 0.85 + 0.15 * Math.sin(t * 40 + i) : 1;
      this.finalBeams[i].uniforms.uIntensity.value = on * flicker;
      this.finalSpots[i].intensity = on * flicker * 7;
      this.finalPaintings[i].material.color.setScalar(0.04 + 0.7 * on * flicker);
    }

    this.placeCamera(this.progress);
    this.film.uniforms.uTime.value = t;
    this.composer.render(dt);
  }

  /** The camera path; its last point is set back far enough that all three frames fit the screen. */
  private buildPath(aspect: number) {
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const halfWidth = 3.05;   // the three frames plus a margin
    const halfHeight = 1.9;   // frames, title above and plaques below
    const fitWidth = halfWidth / (Math.tan(halfFov) * aspect);
    const fitHeight = halfHeight / Math.tan(halfFov);
    const back = Math.min(Math.max(fitWidth, fitHeight, 7.4), 14);
    const finalZ = WALL_Z + back;
    const route = [
      new THREE.Vector3(0, 0.15, 6.4),
      new THREE.Vector3(0, 0.12, 2.2),
      new THREE.Vector3(0.05, 0.12, -2.5),
      new THREE.Vector3(0, 0.25, HALL_START - 1.5),   // through the dark, into the hall
      new THREE.Vector3(-0.7, 0.35, HALL_START - 9),
      new THREE.Vector3(0.7, 0.4, HALL_START - 16),
      new THREE.Vector3(0, 0.5, HALL_START - 21.5),
    ].filter((v) => v.z > finalZ + 2);  // a stop set further back (narrow screens) cuts the route short
    return new THREE.CatmullRomCurve3([...route, new THREE.Vector3(0, 0.55, finalZ)], false, "centripetal");
  }

  private placeCamera(p: number) {
    const pos = this.path.getPointAt(p);
    this.camera.position.copy(pos);
    const ahead = this.path.getPointAt(Math.min(p + 0.035, 1));
    const wall = new THREE.Vector3(0, 0.62, WALL_Z);
    const head = new THREE.Vector3(this.head.position.x * 0.4, 0.1, 0);
    const target = ahead.clone();
    target.lerp(head, 1 - smoothstep(0.0, 0.08, p));
    target.lerp(wall, smoothstep(0.82, 1.0, p));
    // a slow handheld drift, so even a still camera feels alive
    const t = this.clock.elapsedTime;
    if (!this.opts.reducedMotion) {
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
      if (this.headMat) this.headMat.uniforms.uPixelRatio.value = 1;
      this.starMat.uniforms.uPixelRatio.value = 1;
      this.resize();
    }
  }

  private emitLayout() {
    if (!this.onLayout) return;
    const w = window.innerWidth, h = window.innerHeight;
    const cam = this.camera.clone();
    cam.position.copy(this.path.getPointAt(1));
    cam.lookAt(0, 0.62, WALL_Z);
    cam.updateMatrixWorld();
    const rects = RESULT_ORDER.map((frame) => {
      const f = FINAL_FRAMES[frame];
      const a = new THREE.Vector3(f.x - f.w / 2, f.y + f.h / 2, WALL_Z).project(cam);
      const b = new THREE.Vector3(f.x + f.w / 2, f.y - f.h / 2, WALL_Z).project(cam);
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
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: this.pixelRatio }, uFade: { value: 1 } },
    });
    this.scene.add(new THREE.Points(geo, mat));
    return mat;
  }

  // -------------------------------------------------------------------------- the gallery
  private buildGallery() {
    const g = this.gallery;
    this.scene.add(g);
    const length = HALL_START - HALL_END;
    const midZ = (HALL_START + HALL_END) / 2;

    const wallTex = this.plasterTexture();
    const wallMat = new THREE.MeshStandardMaterial({ color: "#1a1f2c", roughness: 0.92, metalness: 0, map: wallTex });
    const floorMat = new THREE.MeshStandardMaterial({ color: "#07090e", roughness: 0.22, metalness: 0.35 });
    const ceilMat = new THREE.MeshStandardMaterial({ color: "#06070b", roughness: 1 });
    const brass = new THREE.MeshStandardMaterial({ color: BRASS, roughness: 0.3, metalness: 1, envMapIntensity: 1.6 });

    const plane = (w: number, h: number, mat: THREE.Material) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    const floor = plane(HALL_HALF_WIDTH * 2, length, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, FLOOR_Y, midZ);
    const ceil = plane(HALL_HALF_WIDTH * 2, length, ceilMat);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(0, CEIL_Y, midZ);
    const left = plane(length, CEIL_Y - FLOOR_Y, wallMat);
    left.rotation.y = Math.PI / 2;
    left.position.set(-HALL_HALF_WIDTH, (CEIL_Y + FLOOR_Y) / 2, midZ);
    const right = plane(length, CEIL_Y - FLOOR_Y, wallMat);
    right.rotation.y = -Math.PI / 2;
    right.position.set(HALL_HALF_WIDTH, (CEIL_Y + FLOOR_Y) / 2, midZ);
    const end = plane(HALL_HALF_WIDTH * 2, CEIL_Y - FLOOR_Y, new THREE.MeshStandardMaterial({ color: "#232a3a", roughness: 0.9, map: wallTex }));
    end.position.set(0, (CEIL_Y + FLOOR_Y) / 2, HALL_END);
    g.add(floor, ceil, left, right, end);

    // skirting and a thin brass rail along both walls
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, length), brass);
      rail.position.set(side * (HALL_HALF_WIDTH - 0.02), 2.35, midZ);
      g.add(rail);
    }

    // ceiling light lines: what the bloom catches as the camera glides underneath
    const stripMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#ffe8c8").multiplyScalar(2.2) });
    for (let z = HALL_START - 1.5; z > HALL_END + 2; z -= 3.2) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.015, 0.06), stripMat);
      strip.position.set(0, CEIL_Y - 0.02, z);
      g.add(strip);
    }

    // a dim warm glow travelling along the hall, so the walls read as surfaces
    for (let z = HALL_START - 2; z > HALL_END + 3; z -= 8) {
      const lamp = new THREE.PointLight(WARM, 9, 11, 1.6);
      lamp.position.set(0, 2.6, z);
      g.add(lamp);
    }
    g.add(new THREE.HemisphereLight("#33415f", "#05060a", 0.35));

    // veiled portraits along both walls, each with a small picture light
    const veils = [0, 1, 2, 3, 4, 5].map((i) => this.veiledPortrait(i));
    let k = 0;
    for (let z = HALL_START - 3; z > HALL_END + 5; z -= 4.1) {
      for (const side of [-1, 1]) {
        const w = 0.95 + ((k * 37) % 5) * 0.08, h = w * 1.3;
        const f = this.frame(w, h, brass, new THREE.MeshBasicMaterial({ map: veils[k % veils.length], color: "#8c8c8c", fog: true }));
        f.position.set(side * (HALL_HALF_WIDTH - 0.04), 0.5 + ((k * 13) % 3) * 0.06, z);
        f.rotation.y = -side * Math.PI / 2;
        g.add(f);
        g.add(this.pictureLight(f, h, side));
        k++;
      }
    }

    // the final wall: three frames, dark until their spotlights switch on
    FINAL_FRAMES.forEach((spec) => {
      const painting = new THREE.MeshBasicMaterial({ color: "#0d0d0d", map: veils[0] });
      const f = this.frame(spec.w, spec.h, brass, painting, true);
      f.position.set(spec.x, spec.y, WALL_Z + 0.02);
      g.add(f);
      this.finalPaintings.push(f.userData.painting);

      const beamMat = new THREE.ShaderMaterial({
        vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
        uniforms: { uIntensity: { value: 0 }, uColor: { value: WARM.clone() } },
      });
      const lampPos = new THREE.Vector3(spec.x, CEIL_Y - 0.05, WALL_Z + 2.4);
      const target = new THREE.Vector3(spec.x, spec.y, WALL_Z);
      const len = lampPos.distanceTo(target);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(spec.w * 0.95, len, 48, 1, true), beamMat);
      // cone's tip at the lamp, opening toward the painting
      cone.position.copy(lampPos.clone().lerp(target, 0.5));
      cone.lookAt(target);
      cone.rotateX(-Math.PI / 2);
      g.add(cone);
      this.finalBeams.push(beamMat);

      const spot = new THREE.SpotLight(WARM, 0, 9, 0.42, 0.55, 1.4);
      spot.position.copy(lampPos);
      spot.target.position.copy(target);
      g.add(spot, spot.target);
      this.finalSpots.push(spot);

      const fixture = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.16, 20), brass);
      fixture.position.copy(lampPos);
      g.add(fixture);
    });
  }

  private frame(w: number, h: number, brass: THREE.Material, painting: THREE.MeshBasicMaterial, square = false) {
    const group = new THREE.Group();
    const border = 0.07;
    const back = new THREE.Mesh(new THREE.BoxGeometry(w + border * 2, h + border * 2, 0.05), brass);
    // the mat (passe-partout): ivory for the results, dark for the veiled portraits
    const mat = new THREE.Mesh(
      new THREE.PlaneGeometry(w + 0.02, h + 0.02),
      new THREE.MeshStandardMaterial({ color: square ? "#d8cfbf" : "#0b0b0d", roughness: 1 }),
    );
    mat.position.z = 0.026;
    // the matches are square photos: a square opening set a little above centre, gallery style
    const side = w * 0.74;
    const canvas = new THREE.Mesh(new THREE.PlaneGeometry(square ? side : w * 0.86, square ? side : h * 0.88), painting);
    canvas.position.set(0, square ? (h - side) * 0.12 : 0, 0.028);
    group.add(back, mat, canvas);
    group.userData.painting = canvas;
    return group;
  }

  private pictureLight(frame: THREE.Group, h: number, side: number) {
    // a soft warm wash down the painting (additive plane), no real light needed
    const tex = this.radialTexture();
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, h * 1.25),
      new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color("#ffcf96").multiplyScalar(0.55), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    glow.position.copy(frame.position);
    glow.position.x -= side * 0.06;
    glow.position.y += h * 0.18;
    glow.rotation.y = frame.rotation.y;
    return glow;
  }

  private setPaintings(thumbnails: (string | null)[]) {
    const loader = new THREE.TextureLoader();
    RESULT_ORDER.forEach((frame, rank) => {
      const src = thumbnails[rank];
      if (!src) return;
      loader.load(src, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        const mesh = this.finalPaintings[frame];
        mesh.material.map?.dispose();
        mesh.material.map = tex;
        mesh.material.needsUpdate = true;
      });
    });
  }

  private plasterTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 200 + Math.random() * 55;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(8, 2);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private radialTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(64, 20, 2, 64, 54, 70);
    g.addColorStop(0, "rgba(255,255,255,0.9)");
    g.addColorStop(0.45, "rgba(255,255,255,0.22)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  /** A dark "old master" canvas with a faint head silhouette - the other faces in the index. */
  private veiledPortrait(variant: number) {
    const c = document.createElement("canvas");
    c.width = 192;
    c.height = 256;
    const ctx = c.getContext("2d")!;
    const hues = ["#1d2436", "#2a2219", "#1b2a2a", "#2b1d26", "#22263a", "#2a271c"];
    const bg = ctx.createLinearGradient(0, 0, 0, 256);
    bg.addColorStop(0, hues[variant % hues.length]);
    bg.addColorStop(1, "#08090c");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 192, 256);
    const cx = 96 + (variant % 3 - 1) * 10;
    const glow = ctx.createRadialGradient(cx, 110, 6, cx, 120, 90);
    glow.addColorStop(0, "rgba(235,215,185,0.30)");
    glow.addColorStop(1, "rgba(235,215,185,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 192, 256);
    ctx.fillStyle = "rgba(10,10,14,0.55)";
    ctx.beginPath();
    ctx.ellipse(cx, 112, 34, 44, 0, 0, Math.PI * 2);           // head
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx, 238, 78, 56, 0, Math.PI, Math.PI * 2);     // shoulders
    ctx.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
}
