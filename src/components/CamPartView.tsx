import { useEffect, useRef } from 'react';
import { holeOfMesh, type MeasureMode } from '../lib/measure';
import { attachMeasure, type Measurement } from '../lib/measure3d';
import * as THREE from 'three';
import { Orbit } from '../lib/orbit';
import { addLights } from '../lib/lights';
import { SIDES } from '../lib/cam/features';
import type { Mat3 } from '../lib/orient';
import type { Purpose } from '../lib/cam/program';
import { fmtNumber } from '../i18n/format';
import { buildParallels, buildVise, JAW_TOPS, PLANE_EPS } from '../lib/vise3d';
import { jawsFrom, parallelWidth, VISE, viseSpans } from '../lib/setups';
import { PARALLEL_LENGTH } from '../lib/cam/physics';
import { JAW } from '../lib/cam/clamp';

/** A setup's top face on the model: the side it faces, and the flat face clicked (else the outermost of that side). */
export interface FacePick {
  side: string;
  face?: string;
  /** Locked (confirmed) or CAM AI's proposal. */
  locked: boolean;
}

/** An operation's feed moves (x0 y0 z0 x1 y1 z1 ..., the model centred on its box). */
export interface LivePath {
  purpose: Purpose;
  pts: number[];
  /** The operation it is (CamOp.key) and its tool's code: what a selection in the browser shows. */
  key?: string;
  tool?: string;
}

/** Roughing yellow, finishing cyan, drilling red. */
const PATH_COLOR: Record<Purpose, number> = {
  face: 0xfacc15,
  outline: 0xfacc15,
  rough: 0xfacc15,
  rest: 0xfacc15,
  finish: 0x22d3ee,
  contour: 0x22d3ee,
  thinWalls: 0x22d3ee,
  chamfer: 0x22d3ee,
  engrave: 0x22d3ee,
  centre: 0xef4444,
  drill: 0xef4444,
  pinHoles: 0xef4444,
};

const HOVER = 0x2f80ff;
const PICKED = 0x22c55e;
const AMBER = 0xf5a524;
/** Walls picked to finish (the finishing paths' cyan). */
const FINISH = 0x22d3ee;

/**
 * The model's walls as setup 1 stands (`up`: its Z in the model's frame): triangles facing sideways, joined
 * across shared edges where they turn less than 40° (a curved wall is one patch; two walls meeting at a
 * corner are two). `patchOf[k]`: triangle k's patch, -1 for none.
 */
export function wallPatches(pos: ArrayLike<number>, up: number[]): { patchOf: Int32Array; patches: number[][] } {
  const n = Math.floor(pos.length / 9);
  const nrm = new Float32Array(n * 3);
  const patchOf = new Int32Array(n).fill(-1);
  const root = new Int32Array(n).map((_, k) => k);
  const find = (k: number): number => (root[k] === k ? k : (root[k] = find(root[k])));
  const edges = new Map<string, number[]>();
  const key = (i: number) => `${Math.round(pos[i] * 1000)},${Math.round(pos[i + 1] * 1000)},${Math.round(pos[i + 2] * 1000)}`;
  for (let k = 0; k < n; k++) {
    const o = k * 9;
    const u = [pos[o + 3] - pos[o], pos[o + 4] - pos[o + 1], pos[o + 5] - pos[o + 2]];
    const v = [pos[o + 6] - pos[o], pos[o + 7] - pos[o + 1], pos[o + 8] - pos[o + 2]];
    const c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(c[0], c[1], c[2]);
    if (!len || Math.abs(c[0] * up[0] + c[1] * up[1] + c[2] * up[2]) / len > 0.3) continue;
    for (let j = 0; j < 3; j++) nrm[k * 3 + j] = c[j] / len;
    patchOf[k] = 0;
    const vs = [key(o), key(o + 3), key(o + 6)];
    for (let j = 0; j < 3; j++) {
      const [a, b] = [vs[j], vs[(j + 1) % 3]];
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      (edges.get(e) ?? edges.set(e, []).get(e)!).push(k);
    }
  }
  const cos40 = Math.cos((40 * Math.PI) / 180);
  for (const ts of edges.values())
    for (let i = 1; i < ts.length; i++) {
      const [p, q] = [ts[0], ts[i]];
      if (nrm[p * 3] * nrm[q * 3] + nrm[p * 3 + 1] * nrm[q * 3 + 1] + nrm[p * 3 + 2] * nrm[q * 3 + 2] > cos40) root[find(q)] = find(p);
    }
  const ids = new Map<number, number>();
  const patches: number[][] = [];
  for (let k = 0; k < n; k++) {
    if (patchOf[k] < 0) continue;
    const r = find(k);
    let id = ids.get(r);
    if (id === undefined) ids.set(r, (id = patches.push([]) - 1));
    patchOf[k] = id;
    patches[id].push(k);
  }
  return { patchOf, patches };
}

interface Face {
  side: string;
  /** Where it lies along its normal (the outermost of a side is the top). */
  plane: number;
  tris: number[];
  area: number;
  centre: THREE.Vector3;
}

/**
 * The model's flat faces that face along an axis (the only ones a setup can have on top), each a
 * group of coplanar triangles; a key per triangle (null for slanted or curved ones).
 */
function flatFaces(pos: Float32Array): { faces: Map<string, Face>; keyOf: (string | null)[] } {
  const faces = new Map<string, Face>();
  const keyOf: (string | null)[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.length; i += 9) {
    a.fromArray(pos, i);
    b.fromArray(pos, i + 3);
    c.fromArray(pos, i + 6);
    n.subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b));
    const area = n.length() / 2;
    n.normalize();
    const axis = [0, 1, 2].find((k) => Math.abs(n.getComponent(k)) > 0.999);
    if (axis === undefined || area < 1e-9) {
      keyOf.push(null);
      continue;
    }
    const sign = Math.sign(n.getComponent(axis));
    const side = SIDES.find((s) => s.d[axis] === sign)!.name;
    const plane = a.getComponent(axis) * sign;
    const key = `${side}:${Math.round(plane * 50)}`;
    keyOf.push(key);
    const f = faces.get(key) ?? { side, plane, tris: [], area: 0, centre: new THREE.Vector3() };
    f.tris.push(i / 9);
    f.centre.addScaledVector(new THREE.Vector3().add(a).add(b).add(c).divideScalar(3), area);
    f.area += area;
    faces.set(key, f);
  }
  for (const f of faces.values()) f.centre.divideScalar(f.area);
  return { faces, keyOf };
}

/** The face shown for a pick: the one clicked, else the biggest outermost one of its side. */
function faceFor(faces: Map<string, Face>, p: FacePick): [string, Face] | null {
  if (p.face && faces.has(p.face)) return [p.face, faces.get(p.face)!];
  const ofSide = [...faces.entries()].filter(([, f]) => f.side === p.side);
  if (!ofSide.length) return null;
  const top = Math.max(...ofSide.map(([, f]) => f.plane));
  return ofSide.filter(([, f]) => f.plane > top - 0.05).sort((x, y) => y[1].area - x[1].area)[0];
}

function overlay(pos: Float32Array, tris: number[], color: number, opacity: number): THREE.Mesh {
  const out = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => out.set(pos.subarray(t * 9, t * 9 + 9), i * 9));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
  m.renderOrder = 2;
  return m;
}

/** A label on a dark pill (readable on the light and the dark theme), always in front. */
function tag(text: string, color = '#ffffff'): THREE.Sprite {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = '600 40px Inter, system-ui, sans-serif';
  const w = Math.ceil(ctx.measureText(text).width) + 36;
  c.width = w;
  c.height = 60;
  ctx.font = '600 40px Inter, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(15,20,30,0.82)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, 60, 18);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 18, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.renderOrder = 10;
  s.userData.aspect = w / 60;
  return s;
}

/** X, Y, Z arrows at a face, +Z along its outward normal (model frame). */
function triad(at: THREE.Vector3, normal: THREE.Vector3, size: number, label: string): THREE.Group {
  const g = new THREE.Group();
  const z = normal.clone().normalize();
  // X and Y in the face: the model axes it holds, in order.
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].filter((v) => Math.abs(v.dot(z)) < 0.5);
  const x = axes[0];
  const y = z.clone().cross(x);
  for (const [d, color] of [[x, 0xef4444], [y, 0x22c55e], [z, 0x3b82f6]] as const) {
    const arrow = new THREE.ArrowHelper(d, at, size, color, size * 0.28, size * 0.14);
    arrow.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.depthTest = false;
      o.renderOrder = 9;
    });
    g.add(arrow);
  }
  const t = tag(label, '#86efac');
  const h = size * 0.32;
  t.scale.set(h * t.userData.aspect, h, 1);
  t.position.copy(at).addScaledVector(z, size * 1.25);
  g.add(t);
  return g;
}

function dispose(o: THREE.Object3D) {
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((y) => {
      (y as THREE.SpriteMaterial).map?.dispose();
      y.dispose();
    });
  });
}

type Api = {
  invalidate: () => void;
  world: THREE.Group;
  part: THREE.Mesh;
  faces: Map<string, Face>;
  keyOf: (string | null)[];
  pos: Float32Array;
  size: number;
  /** The model's box size along its own axes (mm). */
  ext: THREE.Vector3;
  hover: THREE.Mesh | null;
  marks: THREE.Group;
  stock: THREE.Group;
  paths: THREE.Group;
  /** Removed operations' paths. */
  ghosts: THREE.Group;
  /** The walls picked to finish (cyan). */
  walls: THREE.Group;
  /** The model's walls as setup 1 stands (wallPatches), for picking them. */
  patches: ReturnType<typeof wallPatches>;
  camera: THREE.PerspectiveCamera;
  /** Called after each frame drawn (measuring's labels follow the part). */
  afterRender: (() => void) | null;
  /** Clamping 1's vise and parallels (clamp mode), and a camera move that frames them. */
  vise: THREE.Group;
  /** The vise's bed, jaw faces and stop face as planes to measure to (clamp mode; in the part's frame, not drawn). */
  planes: THREE.Mesh[];
  /** What hides the part from a measuring click in the clamp: the vise and the parallels (not the contact marks). */
  blockers: THREE.Object3D[];
  frame: (radius: number) => void;
};

/**
 * Clamping 1 as the designer sets it up (you, Beta 2): its parallels (0: none, the part on the jaws' step, drawn at
 * `at` with the jaws lit, its real height not known), the moving jaw `open` mm off, the part slid `slide` mm toward
 * the operator (view only), `next` the next taller parallels shown faintly while choosing, `flash` counting refused moves,
 * `bad`: parallels that cannot hold it (yellow), `stop`: the spacer between the stop and the part (mm).
 */
/** The measure's vise planes: hit by a click from either side, never drawn. */
const PLANE = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, visible: false });

export type ClampView = { cale: number; at: number; open: number; slide: number; next?: number; flash: number; bad?: boolean; stop?: number; y?: number; yp?: number };
export type ClampAct = 'up' | 'down' | 'back' | 'forward' | 'open' | 'close';
const CONTACT = 0x22c55e;

/**
 * The part in 3D for CAM AI: as it lies in setup 1 (X along the jaws, Z up), the raw block around
 * it (amber, with its X, Y, Z), the setups' top faces (green, with an X Y Z triad, +Z out of the
 * face) and, while picking, the face under the pointer (blue). The paths stream in as CAM AI makes
 * them (roughing yellow, finishing cyan, drilling red).
 */
export default function CamPartView({
  tris,
  R,
  raw,
  blank,
  picks,
  picking,
  onPick,
  finish,
  white,
  paths = [],
  measure = null,
  ghosts = [],
  ghostOn = null,
  onPathMenu,
  clamp = null,
  onClamp,
  label,
  className = '',
}: {
  /** The model's triangles (9 numbers each), as read. */
  tris: Float32Array;
  /** Model -> setup 1 (rotation only). */
  R: Mat3;
  /** The raw block along the model's axes (mm), centred on the part, or none. */
  raw: number[] | null;
  /** Where the blank is (model frame, centred on the part's box): the page's, then CAM AI's once planned. */
  blank?: { lo: number[]; hi: number[] } | null;
  picks: FacePick[];
  /** Which setup a click picks the top face of (null: not picking). */
  picking: number | null;
  onPick?: (side: string, face: string) => void;
  /** Picking the walls to finish (they take precedence over `picking`): those picked, and a click's wall's triangles. */
  finish?: { on: boolean; picked: number[]; onToggle: (tris: number[]) => void };
  /** A top plate's white face: picking it (a click on a flat face gives its side), and the one picked (shown white). */
  white?: { on: boolean; side?: string; onPick: (side: string) => void };
  paths?: LivePath[];
  /** Measuring on the model, as in a CAD program (lib/measure3d.ts): what a click picks, and what it measured. */
  measure?: { mode: MeasureMode; onMeasure: (m: Measurement) => void } | null;
  /** Removed operations' paths (faded), the one picked highlighted (`ghostOn`: its key). */
  ghosts?: LivePath[];
  ghostOn?: string | null;
  /** A right click (not a drag) on a path: its operation (you, Beta 2: change its tool from there). */
  onPathMenu?: (p: LivePath) => void;
  /** Clamp mode: the vise round the blank (`blank` needed); the arrows slide and open, Page Up / Page Down step the parallels. */
  clamp?: ClampView | null;
  onClamp?: (act: ClampAct) => void;
  /** The canvas's accessible name. */
  label: string;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const pickRef = useRef({ picking, onPick, finish, white, onPathMenu, measuring: !!measure });
  pickRef.current = { picking, onPick, finish, white, onPathMenu, measuring: !!measure };
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const measureSession = useRef<ReturnType<typeof attachMeasure> | null>(null);
  const whiteSide = white?.side;
  const blankKey = blank ? [...blank.lo, ...blank.hi].join(',') : '';

  // The scene, once per model.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.setAttribute('aria-label', label);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
    const lights = addLights(scene, renderer, camera);
    let dirty = true;
    const invalidate = () => (dirty = true);
    const controls = new Orbit(camera, renderer.domElement, invalidate);

    // The model centred on its box.
    const box = new THREE.Box3();
    for (let i = 0; i < tris.length; i += 3) box.expandByPoint(new THREE.Vector3(tris[i], tris[i + 1], tris[i + 2]));
    const mid = box.getCenter(new THREE.Vector3());
    const pos = new Float32Array(tris.length);
    for (let i = 0; i < tris.length; i += 3) {
      pos[i] = tris[i] - mid.x;
      pos[i + 1] = tris[i + 1] - mid.y;
      pos[i + 2] = tris[i + 2] - mid.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const part = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc8d0db, metalness: 0.15, roughness: 0.55 }));
    const world = new THREE.Group();
    world.matrixAutoUpdate = false;
    world.add(part);
    const marks = new THREE.Group();
    const paths = new THREE.Group();
    const ghostPaths = new THREE.Group();
    const walls = new THREE.Group();
    world.add(marks, paths, ghostPaths, walls);
    const stock = new THREE.Group();
    const vise = new THREE.Group();
    scene.add(world, stock, vise);
    const size = box.getSize(new THREE.Vector3()).length();
    const { faces, keyOf } = flatFaces(pos);
    controls.pickables = () => [part];
    controls.center = () => new THREE.Vector3();

    // The part, its raw block and the block's size labels all in view: the part's sphere needs 1.67 × its diagonal at 35°.
    // shortcut: a fixed distance for a view about as wide as tall or wider; fit to the aspect if portrait views appear.
    camera.position.set(0.9, 0.75, 1.1).normalize().multiplyScalar(size * 2.1);
    camera.near = size / 100;
    camera.far = size * 50;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();

    const a: Api = { invalidate, world, part, faces, keyOf, pos, size, ext: box.getSize(new THREE.Vector3()), hover: null, marks, stock, paths, ghosts: ghostPaths, walls, patches: wallPatches(pos, [R[6], R[7], R[8]]), camera, afterRender: null, vise, planes: [], blockers: [],
      frame: (r) => controls.flyTo(camera.position.clone().normalize().multiplyScalar(r * 2.6), new THREE.Vector3(), camera.up.clone(), 450) };
    api.current = a;

    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      invalidate();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    // Picking: the flat face under the pointer, blue; a click (not a drag) picks it.
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let under: string | null = null;
    let queued: PointerEvent | null = null;
    const walling = () => !!pickRef.current.finish?.on;
    // The flat face under the pointer, or (picking walls) its wall: "w<patch>".
    const faceAt = (e: { clientX: number; clientY: number }) => {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObject(part, false)[0];
      if (hit?.faceIndex == null) return null;
      if (walling()) {
        const id = a.patches.patchOf[hit.faceIndex];
        return id >= 0 ? `w${id}` : null;
      }
      return keyOf[hit.faceIndex];
    };
    const trisOf = (key: string) => (key.startsWith('w') ? a.patches.patches[Number(key.slice(1))] : faces.get(key)!.tris);
    const showHover = (key: string | null) => {
      if (key === under) return;
      under = key;
      if (a.hover) {
        world.remove(a.hover);
        dispose(a.hover);
        a.hover = null;
      }
      if (key) {
        a.hover = overlay(pos, trisOf(key), HOVER, 0.4);
        world.add(a.hover);
      }
      renderer.domElement.style.cursor = key ? 'pointer' : '';
      invalidate();
    };
    const move = (e: PointerEvent) => {
      if ((pickRef.current.picking === null && !walling() && !pickRef.current.white?.on) || e.buttons || pickRef.current.measuring) return showHover(null);
      if (!queued) requestAnimationFrame(() => {
        if (queued) showHover(faceAt(queued));
        queued = null;
      });
      queued = e;
    };
    let down: { x: number; y: number } | null = null;
    // Where the right button went down, kept until the menu event (on Windows it comes after the button is up).
    let rightDown: { x: number; y: number } | null = null;
    const press = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
      if (e.button === 2) rightDown = down;
    };
    // A right click on a path (a right drag pans the view: not that).
    const menu = (e: MouseEvent) => {
      const cb = pickRef.current.onPathMenu;
      const d = rightDown;
      rightDown = null;
      if (!cb || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      ray.params.Line = { threshold: a.size * 0.006 };
      const p = ray.intersectObjects(a.paths.children, false)[0]?.object.userData.path as LivePath | undefined;
      if (p) cb(p);
    };
    const release = (e: PointerEvent) => {
      const d = down;
      down = null;
      const { picking: p, onPick: cb, finish: fin, white: wh, measuring } = pickRef.current;
      if (!d || measuring || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      const key = faceAt(e);
      if (!key) return;
      if (walling()) fin!.onToggle(trisOf(key));
      else if (wh?.on) wh.onPick(faces.get(key)!.side);
      else if (p !== null && cb) cb(faces.get(key)!.side, key);
    };
    const leave = () => showHover(null);
    const c = renderer.domElement;
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerdown', press);
    c.addEventListener('pointerup', release);
    c.addEventListener('pointerleave', leave);
    c.addEventListener('contextmenu', menu);

    let raf = 0;
    const loop = (now: number) => {
      controls.tick(now);
      if (dirty) {
        renderer.render(scene, camera);
        dirty = false;
        api.current?.afterRender?.();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerdown', press);
      c.removeEventListener('pointerup', release);
      c.removeEventListener('pointerleave', leave);
      c.removeEventListener('contextmenu', menu);
      controls.dispose();
      dispose(scene);
      lights.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      api.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tris]);

  // As it lies in setup 1: machine X, Y, Z -> three.js X, Z, -Y.
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    const m = new THREE.Matrix4().set(R[0], R[1], R[2], 0, R[6], R[7], R[8], 0, -R[3], -R[4], -R[5], 0, 0, 0, 0, 1);
    a.patches = wallPatches(a.pos, [R[6], R[7], R[8]]);
    a.world.matrix.copy(m);
    a.world.matrixWorldNeedsUpdate = true;
    a.invalidate();
  }, [R]);

  // The raw block, in the vise's frame, with its size along X, Y, Z.
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    dispose(a.stock);
    a.stock.clear();
    a.stock.position.set(0, 0, 0);
    if (raw) {
      // The block's size in the vise (X along the jaws, Y between them, Z up).
      const v = [0, 1, 2].map((j) => Math.abs(R[j * 3] * raw[0] + R[j * 3 + 1] * raw[1] + R[j * 3 + 2] * raw[2]));
      if (blank) {
        // Where the page puts it (clamp.ts: blankSides) or CAM AI planned it: its centre turned as the model is (X, Z, -Y).
        const c = [0, 1, 2].map((k) => (blank.lo[k] + blank.hi[k]) / 2);
        const at = (j: number) => R[j * 3] * c[0] + R[j * 3 + 1] * c[1] + R[j * 3 + 2] * c[2];
        a.stock.position.set(at(0), at(2), -at(1));
      }
      const geo = new THREE.BoxGeometry(v[0], v[2], v[1]);
      const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.1, depthWrite: false }));
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: AMBER, transparent: true, opacity: 0.95 }));
      a.stock.add(fill, edges);
      const h = Math.max(2.5, a.size * 0.045);
      const put = (text: string, at: THREE.Vector3) => {
        const s = tag(text, '#fcd34d');
        s.scale.set(h * s.userData.aspect, h, 1);
        s.position.copy(at);
        a.stock.add(s);
      };
      const [x, y, z] = [v[0] / 2, v[2] / 2, v[1] / 2];
      // Each just outside its own edge: X under the front, Y under the left end, Z by the left front corner.
      put(`X ${fmtNumber(v[0], 1)} mm`, new THREE.Vector3(0, -y - h * 0.9, z));
      put(`Y ${fmtNumber(v[1], 1)} mm`, new THREE.Vector3(-x, -y - h * 0.9, 0));
      put(`Z ${fmtNumber(v[2], 1)} mm`, new THREE.Vector3(-x - h * 1.8, 0, z));
    }
    a.invalidate();
    // By value: the page makes these arrays anew on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw?.join(','), R, blankKey]);

  // The setups' top faces: green, with their triad; and the faces under the pointer while picking.
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    dispose(a.marks);
    a.marks.clear();
    picks.forEach((p, i) => {
      const f = faceFor(a.faces, p);
      if (!f) return;
      a.marks.add(overlay(a.pos, f[1].tris, PICKED, p.locked ? 0.8 : 0.45));
      const d = SIDES.find((s) => s.name === p.side)!.d;
      a.marks.add(triad(f[1].centre, new THREE.Vector3(...d), Math.max(6, a.size * 0.16), `${i + 1}`));
    });
    a.invalidate();
  }, [picks, tris]);

  // The walls picked to finish, cyan; the white face, white.
  const picked = finish?.picked;
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    dispose(a.walls);
    a.walls.clear();
    if (picked?.length) a.walls.add(overlay(a.pos, picked, FINISH, 0.6));
    const face = whiteSide ? faceFor(a.faces, { side: whiteSide, locked: true }) : null;
    if (face) a.walls.add(overlay(a.pos, face[1].tris, 0xffffff, 0.85));
    a.invalidate();
  }, [picked, whiteSide, tris]);

  // The paths as they come.
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    dispose(a.paths);
    a.paths.clear();
    for (const p of paths) {
      if (!p.pts.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p.pts, 3));
      // Model centred on its box, as planned (program.ts centres it the same way).
      const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: PATH_COLOR[p.purpose], transparent: true, opacity: 0.9 }));
      line.userData.path = p;
      a.paths.add(line);
    }
    a.invalidate();
  }, [paths]);

  // Measuring on the model: its flat faces, its holes (fitted to their facets), points.
  const measuring = !!measure;
  useEffect(() => {
    const a = api.current;
    const el = host.current;
    if (!a || !el || !measuring) return;
    const session = (measureSession.current = attachMeasure({
      el,
      root: a.world,
      camera: a.camera,
      invalidate: a.invalidate,
      setAfterRender: (f) => (a.afterRender = f),
      parts: () => [a.part, ...a.planes],
      blockers: () => {
        const held: THREE.Object3D[] = [];
        for (const b of a.blockers) b.traverse((o) => (o as THREE.Mesh).isMesh && o.visible && held.push(o));
        return held;
      },
      holeAt: (_p, hit) => (hit.object === a.part ? holeOfMesh(a.pos, hit.faceIndex ?? 0) : null),
      mode: () => measureRef.current?.mode ?? 'faces',
      onMeasure: (m) => measureRef.current?.onMeasure(m),
    }));
    return () => {
      session.stop();
      measureSession.current = null;
    };
  }, [measuring, tris]);
  // Another mode: the picks start again.
  useEffect(() => measureSession.current?.reset(), [measure?.mode]);

  // Removed operations: where they were, faded; the one picked bright.
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    dispose(a.ghosts);
    a.ghosts.clear();
    for (const p of ghosts) {
      if (!p.pts.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p.pts, 3));
      const on = p.key === ghostOn;
      const line = new THREE.LineSegments(g, new THREE.LineDashedMaterial({ color: on ? 0xff4d6d : 0x8a94a6, dashSize: a.size * 0.01, gapSize: a.size * 0.008, transparent: true, opacity: on ? 1 : 0.35, depthTest: !on }));
      line.computeLineDistances();
      line.renderOrder = on ? 2 : 0;
      a.ghosts.add(line);
    }
    a.invalidate();
  }, [ghosts, ghostOn]);

  // The canvas's name follows the page (picking, making, the clamping editor).
  useEffect(() => {
    host.current?.querySelector('canvas')?.setAttribute('aria-label', label);
  }, [label]);

  // Clamp mode: the vise on the blank as clamping 1 holds it, its parallels, and where they touch (green).
  const lastFlash = useRef(0);
  // Where the jaw and the slide are drawn now (mm), for easing to the next.
  const jawShown = useRef({ open: 0, slide: 0 });
  const clampOn = !!clamp && !!blank;
  const clampKey = clamp ? JSON.stringify(clamp) : '';
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    dispose(a.vise);
    a.vise.clear();
    a.vise.position.set(0, 0, 0);
    if (!clamp || !blank) {
      a.planes = [];
      a.blockers = [];
      a.invalidate();
      return;
    }
    // The blank in the vise's frame (X along the jaws, Y between them, Z up), from the part's box centre.
    const c = [0, 1, 2].map((k) => (blank.lo[k] + blank.hi[k]) / 2);
    const h = [0, 1, 2].map((k) => (blank.hi[k] - blank.lo[k]) / 2);
    const vc = [0, 1, 2].map((j) => R[j * 3] * c[0] + R[j * 3 + 1] * c[1] + R[j * 3 + 2] * c[2]);
    const vh = [0, 1, 2].map((j) => Math.abs(R[j * 3]) * h[0] + Math.abs(R[j * 3 + 1]) * h[1] + Math.abs(R[j * 3 + 2]) * h[2]);
    const lo = vc.map((v, j) => v - vh[j]) as [number, number, number];
    const hi = vc.map((v, j) => v + vh[j]) as [number, number, number];
    const floorZ = lo[2] - clamp.at;
    const jawTop = floorZ + JAW;
    // Pushed against the stop; a second vise when the part is longer than one (as the shop holds long parts).
    // The spacer at the stop (15 or 50 mm) between it and the part: the vise that much further left.
    const sp = clamp.stop ?? 0;
    const jawX = jawsFrom(lo[0] - sp);
    const spans = viseSpans({ jawX, twoVises: hi[0] > jawX[0] + VISE.width + 5 });
    const v = buildVise({ min: [lo[0], lo[1]], max: [hi[0], hi[1]] }, floorZ, jawTop, spans, null, [...(sp ? [{ side: 'X-' as const, mm: sp }] : []), ...(clamp.y ? [{ side: 'Y-' as const, mm: clamp.y }] : []), ...(clamp.yp ? [{ side: 'Y+' as const, mm: clamp.yp }] : [])]);
    // The vise's model comes in once loaded: drawn again then.
    void v.ready.then(() => a.invalidate());
    // The moving jaw (front, Y-) opens toward the operator; the part slides, so the vise body moves the other way.
    const body = new THREE.Group();
    body.add(v.group);
    a.vise.add(body);
    const pose = (open: number, slide: number) => {
      v.moving.position.z = open;
      body.position.z = slide;
      jawShown.current = { open, slide };
    };
    const w = parallelWidth(hi[1] - lo[1]);
    const runs = spans.map(([x0]) => x0);
    const bars = (top: number): { y: [number, number]; top: number }[] => [{ y: [lo[1], lo[1] + w], top }, { y: [hi[1] - w, hi[1]], top }];
    // The parallels and contacts stay with the part, not the vise body.
    const put = (o: THREE.Object3D) => a.vise.add(o);
    let parallels: THREE.Group | null = null;
    if (clamp.cale > 0) {
      const p = (parallels = buildParallels(runs, PARALLEL_LENGTH, bars(lo[2]), floorZ, `${fmtNumber(clamp.cale, 0)} MM`));
      // Parallels that cannot hold the part: yellow.
      if (clamp.bad) p.traverse((o) => { const m = (o as THREE.Mesh).material; for (const x of m ? (Array.isArray(m) ? m : [m]) : []) if ('color' in x) (x as THREE.MeshStandardMaterial).color.setHex(0xfacc15); });
      put(p);
    }
    // The next taller parallels, faint, while the height is being chosen.
    if (clamp.next) {
      const ghost = buildParallels(runs, PARALLEL_LENGTH, bars(floorZ + clamp.next), floorZ, `${fmtNumber(clamp.next, 0)} MM`);
      ghost.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        for (const x of m ? (Array.isArray(m) ? m : [m]) : []) Object.assign(x, { transparent: true, opacity: 0.22, depthWrite: false });
      });
      put(ghost);
    }
    // Where the part is held: its faces in the jaws (closed, not slid) and on the parallels, green.
    // Seen through the jaws and the parallels: the faces they touch are behind them.
    const contact = new THREE.MeshBasicMaterial({ color: CONTACT, transparent: true, opacity: 0.6, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    const plate = (min: number[], max: number[]) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(max[0] - min[0], max[2] - min[2], max[1] - min[1]), contact);
      m.position.set((min[0] + max[0]) / 2, (min[2] + max[2]) / 2, -(min[1] + max[1]) / 2);
      m.renderOrder = 6;
      put(m);
    };
    const x1 = Math.min(hi[0], spans[spans.length - 1][1]);
    if (clamp.open === 0 && clamp.slide === 0) {
      const top = Math.min(jawTop, hi[2]);
      plate([lo[0], lo[1] - 0.4, lo[2]], [x1, lo[1] - 0.1, top]);
      plate([lo[0], hi[1] + 0.1, lo[2]], [x1, hi[1] + 0.4, top]);
    }
    if (clamp.cale > 0) for (const b of bars(lo[2])) plate([lo[0], b.y[0], lo[2] - 0.4], [Math.min(hi[0], runs[0] + PARALLEL_LENGTH), b.y[1], lo[2] - 0.1]);
    // On the jaws' step (no parallels): the jaws lit; a refused move: yellow for a moment.
    const lit = (color: number, k: number) => v.jawMats.forEach((m) => { m.emissive.setHex(color); m.emissiveIntensity = k; });
    const steady = (): [number, number] => (clamp.bad ? [0xfacc15, 0.7] : clamp.cale === 0 ? [0x2dd4bf, 0.45] : [0x000000, 0]);
    lit(...steady());
    // The jaw and the slide ease to where they go (not with reduced motion).
    const from = jawShown.current;
    let anim = 0;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || (from.open === clamp.open && from.slide === clamp.slide)) pose(clamp.open, clamp.slide);
    else {
      const t0 = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / 140);
        const e = 1 - (1 - k) ** 3;
        pose(from.open + (clamp.open - from.open) * e, from.slide + (clamp.slide - from.slide) * e);
        a.invalidate();
        if (k < 1) anim = requestAnimationFrame(step);
      };
      pose(from.open, from.slide);
      anim = requestAnimationFrame(step);
    }
    // What a measure takes as planes (item 17): the bed between the jaws, both jaw faces and tops, the stop's face. Quads in
    // the vise's frame, raycast but not drawn (the measure turns them into the part's frame when picked).
    const xa = spans[0][0];
    const xb = spans[spans.length - 1][1];
    const front = lo[1] - (clamp.y ?? 0);
    const back = hi[1] + (clamp.yp ?? 0);
    const e = PLANE_EPS;
    const quad = (p: [number, number, number][]) => {
      const q = p.map(([x, y, z]) => new THREE.Vector3(x, z, -y));
      const m = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([q[0], q[1], q[2], q[0], q[2], q[3]]), PLANE);
      a.vise.add(m);
      return m;
    };
    // Just off each face on its open side, so a click on the drawn face finds its plane before the vise.
    a.planes = [
      quad([[xa, front, floorZ + e], [xb, front, floorZ + e], [xb, back, floorZ + e], [xa, back, floorZ + e]]),
      quad([[xa, front + e, floorZ], [xa, front + e, jawTop], [xb, front + e, jawTop], [xb, front + e, floorZ]]),
      quad([[xa, back - e, floorZ], [xb, back - e, floorZ], [xb, back - e, jawTop], [xa, back - e, jawTop]]),
      quad([[xa + e, front, floorZ], [xa + e, back, floorZ], [xa + e, back, jawTop], [xa + e, front, jawTop]]),
      // The jaw tops (plate and block, flush): how far the part stands above them.
      quad([[xa, front - JAW_TOPS.moving, jawTop + e], [xb, front - JAW_TOPS.moving, jawTop + e], [xb, front, jawTop + e], [xa, front, jawTop + e]]),
      quad([[xa, back, jawTop + e], [xb, back, jawTop + e], [xb, back + JAW_TOPS.fixed, jawTop + e], [xa, back + JAW_TOPS.fixed, jawTop + e]]),
    ];
    a.blockers = [body, ...(parallels ? [parallels] : [])];
    let timer = 0;
    if (clamp.flash !== lastFlash.current) {
      lastFlash.current = clamp.flash;
      lit(0xfacc15, 0.9);
      timer = window.setTimeout(() => {
        lit(...steady());
        a.invalidate();
      }, 600);
    }
    a.invalidate();
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(anim);
    };
    // By value: the page makes these objects anew on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clampKey, blankKey, R]);

  // Entering clamp mode: the camera backs off to show the vise.
  useEffect(() => {
    const a = api.current;
    if (a && clampOn) a.frame(Math.max(a.size * 1.2, 70));
  }, [clampOn]);

  const KEYS: Record<string, ClampAct> = { ArrowUp: 'back', ArrowDown: 'forward', ArrowLeft: 'open', ArrowRight: 'close', PageUp: 'up', PageDown: 'down' };

  return (
    <div
      ref={host}
      tabIndex={clampOn ? 0 : undefined}
      onKeyDown={
        clampOn
          ? (e) => {
              const act = KEYS[e.key];
              if (!act) return;
              e.preventDefault();
              onClamp?.(act);
            }
          : undefined
      }
      className={`relative overflow-hidden rounded-[var(--radius-md)] bg-[rgba(var(--ov),0.04)] focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)] ${className}`}
    />
  );
}
