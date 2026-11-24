import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { Orbit } from '../lib/orbit';
import { addLights } from '../lib/lights';
import { SIDES } from '../lib/cam/features';
import type { Mat3 } from '../lib/orient';
import type { Purpose } from '../lib/cam/program';
import { fmtNumber } from '../i18n/format';

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
};

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
  ghosts = [],
  ghostOn = null,
  onPathMenu,
  label,
  className = '',
}: {
  /** The model's triangles (9 numbers each), as read. */
  tris: Float32Array;
  /** Model -> setup 1 (rotation only). */
  R: Mat3;
  /** The raw block along the model's axes (mm), centred on the part, or none. */
  raw: number[] | null;
  /** Where CAM AI planned the blank (model frame, centred on its box), once it has. */
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
  /** Removed operations' paths (faded), the one picked highlighted (`ghostOn`: its key). */
  ghosts?: LivePath[];
  ghostOn?: string | null;
  /** A right click (not a drag) on a path: its operation (you, Beta 2: change its tool from there). */
  onPathMenu?: (p: LivePath) => void;
  /** The canvas's accessible name. */
  label: string;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const pickRef = useRef({ picking, onPick, finish, white, onPathMenu });
  pickRef.current = { picking, onPick, finish, white, onPathMenu };
  const whiteSide = white?.side;

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
    scene.add(world, stock);
    const size = box.getSize(new THREE.Vector3()).length();
    const { faces, keyOf } = flatFaces(pos);
    controls.pickables = () => [part];
    controls.center = () => new THREE.Vector3();

    camera.position.set(0.9, 0.75, 1.1).normalize().multiplyScalar(size * 1.55);
    camera.near = size / 100;
    camera.far = size * 50;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();

    const a: Api = { invalidate, world, part, faces, keyOf, pos, size, ext: box.getSize(new THREE.Vector3()), hover: null, marks, stock, paths, ghosts: ghostPaths, walls, patches: wallPatches(pos, [R[6], R[7], R[8]]) };
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
      if ((pickRef.current.picking === null && !walling() && !pickRef.current.white?.on) || e.buttons) return showHover(null);
      if (!queued) requestAnimationFrame(() => {
        if (queued) showHover(faceAt(queued));
        queued = null;
      });
      queued = e;
    };
    let down: { x: number; y: number } | null = null;
    const press = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    // A right click on a path (a right drag pans the view: not that).
    const menu = (e: MouseEvent) => {
      const cb = pickRef.current.onPathMenu;
      const d = down;
      if (!cb || (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4)) return;
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
      const { picking: p, onPick: cb, finish: fin, white: wh } = pickRef.current;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
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
        // Where CAM AI planned it (also centred, its fallback): its centre turned as the model is (X, Z, -Y).
        const c = [0, 1, 2].map((k) => (blank.lo[k] + blank.hi[k]) / 2);
        const at = (j: number) => R[j * 3] * c[0] + R[j * 3 + 1] * c[1] + R[j * 3 + 2] * c[2];
        a.stock.position.set(at(0), at(2), -at(1));
      } else {
        // Where CAM AI puts it (program.ts planFor): 2 mm over the part's top (half the stock when less), the rest under it;
        // flush with a white face up or down (all the stock on the other side).
        const hz = Math.abs(R[6] * a.ext.x + R[7] * a.ext.y + R[8] * a.ext.z);
        const d = SIDES.find((x) => x.name === whiteSide)?.d;
        const up = d ? R[6] * d[0] + R[7] * d[1] + R[8] * d[2] : 0;
        a.stock.position.y = up > 0.5 ? hz / 2 - v[2] / 2 : up < -0.5 ? v[2] / 2 - hz / 2 : hz / 2 + Math.max(0, Math.min(2, (v[2] - hz) / 2)) - v[2] / 2;
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
  }, [raw, R, blank, whiteSide]);

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

  return <div ref={host} className={`relative overflow-hidden rounded-[var(--radius-md)] bg-[rgba(var(--ov),0.04)] ${className}`} />;
}
