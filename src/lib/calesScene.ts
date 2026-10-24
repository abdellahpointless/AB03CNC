import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { CALE_HEIGHTS, type CaleStatus } from './cales';

/*
 * The cales box in 3D: a dark case with a hinged lid and a foam insert, one pair of aluminium
 * cales per slot (43 mm on the left down to 8 mm on the right), the height engraved on each cale.
 *
 *   present + confirmed  soft green glow
 *   damaged              tool bites, scratches and dents, soft yellow glow
 *   missing              its place shows a dashed red outline with a soft red glow
 *
 * Units are millimetres. Every movement chases its target smoothly, so any animation can be
 * interrupted and redirected from where it is (no jumps).
 */

// ---- Dimensions (mm) ----
const L = 150; // cale length
const T = 10; // cale thickness
const PAIR_GAP = 2;
const SLOT_W = 25;
const PITCH = 35;
const N = CALE_HEIGHTS.length;
const SLOTS_W = N * PITCH - (PITCH - SLOT_W);
const IN_W = SLOTS_W + 48;
const WALL = 9;
const OUT_W = IN_W + 2 * WALL;
const SLOT_L = L + 6;
const FRONT_M = 20;
const BACK_M = 50; // strip behind the slots where the heights are printed
const IN_D = SLOT_L + FRONT_M + BACK_M;
const OUT_D = IN_D + 2 * WALL;
const FLOOR_T = 7;
const BASE_H = 60;
const INSERT_TOP = 54;
const LID_H = 34;
const LID_OPEN = -1.96; // ≈ 112°: the lid stands behind the box, leaning back a little
const SLOT_Z0 = IN_D / 2 - FRONT_M;
const SLOT_Z1 = SLOT_Z0 - SLOT_L;
const SLOT_ZC = (SLOT_Z0 + SLOT_Z1) / 2;
const slotX = (i: number) => -SLOTS_W / 2 + SLOT_W / 2 + i * PITCH;
/** Taller cales sit deeper, so the pairs make a gentle staircase and every one stays visible. */
const slotDepth = (h: number) => 6 + (h - 8) * 0.45;
const restY = (h: number) => INSERT_TOP - slotDepth(h) + h / 2;

const BEVEL = 0.6;
const PX_PER_MM = 6;
const UP = new THREE.Vector3(0, 1, 0);

export type Theme = 'dark' | 'light';
export type Preview = 'missing' | 'damaged' | null;
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const COLORS = {
  green: new THREE.Color('#3ddc84'),
  yellow: new THREE.Color('#f5c542'),
  red: new THREE.Color('#ff4d4f'),
};

// ---- Small helpers ----

function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const FONT = '"Inter", "Segoe UI", Arial, sans-serif';

/** Fine streaks along the length: brushed aluminium. */
function paintBrushed(ctx: CanvasRenderingContext2D, w: number, h: number, rand: () => number, base: string, light: string, dark: string) {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  const lines = Math.round((w * h) / 240);
  for (let i = 0; i < lines; i++) {
    const y = rand() * h;
    const x = rand() * w * 1.2 - w * 0.1;
    const len = 30 + rand() * w * 0.5;
    ctx.globalAlpha = 0.05 + rand() * 0.12;
    ctx.strokeStyle = rand() > 0.5 ? light : dark;
    ctx.lineWidth = 0.6 + rand() * 0.9;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + (rand() - 0.5) * 0.8);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/**
 * A small photo studio, used only for reflections: a dark room with a few soft boxes. Polished
 * metal shows its surroundings, so dark walls with bright strips make the aluminium read as metal
 * (soft gradients and crisp highlights) instead of flat white.
 */
function studioEnvironment(): THREE.Scene {
  const env = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(40, 26, 40), new THREE.MeshBasicMaterial({ color: '#20242b', side: THREE.BackSide }));
  room.position.y = 7;
  env.add(room);
  const panel = (w: number, h: number, intensity: number, pos: [number, number, number], color = '#ffffff') => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }),
    );
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  panel(12, 5, 2.4, [0, 18, 2]); // soft box overhead
  panel(8, 3, 1.2, [-6, 16, -9]); // smaller one further back, for a gradient along the tops
  panel(3.2, 14, 7.5, [-15, 7, 11], '#fff1e2'); // warm strip, front left
  panel(3.2, 12, 5, [16, 6, -8], '#e6efff'); // cool strip, back right
  panel(20, 4, 1.3, [0, 3, 19.5]); // low fill from the front
  return env;
}

// ---- Damage, the same every time for a given height ----

interface Bite {
  x: number; // mm from the back end
  r: number; // radius of the tool that hit it
  d: number; // how deep it went
}
interface Damage {
  bites: Bite[];
  chip: number;
  scratches: { x: number; y: number; len: number; angle: number; count: number }[];
  dents: { x: number; y: number; r: number }[];
}

function damageFor(h: number): Damage {
  const rand = seeded(h * 7919 + 13);
  const spots = h >= 20 ? [0.2, 0.46, 0.7] : [0.26, 0.62];
  const bites = spots.map((f) => {
    const r = 3 + rand() * 2.6;
    return { x: L * (f + (rand() - 0.5) * 0.06), r, d: Math.min(h * 0.22, r * 0.75, 1.2 + rand() * 2.2) };
  });
  const scratches = bites.flatMap((b) =>
    Array.from({ length: 1 + Math.round(rand()) }, () => ({
      x: b.x + (rand() - 0.5) * 16,
      y: h * (0.35 + rand() * 0.5),
      len: 8 + rand() * 22,
      angle: (rand() > 0.5 ? 1 : -1) * (0.12 + rand() * 0.35),
      count: 2 + Math.round(rand() * 3),
    })),
  );
  const dents = Array.from({ length: 2 + Math.round(rand() * 2) }, () => ({
    x: L * (0.12 + rand() * 0.76),
    y: h * (0.25 + rand() * 0.55),
    r: Math.min(h * 0.16, 1.2 + rand() * 1.6),
  }));
  return { bites, chip: Math.min(h * 0.22, 4.5), scratches, dents };
}

/** Side profile of a cale (x along the length from the back end, y up), inset by the bevel. */
function caleShape(h: number, dmg: Damage | null): THREE.Shape {
  const s = new THREE.Shape();
  const b = BEVEL;
  const x0 = b;
  const x1 = L - b;
  const y0 = b;
  const y1 = h - b;
  s.moveTo(x0, y0);
  s.lineTo(x1, y0);
  if (!dmg) {
    s.lineTo(x1, y1);
  } else {
    s.lineTo(x1, y1 - dmg.chip); // chipped front corner
    s.lineTo(x1 - dmg.chip * 1.25, y1);
    // Round bites in the top edge, where the side of a cutter touched it.
    for (const n of [...dmg.bites].sort((a, c) => c.x - a.x)) {
      const cy = y1 + n.r - n.d;
      const a = Math.sqrt(n.r * n.r - (n.r - n.d) * (n.r - n.d));
      s.lineTo(n.x + a, y1);
      s.absarc(n.x, cy, n.r, Math.atan2(y1 - cy, a), Math.atan2(y1 - cy, -a), true);
    }
  }
  s.lineTo(x0, y1);
  s.lineTo(x0, y0);
  return s;
}

/** A cale: the side profile extruded through the thickness, with small chamfers on every edge. */
function caleGeometry(h: number, dmg: Damage | null): THREE.BufferGeometry {
  const depth = T - 2 * BEVEL;
  const g = new THREE.ExtrudeGeometry(caleShape(h, dmg), {
    depth,
    bevelEnabled: true,
    bevelThickness: BEVEL,
    bevelSize: BEVEL,
    bevelSegments: 1,
    curveSegments: dmg ? 7 : 1,
    steps: 1,
  });
  g.translate(-L / 2, -h / 2, -depth / 2);
  g.rotateY(-Math.PI / 2); // length → z (front at +z), thickness → x
  // Both engraved sides read the right way round, each from its own side.
  const n = g.getAttribute('normal');
  const uv = g.getAttribute('uv');
  for (let i = 0; i < n.count; i++) if (n.getX(i) > 0.99) uv.setX(i, L - uv.getX(i));
  uv.needsUpdate = true;
  return g;
}

/** The engraved side of a cale (colour, roughness, relief), optionally hurt by a tool. */
function sideTextures(h: number, dmg: Damage | null, maxAniso: number) {
  const W = Math.round(L * PX_PER_MM);
  const H = Math.max(48, Math.round(h * PX_PER_MM));
  const sx = W / L;
  const sy = H / h;
  const rand = seeded(h * 31 + (dmg ? 7 : 1));

  const color = makeCanvas(W, H);
  const c = color.getContext('2d')!;
  paintBrushed(c, W, H, rand, '#b9bfc6', '#e9edf1', '#868d95');
  const rough = makeCanvas(W, H);
  const r = rough.getContext('2d')!;
  paintBrushed(r, W, H, rand, 'rgb(84,84,84)', 'rgb(112,112,112)', 'rgb(62,62,62)');
  const bump = makeCanvas(W, H);
  const b = bump.getContext('2d')!;
  b.fillStyle = 'rgb(200,200,200)';
  b.fillRect(0, 0, W, H);

  // The engraved height, near the back end as it is read.
  const textMm = Math.min(h * 0.58, 10);
  const fs = textMm * sy;
  const tx = W * 0.07;
  const ty = H * 0.5 + fs * 0.36;
  const label = String(h);
  const font = `700 ${fs}px ${FONT}`;
  const small = `600 ${fs * 0.5}px ${FONT}`;
  c.font = font;
  const tw = c.measureText(label).width;
  const engrave = (ctx: CanvasRenderingContext2D, fill: string, dy = 0) => {
    ctx.fillStyle = fill;
    ctx.font = font;
    ctx.fillText(label, tx, ty + dy);
    ctx.font = small;
    ctx.fillText('mm', tx + tw + fs * 0.12, ty + dy);
  };
  c.globalAlpha = 0.55;
  engrave(c, '#f8fafb', 1.2); // lower lip catching the light
  c.globalAlpha = 0.9;
  engrave(c, '#575e67');
  c.globalAlpha = 1;
  engrave(r, 'rgb(190,190,190)');
  b.filter = 'blur(0.8px)';
  engrave(b, 'rgb(55,55,55)');
  b.filter = 'none';

  if (dmg) {
    const line = (ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, style: string, w: number) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    };
    for (const n of dmg.bites) {
      // The cutter's centre is above the edge; the bite is the bottom of its circle.
      const cx = n.x * sx;
      const cy = (n.d - n.r) * sy;
      const R = n.r * sx;
      // Smudge and swirl marks left around the bite by the spinning tool.
      const g = c.createRadialGradient(cx, cy, R, cx, cy, R + 6 * sx);
      g.addColorStop(0, 'rgba(58,62,68,0.55)');
      g.addColorStop(1, 'rgba(58,62,68,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, R + 6 * sx, 0, Math.PI);
      c.fill();
      for (let k = 0; k < 4; k++) {
        c.strokeStyle = k % 2 ? 'rgba(255,255,255,0.32)' : 'rgba(50,54,60,0.42)';
        c.lineWidth = 1;
        c.beginPath();
        c.arc(cx, cy, R + (0.9 + k * 1.1) * sx, 0.18 * Math.PI, 0.82 * Math.PI);
        c.stroke();
      }
      // Bright raised burr right at the cut.
      c.strokeStyle = 'rgba(252,253,255,0.95)';
      c.lineWidth = 1.8;
      c.beginPath();
      c.arc(cx, cy, R + 1.2, 0.1 * Math.PI, 0.9 * Math.PI);
      c.stroke();
      r.fillStyle = 'rgb(205,205,205)';
      r.beginPath();
      r.arc(cx, cy, R + 3 * sx, 0, Math.PI);
      r.fill();
      b.filter = 'blur(1.5px)';
      b.strokeStyle = 'rgb(255,255,255)';
      b.lineWidth = 3;
      b.beginPath();
      b.arc(cx, cy, R + 2, 0.1 * Math.PI, 0.9 * Math.PI);
      b.stroke();
      b.strokeStyle = 'rgb(120,120,120)';
      for (let k = 0; k < 3; k++) {
        b.lineWidth = 1.2;
        b.beginPath();
        b.arc(cx, cy, R + (1.6 + k * 1.2) * sx, 0.2 * Math.PI, 0.8 * Math.PI);
        b.stroke();
      }
      b.filter = 'none';
    }
    // Scratches where the tool slid along: a few close, parallel grooves.
    for (const s of dmg.scratches) {
      const x0 = s.x * sx;
      const y0 = H - s.y * sy;
      const dx = Math.cos(s.angle) * s.len * sx;
      const dy = Math.sin(s.angle) * s.len * sy;
      for (let j = 0; j < s.count; j++) {
        const o = j * (0.7 + rand() * 0.6) * sy;
        const fade = 0.55 + rand() * 0.4;
        line(c, x0, y0 + o, x0 + dx * fade, y0 + dy * fade + o, 'rgba(62,67,74,0.6)', 0.9);
        line(c, x0, y0 + o + 1.1, x0 + dx * fade, y0 + dy * fade + o + 1.1, 'rgba(252,253,255,0.55)', 0.8);
        line(b, x0, y0 + o, x0 + dx * fade, y0 + dy * fade + o, 'rgb(110,110,110)', 1.3);
        line(r, x0, y0 + o, x0 + dx * fade, y0 + dy * fade + o, 'rgb(170,170,170)', 1.6);
      }
    }
    // Dents: a dark pit with light catching its far rim.
    for (const d of dmg.dents) {
      const x = d.x * sx;
      const y = H - d.y * sy;
      const rr = d.r * sx;
      const g = c.createRadialGradient(x, y, 0, x, y, rr);
      g.addColorStop(0, 'rgba(70,75,82,0.75)');
      g.addColorStop(1, 'rgba(70,75,82,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, y, rr, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = 'rgba(250,252,255,0.6)';
      c.lineWidth = 1;
      c.beginPath();
      c.arc(x, y, rr * 0.8, 0.1 * Math.PI, 0.7 * Math.PI);
      c.stroke();
      const gb = b.createRadialGradient(x, y, 0, x, y, rr);
      gb.addColorStop(0, 'rgb(60,60,60)');
      gb.addColorStop(1, 'rgba(200,200,200,0)');
      b.fillStyle = gb;
      b.beginPath();
      b.arc(x, y, rr, 0, Math.PI * 2);
      b.fill();
    }
  }

  const tex = (cv: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(cv);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.repeat.set(1 / L, 1 / h); // the side's UVs are in millimetres
    return t;
  };
  return { map: tex(color, true), roughnessMap: tex(rough, false), bumpMap: tex(bump, false) };
}

/** A canvas texture of text, for the printed heights and the lid labels. */
function labelTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, maxAniso: number) {
  const cv = makeCanvas(w, h);
  draw(cv.getContext('2d')!);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  return t;
}

function noiseTexture(size: number, seed: number, lo: number, hi: number, repeat: number) {
  const cv = makeCanvas(size, size);
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const rand = seeded(seed);
  for (let i = 0; i < size * size; i++) {
    const v = lo + rand() * (hi - lo);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  return t;
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

// ---- Camera views ----

interface View {
  az: number; // azimuth (rad, 0 = straight in front)
  pol: number; // angle from straight down (rad)
  dist: number;
  target: THREE.Vector3;
}
const VIEW_CLOSED: View = { az: -0.5, pol: 1.0, dist: 1200, target: new THREE.Vector3(0, 40, 0) };
const VIEW_OPEN: View = { az: -0.06, pol: 0.72, dist: 1100, target: new THREE.Vector3(0, 60, -20) };
const copyView = (v: View): View => ({ ...v, target: v.target.clone() });

interface Holder {
  group: THREE.Group;
  mesh: THREE.Mesh;
  ghost: THREE.Mesh;
  lines: THREE.Group;
}
interface Bundle {
  h: number;
  i: number;
  status: CaleStatus;
  group: THREE.Group;
  holders: [Holder, Holder];
  // smoothed values
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  spread: number; // 0 = side by side in the slot, 1 = one above the other (held up to look at)
}

export interface CalesSceneOptions {
  machineName: string;
  /** Word printed on the lid ("CALES"). */
  label?: string;
  theme: Theme;
  /** Clicks, hover and orbiting (off for the still picture on the machine page). */
  interactive: boolean;
  /** Start with the lid open (otherwise closed until open()). */
  startOpen?: boolean;
  /** Build the cales (not needed for a picture of the closed box). */
  contents?: boolean;
  onPick?: (h: number | null) => void;
  onHover?: (h: number | null) => void;
}

export class CalesScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private lineScene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer | null = null;
  private passes: Record<'green' | 'yellow' | 'red', OutlinePass> | null = null;
  private controls: OrbitControls | null = null;
  private pmrem: THREE.PMREMGenerator;
  private envTex: THREE.Texture;
  private bundles: Bundle[] = [];
  private lid = new THREE.Group();
  private lidAngle = 0;
  private lidAnim: { from: number; to: number; t0: number; dur: number; delay: number } | null = null;
  private view: View = copyView(VIEW_CLOSED);
  private camAnim: { from: View; to: View; t0: number; dur: number; done?: () => void } | null = null;
  private floorMat: THREE.ShadowMaterial;
  private lineMats: LineMaterial[] = [];
  private damaged = new Map<number, { geo: THREE.BufferGeometry; mats: THREE.Material[] }>();
  private healthy = new Map<number, { geo: THREE.BufferGeometry; mats: THREE.Material[] }>();
  private wallMat: THREE.MeshPhysicalMaterial;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private downAt: { x: number; y: number; t: number } | null = null;
  private raf = 0;
  private last = 0;
  private disposed = false;
  private size = { w: 1, h: 1 };
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private maxAniso: number;
  private reduceMotion = false;

  private verified = false;
  private selected: number | null = null;
  private hovered: number | null = null;
  private preview: Preview = null;
  private previewStart = 0;
  private waveStart = -1;
  private present = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
  private snapMargin: number | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private opts: CalesSceneOptions,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.maxAniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    const studio = studioEnvironment();
    this.envTex = this.pmrem.fromScene(studio, 0.035).texture;
    studio.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose?.();
    });
    this.scene.environment = this.envTex;

    this.camera = new THREE.PerspectiveCamera(30, 1, 10, 6000);

    // Lights: a warm key light with soft shadows, a cool rim from behind, a gentle fill.
    const key = new THREE.DirectionalLight('#fff6ec', 1.9);
    key.position.set(-300, 640, 420);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -440;
    key.shadow.camera.right = 440;
    key.shadow.camera.top = 440;
    key.shadow.camera.bottom = -440;
    key.shadow.camera.near = 100;
    key.shadow.camera.far = 1800;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.8;
    key.shadow.radius = 4;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#b9d0ff', 1.1);
    rim.position.set(300, 340, -520);
    this.scene.add(rim);
    this.scene.add(new THREE.HemisphereLight('#dfe8ff', '#1a1d22', 0.35));

    this.floorMat = new THREE.ShadowMaterial({ opacity: opts.theme === 'dark' ? 0.45 : 0.22 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    this.wallMat = this.makeWallMaterial();
    this.buildBox();
    if (opts.contents !== false) this.buildBundles();
    this.setTheme(opts.theme);

    if (opts.startOpen) {
      this.lidAngle = LID_OPEN;
      this.applyLid();
    }
    this.setView(this.fit(opts.startOpen ? VIEW_OPEN : VIEW_CLOSED, this.lidAngle));

    this.setupComposer();
    if (opts.interactive) this.setupInteraction();
  }

  // ---- Building ----

  private aluminium(extra: THREE.MeshPhysicalMaterialParameters) {
    // Anisotropy stretches the highlights along the brushing, like real brushed aluminium.
    return new THREE.MeshPhysicalMaterial({ color: '#ffffff', metalness: 1, roughness: 1, anisotropy: 0.5, ...extra });
  }

  private makeWallMaterial() {
    const rand = seeded(5);
    const cv = makeCanvas(512, 512);
    paintBrushed(cv.getContext('2d')!, 512, 512, rand, '#b3b9c0', '#e4e8ec', '#7f868e');
    const rv = makeCanvas(512, 512);
    paintBrushed(rv.getContext('2d')!, 512, 512, rand, 'rgb(92,92,92)', 'rgb(120,120,120)', 'rgb(68,68,68)');
    const map = new THREE.CanvasTexture(cv);
    map.colorSpace = THREE.SRGBColorSpace;
    const rough = new THREE.CanvasTexture(rv);
    for (const t of [map, rough]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(1 / 60, 1 / 60); // wall UVs are in millimetres
      t.anisotropy = this.maxAniso;
    }
    return this.aluminium({ map, roughnessMap: rough });
  }

  private sideMaterial(h: number, dmg: Damage | null) {
    const t = sideTextures(h, dmg, this.maxAniso);
    return this.aluminium({ map: t.map, roughnessMap: t.roughnessMap, bumpMap: t.bumpMap, bumpScale: dmg ? 2.4 : 1.4 });
  }

  private looks(h: number, damagedLook: boolean) {
    const cache = damagedLook ? this.damaged : this.healthy;
    let v = cache.get(h);
    if (!v) {
      const dmg = damagedLook ? damageFor(h) : null;
      v = { geo: caleGeometry(h, dmg), mats: [this.sideMaterial(h, dmg), this.wallMat] };
      cache.set(h, v);
    }
    return v;
  }

  private buildBox() {
    const caseMat = new THREE.MeshPhysicalMaterial({
      color: '#232a34',
      roughness: 0.55,
      metalness: 0.05,
      clearcoat: 0.3,
      clearcoatRoughness: 0.4,
      bumpMap: noiseTexture(256, 3, 110, 150, 6),
      bumpScale: 0.35,
    });
    const foamMat = new THREE.MeshPhysicalMaterial({
      color: '#1a1e25',
      roughness: 1,
      metalness: 0,
      sheen: 0.5,
      sheenColor: new THREE.Color('#4a5466'),
      sheenRoughness: 0.75,
      bumpMap: noiseTexture(256, 9, 60, 200, 10),
      bumpScale: 0.9,
    });
    const metal = new THREE.MeshStandardMaterial({ color: '#c3c9d0', metalness: 1, roughness: 0.25 });

    const shadowed = (m: THREE.Mesh) => {
      m.castShadow = true;
      m.receiveShadow = true;
      return m;
    };

    // Base shell.
    const wallH = BASE_H - FLOOR_T;
    const base = new THREE.Group();
    const r = 2.2;
    const parts: [number, number, number, number, number, number][] = [
      [OUT_W, FLOOR_T, OUT_D, 0, FLOOR_T / 2, 0],
      [OUT_W, wallH, WALL, 0, FLOOR_T + wallH / 2, OUT_D / 2 - WALL / 2],
      [OUT_W, wallH, WALL, 0, FLOOR_T + wallH / 2, -OUT_D / 2 + WALL / 2],
      [WALL, wallH, OUT_D - 2 * WALL, -OUT_W / 2 + WALL / 2, FLOOR_T + wallH / 2, 0],
      [WALL, wallH, OUT_D - 2 * WALL, OUT_W / 2 - WALL / 2, FLOOR_T + wallH / 2, 0],
    ];
    for (const [w, h, d, x, y, z] of parts) {
      const m = shadowed(new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, r), caseMat));
      m.position.set(x, y, z);
      base.add(m);
    }

    // Foam insert with one slot per pair (taller cales sit deeper).
    const insertH = INSERT_TOP - FLOOR_T;
    const yMid = FLOOR_T + insertH / 2;
    const pieces: THREE.BufferGeometry[] = [
      box(IN_W, insertH, IN_D / 2 - SLOT_Z0, 0, yMid, (IN_D / 2 + SLOT_Z0) / 2), // front strip
      box(IN_W, insertH, SLOT_Z1 + IN_D / 2, 0, yMid, (SLOT_Z1 - IN_D / 2) / 2), // back strip (heights)
      box(IN_W / 2 - SLOTS_W / 2, insertH, SLOT_L, -(IN_W / 2 + SLOTS_W / 2) / 2, yMid, SLOT_ZC),
      box(IN_W / 2 - SLOTS_W / 2, insertH, SLOT_L, (IN_W / 2 + SLOTS_W / 2) / 2, yMid, SLOT_ZC),
    ];
    for (let i = 0; i < N; i++) {
      const x = slotX(i);
      if (i < N - 1) pieces.push(box(PITCH - SLOT_W, insertH, SLOT_L, x + PITCH / 2, yMid, SLOT_ZC));
      const floorTop = INSERT_TOP - slotDepth(CALE_HEIGHTS[i]);
      pieces.push(box(SLOT_W, floorTop - FLOOR_T, SLOT_L, x, (FLOOR_T + floorTop) / 2, SLOT_ZC));
    }
    const insert = shadowed(new THREE.Mesh(mergeGeometries(pieces), foamMat));
    pieces.forEach((p) => p.dispose());
    base.add(insert);

    // The heights printed behind each slot (as on the real box).
    const stripD = SLOT_Z1 + IN_D / 2;
    const ppm = 4;
    const labels = labelTexture(
      IN_W * ppm,
      stripD * ppm,
      (ctx) => {
        ctx.fillStyle = '#d3dae3';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `700 ${16 * ppm}px ${FONT}`;
        CALE_HEIGHTS.forEach((h, i) => ctx.fillText(String(h), (slotX(i) + IN_W / 2) * ppm, stripD * ppm * 0.42));
      },
      this.maxAniso,
    );
    const labelMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(IN_W, stripD),
      new THREE.MeshStandardMaterial({ map: labels, transparent: true, roughness: 0.75, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2 }),
    );
    labelMesh.rotation.x = -Math.PI / 2;
    labelMesh.position.set(0, INSERT_TOP + 0.15, (SLOT_Z1 - IN_D / 2) / 2);
    labelMesh.receiveShadow = true;
    base.add(labelMesh);

    // Hardware: hinges at the back, latches at the front.
    for (const x of [-OUT_W * 0.33, 0, OUT_W * 0.33]) {
      const hinge = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, 56, 20), metal));
      hinge.rotation.z = Math.PI / 2;
      hinge.position.set(x, BASE_H, -OUT_D / 2 - 2);
      base.add(hinge);
    }
    for (const x of [-OUT_W * 0.3, OUT_W * 0.3]) {
      const latch = shadowed(new THREE.Mesh(new RoundedBoxGeometry(30, 22, 5, 2, 1.2), metal));
      latch.position.set(x, BASE_H - 13, OUT_D / 2 + 2);
      base.add(latch);
    }
    this.scene.add(base);

    // Lid, turning about the hinge line at the top of the back wall.
    this.lid.position.set(0, BASE_H, -OUT_D / 2);
    const lidWallH = LID_H - 4;
    const lidParts: [number, number, number, number, number, number][] = [
      [OUT_W, 4, OUT_D, 0, LID_H - 2, OUT_D / 2],
      [OUT_W, lidWallH, WALL, 0, lidWallH / 2, OUT_D - WALL / 2],
      [OUT_W, lidWallH, WALL, 0, lidWallH / 2, WALL / 2],
      [WALL, lidWallH, OUT_D - 2 * WALL, -OUT_W / 2 + WALL / 2, lidWallH / 2, OUT_D / 2],
      [WALL, lidWallH, OUT_D - 2 * WALL, OUT_W / 2 - WALL / 2, lidWallH / 2, OUT_D / 2],
    ];
    for (const [w, h, d, x, y, z] of lidParts) {
      const m = shadowed(new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, r), caseMat));
      m.position.set(x, y, z);
      this.lid.add(m);
    }
    const lining = shadowed(new THREE.Mesh(new THREE.BoxGeometry(IN_W, 6, IN_D), foamMat));
    lining.position.set(0, LID_H - 4 - 3, OUT_D / 2);
    this.lid.add(lining);
    // Handle on the front of the lid, and the latch hooks.
    const bar = shadowed(new THREE.Mesh(new RoundedBoxGeometry(150, 11, 11, 2, 4), metal));
    bar.position.set(0, LID_H / 2, OUT_D + 17);
    this.lid.add(bar);
    for (const x of [-62, 62]) {
      const post = shadowed(new THREE.Mesh(new RoundedBoxGeometry(11, 11, 18, 2, 3), metal));
      post.position.set(x, LID_H / 2, OUT_D + 8);
      this.lid.add(post);
    }
    for (const x of [-OUT_W * 0.3, OUT_W * 0.3]) {
      const hook = shadowed(new THREE.Mesh(new RoundedBoxGeometry(22, 12, 5, 2, 1.2), metal));
      hook.position.set(x, 8, OUT_D + 2);
      this.lid.add(hook);
    }
    // Labels: on top of the closed lid, and inside it (seen when it is open).
    const name = this.opts.machineName;
    const plate = (inside: boolean) =>
      labelTexture(
        1100,
        440,
        (ctx) => {
          ctx.fillStyle = inside ? 'rgba(14,18,24,0.9)' : 'rgba(10,13,18,0.5)';
          ctx.beginPath();
          ctx.roundRect(40, 60, 1020, 320, 34);
          ctx.fill();
          ctx.strokeStyle = 'rgba(200,210,224,0.35)';
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.fillStyle = '#e8edf3';
          ctx.textAlign = 'center';
          ctx.font = `800 118px ${FONT}`;
          ctx.fillText(this.opts.label ?? 'CALES', 550, 205, 960);
          ctx.font = `600 58px ${FONT}`;
          ctx.fillStyle = '#9fb3cc';
          ctx.fillText(name, 550, 290, 960);
          ctx.font = `500 30px ${FONT}`;
          ctx.fillStyle = 'rgba(200,210,224,0.75)';
          ctx.fillText(`${CALE_HEIGHTS.length} × 2  ·  ${CALE_HEIGHTS[CALE_HEIGHTS.length - 1]}–${CALE_HEIGHTS[0]} mm`, 550, 345);
        },
        this.maxAniso,
      );
    const top = new THREE.Mesh(
      new THREE.PlaneGeometry(OUT_W * 0.62, OUT_W * 0.62 * 0.4),
      new THREE.MeshStandardMaterial({ map: plate(false), transparent: true, roughness: 0.5, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -2 }),
    );
    top.rotation.x = -Math.PI / 2;
    top.position.set(0, LID_H + 0.3, OUT_D / 2);
    this.lid.add(top);
    const inner = new THREE.Mesh(
      new THREE.PlaneGeometry(OUT_W * 0.5, OUT_W * 0.5 * 0.4),
      new THREE.MeshStandardMaterial({ map: plate(true), transparent: true, roughness: 0.6, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2 }),
    );
    inner.rotation.x = Math.PI / 2;
    inner.position.set(0, LID_H - 10 - 0.3, OUT_D / 2);
    this.lid.add(inner);
    this.scene.add(this.lid);
  }

  private buildBundles() {
    const ghostMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    CALE_HEIGHTS.forEach((h, i) => {
      const group = new THREE.Group();
      group.position.set(slotX(i), restY(h), SLOT_ZC);
      const look = this.looks(h, false);
      const holders = [0, 1].map((k) => {
        const hg = new THREE.Group();
        hg.position.x = (k === 0 ? -1 : 1) * (T / 2 + PAIR_GAP / 2);
        const mesh = new THREE.Mesh(look.geo, look.mats);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.h = h;
        const ghost = new THREE.Mesh(new THREE.BoxGeometry(T, h, L), ghostMat);
        ghost.userData.h = h;
        hg.add(mesh, ghost);
        group.add(hg);
        // The dashed outline lives in its own scene, drawn after the glow, following the holder.
        const edges = new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(new THREE.BoxGeometry(T, h, L)));
        const dashMat = new LineMaterial({ color: COLORS.red.getHex(), linewidth: 2.2, dashed: true, dashSize: 5, gapSize: 3.6, transparent: true });
        const glowMat = new LineMaterial({
          color: COLORS.red.getHex(),
          linewidth: 7,
          transparent: true,
          opacity: 0.22,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        this.lineMats.push(dashMat, glowMat);
        const glow = new LineSegments2(edges, glowMat);
        const dash = new LineSegments2(edges, dashMat);
        dash.computeLineDistances();
        const lines = new THREE.Group();
        lines.add(glow, dash);
        lines.matrixAutoUpdate = false;
        lines.visible = false;
        this.lineScene.add(lines);
        return { group: hg, mesh, ghost, lines } as Holder;
      }) as [Holder, Holder];
      this.scene.add(group);
      this.bundles.push({ h, i, status: 'present', group, holders, pos: group.position.clone(), quat: new THREE.Quaternion(), spread: 0 });
    });
  }

  private setupComposer() {
    const target = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
    const composer = new EffectComposer(this.renderer, target);
    composer.addPass(new RenderPass(this.scene, this.camera));
    const make = (color: THREE.Color) => {
      const p = new OutlinePass(new THREE.Vector2(1, 1), this.scene, this.camera, []);
      p.visibleEdgeColor.copy(color);
      p.hiddenEdgeColor.set(0x000000);
      p.edgeStrength = 3;
      p.edgeGlow = 0.85;
      p.edgeThickness = 1.6;
      p.enabled = false;
      composer.addPass(p);
      return p;
    };
    this.passes = { green: make(COLORS.green), yellow: make(COLORS.yellow), red: make(COLORS.red) };
    const lines = new RenderPass(this.lineScene, this.camera);
    lines.clear = false;
    composer.addPass(lines);
    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  private setupInteraction() {
    const controls = new OrbitControls(this.camera, this.canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.rotateSpeed = 0.6;
    controls.zoomSpeed = 0.7;
    controls.enabled = false;
    this.controls = controls;
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerleave', this.onLeave);
  }

  // ---- Pointer ----

  private pick(e: PointerEvent): number | null {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const ghosts = this.bundles.flatMap((b) => b.holders.map((h) => h.ghost));
    const hit = this.raycaster.intersectObjects(ghosts, false)[0];
    return hit ? (hit.object.userData.h as number) : null;
  }

  private onDown = (e: PointerEvent) => {
    this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private onUp = (e: PointerEvent) => {
    const d = this.downAt;
    this.downAt = null;
    if (!d || this.camAnim) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 600) return; // that was a drag
    this.opts.onPick?.(this.pick(e));
  };

  private onMove = (e: PointerEvent) => {
    if (e.buttons || this.camAnim) return;
    const h = this.pick(e);
    if (h !== this.hovered) {
      this.hovered = h;
      this.canvas.style.cursor = h !== null ? 'pointer' : 'grab';
      this.opts.onHover?.(h);
    }
  };

  private onLeave = () => {
    if (this.hovered !== null) {
      this.hovered = null;
      this.opts.onHover?.(null);
    }
  };

  // ---- Public API ----

  setStatuses(status: Record<number, CaleStatus>, verified: boolean) {
    this.verified = verified;
    for (const b of this.bundles) b.status = status[b.h] ?? 'present';
  }

  setSelected(h: number | null) {
    if (h !== this.selected) this.preview = null;
    this.selected = h;
    if (h !== null) this.updatePresentPose();
  }

  /** Highlights a pair from outside (the height buttons), like pointing at it. */
  setHovered(h: number | null) {
    this.hovered = h;
  }

  setPreview(p: Preview) {
    if (p !== this.preview) this.previewStart = performance.now();
    this.preview = p;
  }

  /** Every pair lights up green, one after the other from left to right. */
  celebrate() {
    this.waveStart = performance.now();
  }

  /** Space covered by the page's own buttons around the picture (px): the box is framed inside the rest. */
  setInsets(i: Insets) {
    this.insets = { ...i };
    this.refit();
  }

  setTheme(theme: Theme) {
    this.opts.theme = theme;
    this.floorMat.opacity = theme === 'dark' ? 0.45 : 0.22;
    const cv = makeCanvas(512, 512);
    const ctx = cv.getContext('2d')!;
    const g = ctx.createRadialGradient(256, 200, 20, 256, 256, 400);
    if (theme === 'dark') {
      g.addColorStop(0, '#1e2635');
      g.addColorStop(1, '#0a0e14');
    } else {
      g.addColorStop(0, '#ffffff');
      g.addColorStop(1, '#dce3eb');
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 512);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    (this.scene.background as THREE.Texture | null)?.dispose?.();
    this.scene.background = t;
  }

  /** The lid opens while the camera moves in. */
  open() {
    const now = performance.now();
    const fitted = this.fit(VIEW_OPEN, LID_OPEN);
    this.lidAnim = { from: this.lidAngle, to: LID_OPEN, t0: now, dur: this.reduceMotion ? 0.01 : 0.95, delay: this.reduceMotion ? 0 : 0.12 };
    this.animateView(fitted, this.reduceMotion ? 0.01 : 1, () => {
      this.enableOrbit(fitted);
      this.updatePresentPose();
    });
  }

  /** The pairs go back, the lid closes, the camera moves out. Resolves when done. */
  close(): Promise<void> {
    this.selected = null;
    this.preview = null;
    if (this.controls) this.controls.enabled = false;
    const now = performance.now();
    this.lidAnim = { from: this.lidAngle, to: 0, t0: now, dur: this.reduceMotion ? 0.01 : 0.7, delay: this.reduceMotion ? 0 : 0.15 };
    return new Promise((resolve) => this.animateView(this.fit(VIEW_CLOSED, 0), this.reduceMotion ? 0.01 : 0.85, resolve));
  }

  resize(w: number, h: number) {
    this.size = { w: Math.max(1, w), h: Math.max(1, h) };
    this.renderer.setSize(this.size.w, this.size.h, false);
    this.camera.aspect = this.size.w / this.size.h;
    this.camera.updateProjectionMatrix();
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(this.size.w, this.size.h);
    for (const m of this.lineMats) m.resolution.set(this.size.w, this.size.h);
    this.refit();
  }

  /** Builds the cales if the scene was made without them (they are only seen once the lid opens). */
  buildContents() {
    if (!this.bundles.length) this.buildBundles();
    for (const m of this.lineMats) m.resolution.set(this.size.w, this.size.h);
  }

  /** Where the closed box is drawn right now, in CSS pixels of the canvas. */
  closedBoxRect(): Rect {
    return this.projectRect(this.boundsPoints(0));
  }

  /**
   * A picture of the closed box on a transparent background (for the machine page), and where the
   * box sits in it. Leaves the live view as it was.
   */
  snapshot(w: number, h: number): { url: string; box: Rect; w: number; h: number } {
    const keep = { size: { ...this.size }, insets: this.insets, bg: this.scene.background, view: copyView(this.view), lid: this.lidAngle };
    this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    this.snapMargin = 0.03;
    this.lidAngle = 0;
    this.applyLid();
    this.size = { w, h };
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.setView(this.fit(VIEW_CLOSED, 0));
    this.scene.background = null;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
    const url = this.canvas.toDataURL('image/webp', 0.92); // PNG where WebP cannot be written
    const box = this.closedBoxRect();
    this.scene.background = keep.bg;
    this.insets = keep.insets;
    this.snapMargin = null;
    this.lidAngle = keep.lid;
    this.applyLid();
    this.size = keep.size;
    this.renderer.setSize(keep.size.w, keep.size.h, false);
    this.camera.aspect = keep.size.w / keep.size.h;
    this.camera.updateProjectionMatrix();
    this.setView(keep.view);
    return { url, box, w, h };
  }

  start() {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      this.frame(t);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Stops drawing (nothing on screen changes while the box is put away). */
  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** One frame now. */
  renderStill() {
    this.frame(performance.now());
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    this.controls?.dispose();
    this.composer?.dispose();
    if (this.passes) Object.values(this.passes).forEach((p) => p.dispose());
    const seen = new Set<unknown>();
    const freeMaterial = (mat: THREE.Material) => {
      if (seen.has(mat)) return;
      seen.add(mat);
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
      mat.dispose();
    };
    const free = (o: THREE.Object3D) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !seen.has(m.geometry)) {
        seen.add(m.geometry);
        m.geometry.dispose();
      }
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      mats.forEach(freeMaterial);
    };
    this.scene.traverse(free);
    this.lineScene.traverse(free);
    for (const c of [this.damaged, this.healthy])
      for (const v of c.values()) {
        if (!seen.has(v.geo)) v.geo.dispose();
        v.mats.forEach(freeMaterial);
      }
    freeMaterial(this.wallMat);
    (this.scene.background as THREE.Texture | null)?.dispose?.();
    this.envTex.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss(); // browsers allow only a few live 3D views: give this one back now
  }

  // ---- Camera ----

  private setView(v: View) {
    this.view = copyView(v);
    const p = new THREE.Vector3().setFromSphericalCoords(v.dist, v.pol, v.az).add(v.target);
    this.camera.position.copy(p);
    this.camera.lookAt(v.target);
  }

  private enableOrbit(v: View) {
    const c = this.controls;
    if (!c) return;
    c.target.copy(v.target);
    c.minDistance = v.dist * 0.6;
    c.maxDistance = v.dist * 1.35;
    c.minAzimuthAngle = v.az - 0.75;
    c.maxAzimuthAngle = v.az + 0.75;
    c.minPolarAngle = 0.3;
    c.maxPolarAngle = 1.25;
    c.enabled = true;
    c.update();
    this.canvas.style.cursor = 'grab';
  }

  /** Frames the box again for the current size (resets a turned view). */
  private refit() {
    if (this.camAnim) return;
    const open = this.lidAngle < -1;
    const v = this.fit(open ? VIEW_OPEN : VIEW_CLOSED, this.lidAngle);
    this.setView(v);
    if (open && this.controls?.enabled) this.enableOrbit(v);
    if (this.selected !== null) this.updatePresentPose();
  }

  /** The visible part of the view not covered by the page's buttons, as tangents (x right, y up). */
  private freeArea() {
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const tanH = tanV * this.camera.aspect;
    const { w, h } = this.size;
    const i = this.insets;
    let x0 = -tanH + (2 * tanH * i.left) / w;
    let x1 = tanH - (2 * tanH * i.right) / w;
    let y0 = -tanV + (2 * tanV * i.bottom) / h;
    let y1 = tanV - (2 * tanV * i.top) / h;
    if (x1 - x0 < tanH * 0.8) [x0, x1] = [(x0 + x1) / 2 - tanH * 0.4, (x0 + x1) / 2 + tanH * 0.4];
    if (y1 - y0 < tanV * 0.8) [y0, y1] = [(y0 + y1) / 2 - tanV * 0.4, (y0 + y1) / 2 + tanV * 0.4];
    return { x0, x1, y0, y1, tanV };
  }

  /** Corners of the box with its lid at a given angle (handles included). */
  private boundsPoints(lidAngle: number) {
    const pts: THREE.Vector3[] = [];
    const c = Math.cos(lidAngle);
    const s = Math.sin(lidAngle);
    for (const x of [-OUT_W / 2, OUT_W / 2]) {
      for (const y of [0, BASE_H]) for (const z of [-OUT_D / 2, OUT_D / 2 + 5]) pts.push(new THREE.Vector3(x, y, z));
      for (const ly of [0, LID_H])
        for (const lz of [0, OUT_D + 22]) pts.push(new THREE.Vector3(x, BASE_H + ly * c - lz * s, -OUT_D / 2 + ly * s + lz * c));
    }
    return pts;
  }

  /** Same direction as `base`, moved so the whole box fills the free area of the view. */
  private fit(base: View, lidAngle: number): View {
    // The closed box stays smaller than the open one, so opening also feels like coming closer.
    const margin = this.snapMargin ?? (lidAngle < -1 ? 0.06 : 0.3);
    const pts = this.boundsPoints(lidAngle);
    const { x0, x1, y0, y1 } = this.freeArea();
    const f = new THREE.Vector3().setFromSphericalCoords(1, base.pol, base.az).negate();
    const r = new THREE.Vector3().crossVectors(f, UP).normalize();
    const u = new THREE.Vector3().crossVectors(r, f).normalize();
    const target = base.target.clone();
    let dist = base.dist;
    const q = new THREE.Vector3();
    for (let it = 0; it < 8; it++) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of pts) {
        q.copy(p).sub(target);
        const z = q.dot(f) + dist;
        const sx = q.dot(r) / z;
        const sy = q.dot(u) / z;
        minX = Math.min(minX, sx);
        maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy);
        maxY = Math.max(maxY, sy);
      }
      const scale = Math.max((maxX - minX) / ((x1 - x0) * (1 - margin)), (maxY - minY) / ((y1 - y0) * (1 - margin)));
      target.addScaledVector(r, ((minX + maxX) / 2 - (x0 + x1) / 2) * dist);
      target.addScaledVector(u, ((minY + maxY) / 2 - (y0 + y1) / 2) * dist);
      dist *= scale;
    }
    return { az: base.az, pol: base.pol, dist, target };
  }

  private currentView(): View {
    if (!this.controls?.enabled) return copyView(this.view);
    const target = this.controls.target.clone();
    const s = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(target));
    return { az: s.theta, pol: s.phi, dist: s.radius, target };
  }

  private animateView(to: View, dur: number, done?: () => void) {
    const from = this.currentView();
    this.camAnim = { from, to, t0: performance.now(), dur, done };
  }

  /**
   * Where a picked pair is held up to look at: between the camera and the box, a little above the
   * middle of the free area, facing the camera with a slight turn so its top edge and front end show.
   */
  private updatePresentPose() {
    const v = this.camAnim ? this.camAnim.to : this.currentView();
    const cam = new THREE.Vector3().setFromSphericalCoords(v.dist, v.pol, v.az).add(v.target);
    const f = v.target.clone().sub(cam).normalize();
    const r = new THREE.Vector3().crossVectors(f, UP).normalize();
    const u = new THREE.Vector3().crossVectors(r, f).normalize();
    const { x0, x1, y0, y1, tanV } = this.freeArea();
    const depth = v.dist * 0.5;
    const pos = cam
      .clone()
      .addScaledVector(f, depth)
      .addScaledVector(r, ((x0 + x1) / 2) * depth)
      .addScaledVector(u, ((y0 + y1) / 2 + tanV * 0.16) * depth);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(cam, pos, UP)); // +z towards the camera
    q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.24, -0.32, 0)));
    q.multiply(new THREE.Quaternion().setFromAxisAngle(UP, Math.PI / 2)); // length across the view
    this.present.pos.copy(pos);
    this.present.quat.copy(q);
  }

  private projectRect(pts: THREE.Vector3[]): Rect {
    this.camera.updateMatrixWorld();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const v = new THREE.Vector3();
    for (const p of pts) {
      v.copy(p).project(this.camera);
      const x = ((v.x + 1) / 2) * this.size.w;
      const y = ((1 - v.y) / 2) * this.size.h;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  private applyLid() {
    this.lid.rotation.x = this.lidAngle;
  }

  // ---- Frame ----

  private frame(t: number) {
    if (this.disposed) return;
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    const k = (rate: number) => 1 - Math.exp(-dt * rate);

    // Camera move.
    if (this.camAnim) {
      const a = this.camAnim;
      const p = easeInOut(clamp01((t - a.t0) / 1000 / a.dur));
      this.setView({
        az: a.from.az + (a.to.az - a.from.az) * p,
        pol: a.from.pol + (a.to.pol - a.from.pol) * p,
        dist: a.from.dist + (a.to.dist - a.from.dist) * p,
        target: a.from.target.clone().lerp(a.to.target, p),
      });
      if (p >= 1) {
        this.camAnim = null;
        a.done?.();
      }
    } else if (this.controls?.enabled) {
      this.controls.update();
    }

    // Lid.
    if (this.lidAnim) {
      const a = this.lidAnim;
      const p = easeInOut(clamp01(((t - a.t0) / 1000 - a.delay) / a.dur));
      this.lidAngle = a.from + (a.to - a.from) * p;
      this.applyLid();
      if (p >= 1) this.lidAnim = null;
    }

    // Pairs: chase their targets. Going up they lift first, coming back they line up first.
    const outlinePhase = Math.floor((t - this.previewStart) / 700) % 2 === 0; // starts on the outline
    const glow = { green: [] as THREE.Object3D[], yellow: [] as THREE.Object3D[], red: [] as THREE.Object3D[] };
    const restQ = new THREE.Quaternion();
    const tp = new THREE.Vector3();
    for (const b of this.bundles) {
      const isSel = this.selected === b.h;
      const wave = this.waveStart >= 0 ? (t - this.waveStart) / 1000 - b.i * 0.055 : -1;
      const hop = !this.reduceMotion && wave > 0 && wave < 0.34 ? Math.sin((wave / 0.34) * Math.PI) * 7 : 0;
      let tq = restQ;
      let spread = 0;
      if (isSel) {
        tp.copy(this.present.pos);
        tq = this.present.quat;
        spread = 1;
      } else {
        tp.set(slotX(b.i), restY(b.h) + hop + (this.hovered === b.h ? 5 : 0), SLOT_ZC);
      }
      const fast = this.reduceMotion ? 60 : 0;
      const rising = tp.y > b.pos.y + 1;
      const ry = fast || (rising ? 15 : 7);
      const rxz = fast || (rising ? 7 : 13);
      b.pos.x += (tp.x - b.pos.x) * k(rxz);
      b.pos.z += (tp.z - b.pos.z) * k(rxz);
      b.pos.y += (tp.y - b.pos.y) * k(ry);
      b.quat.slerp(tq, k(fast || 9));
      b.spread += (spread - b.spread) * k(fast || 9);
      b.group.position.copy(b.pos);
      b.group.quaternion.copy(b.quat);
      const off = T / 2 + PAIR_GAP / 2;
      b.holders.forEach((hd, idx) => {
        const sign = idx === 0 ? -1 : 1;
        hd.group.position.set(sign * off * (1 - b.spread), sign * (b.h / 2 + 5) * b.spread, 0);
      });

      // What it looks like now.
      const previewing = isSel ? this.preview : null;
      let solid = b.status !== 'missing';
      let damagedLook = b.status === 'damaged';
      let color: keyof typeof glow | null = b.status === 'missing' ? 'red' : b.status === 'damaged' ? 'yellow' : this.verified ? 'green' : null;
      if (color === 'green' && this.waveStart >= 0 && wave < 0) color = null; // the wave has not reached it yet
      if (previewing === 'missing') {
        solid = !outlinePhase;
        color = 'red';
      } else if (previewing === 'damaged') {
        solid = true;
        damagedLook = true;
        color = b.status === 'damaged' ? 'yellow' : null;
      }
      const look = this.looks(b.h, damagedLook);
      for (const hd of b.holders) {
        if (hd.mesh.geometry !== look.geo) {
          hd.mesh.geometry = look.geo;
          hd.mesh.material = look.mats;
        }
        hd.mesh.visible = solid;
        hd.lines.visible = !solid;
        if (color) glow[color].push(solid ? hd.mesh : hd.ghost);
      }
    }
    if (this.waveStart >= 0 && (t - this.waveStart) / 1000 > N * 0.055 + 0.4) this.waveStart = -1;

    this.scene.updateMatrixWorld();
    for (const b of this.bundles)
      for (const hd of b.holders) {
        hd.lines.matrix.copy(hd.group.matrixWorld);
        hd.lines.matrixWorldNeedsUpdate = true;
      }

    if (this.composer && this.passes) {
      for (const c of ['green', 'yellow', 'red'] as const) {
        this.passes[c].selectedObjects = glow[c];
        this.passes[c].enabled = glow[c].length > 0;
      }
      this.composer.render(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
}
