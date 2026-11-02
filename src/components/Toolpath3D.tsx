import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Toolpath, Vec } from '../lib/toolpath';
import { CALE_MS, calesKey, parallelWidth, spacerAt, STOP_PLATE, turnMs, type Face, type ProgramSetups, type SetupInfo } from '../lib/setups';
import { buildInput, FLIP_MS, instant, tipSlope, type ChunkMesh } from '../lib/stockSim';
import { movePath, runShares, toolAlong } from '../lib/playback';
import { addLights } from '../lib/lights';

/*
 * 3D view of one setup: the vise (or modular fixture), the parallels, the part as a solid that
 * the tools cut away, the toolpath of that setup and the tool. Machine X/Y/Z map to three.js
 * X/Z/-Y (Y up), so the operator side of the machine (Y-) faces the camera.
 *
 * The cutting runs in a web worker; only the parts of the surface that change are sent back.
 */

const v3 = (p: Vec) => new THREE.Vector3(p[0], p[2], -p[1]);
const FACE_DIR: Record<Face, Vec> = { 'X+': [1, 0, 0], 'X-': [-1, 0, 0], 'Y+': [0, 1, 0], 'Y-': [0, -1, 0], 'Z+': [0, 0, 1], 'Z-': [0, 0, -1] };
const RAW = new THREE.Color(0x7d8aa3);
const CUT = new THREE.Color(0xd5deea);

/** Weak-spot colours by wall thickness (mm): blue at 0.4 and less, red at 1, orange at 2, yellow at 3, plain above. */
export const WEAK_MM = [0.4, 1, 2, 3] as const;
export const WEAK_COLORS = ['#2f6bff', '#ff3b3b', '#ff9a2e', '#f5d547'] as const;
const HEAT = WEAK_COLORS.map((c) => new THREE.Color(c));
const heatColor = (mm: number, plain: THREE.Color, out: THREE.Color) => {
  if (!(mm < WEAK_MM[3])) return out.copy(plain);
  if (mm <= WEAK_MM[0]) return out.copy(HEAT[0]);
  const k = mm <= WEAK_MM[1] ? 1 : mm <= WEAK_MM[2] ? 2 : 3;
  return out.copy(HEAT[k - 1]).lerp(HEAT[k], (mm - WEAK_MM[k - 1]) / (WEAK_MM[k] - WEAK_MM[k - 1]));
};
/** Machine coordinates -> three.js coordinates. */
const MACHINE = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);

/** Where the part frame sits in the scene for a setup. */
function poseOf(s: SetupInfo): THREE.Matrix4 {
  const R = s.orient;
  const t = s.offset;
  const m = new THREE.Matrix4().set(R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2], 0, 0, 0, 1);
  return MACHINE.clone().multiply(m);
}

export type SolidState = { state: 'off' | 'carving' | 'ready'; share: number };

interface Props {
  path: Toolpath;
  program: ProgramSetups;
  setup: SetupInfo | null;
  /** First and last move index shown. */
  range: [number, number];
  /**
   * The instant shown: moves done + the share of the current move's time done. Read on every
   * frame, so playing moves the tool smoothly without re-rendering React.
   */
  clock: { current: number };
  colorOf: (tool: number | null) => string;
  /** Change it to fit the camera again. */
  fitKey: number;
  onSolid?: (s: SolidState) => void;
  /** Show only the part (no vise, supports, toolpath or tool). */
  isolate?: boolean;
  /** Colour the part by wall thickness: thin, weak spots stand out (see WEAK_MM). */
  heat?: boolean;
}

function label(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = 'bold 44px system-ui, sans-serif';
  const w = Math.ceil(ctx.measureText(text).width) + 36;
  c.width = w;
  c.height = 68;
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(10,15,25,0.85)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, 68, 22);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 18, 36);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.renderOrder = 10;
  s.userData.aspect = w / 68;
  return s;
}

function box(min: Vec, max: Vec, color: number, opacity: number, edges = 0x000000): THREE.Group {
  const g = new THREE.Group();
  const geo = new THREE.BoxGeometry(max[0] - min[0], max[2] - min[2], max[1] - min[1]);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color, transparent: opacity < 1, opacity, metalness: 0.35, roughness: 0.55, depthWrite: opacity >= 1 }),
  );
  g.add(mesh);
  if (edges) g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: edges, transparent: true, opacity: 0.7 })));
  g.position.copy(v3([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]));
  return g;
}

// Brushed steel: moderate metalness, so it picks up the studio surroundings without going dark.
const STEEL = { color: 0xc9d1dc, metalness: 0.3, roughness: 0.42 };
const STEEL_DARK = { color: 0x98a3b3, metalness: 0.35, roughness: 0.45 };
/** A spacer plate (ZWISCHENLAGE): soft aluminium, lighter and duller than the steel. */
const ALU = { color: 0xe4e8ee, metalness: 0.12, roughness: 0.62 };

/** A box of a given steel finish with dark edges (machine coordinates). */
function steel(min: Vec, max: Vec, finish: { color: number; metalness: number; roughness: number }): THREE.Group {
  const g = box(min, max, finish.color, 1, 0x2a313d);
  const m = (g.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
  m.metalness = finish.metalness;
  m.roughness = finish.roughness;
  ((g.children[1] as THREE.LineSegments).material as THREE.LineBasicMaterial).opacity = 0.35;
  return g;
}

/**
 * A machine vise like the shop's: a long steel body, the fixed jaw at the back (Y+), the moving
 * jaw at the front (Y-) with its screw, and the stop on the left that the part is pushed against.
 * The jaw plates and the stop touch the part's real faces (grip), so nothing cuts into it.
 */
function buildVise(hold: { min: [number, number]; max: [number, number] }, floorZ: number, jawTop: number, jawX: [number, number], grip: SetupInfo['grip'], spacer: SetupInfo['spacer']) {
  const g = new THREE.Group();
  const [x0, x1] = jawX;
  const front = grip?.front ?? hold.min[1];
  const back = grip?.back ?? hold.max[1];
  // The jaw plates stand a spacer's thickness off the part on the side it is written.
  const cb = { min: [hold.min[0], front - spacerAt({ spacer }, 'Y-')], max: [hold.max[0], back + spacerAt({ spacer }, 'Y+')] };
  const cx = (x0 + x1) / 2;
  const body = floorZ - 34;
  // Body and the bed the jaws run on.
  g.add(steel([x0 - 6, cb.min[1] - 70, body - 16], [x1 + 18, cb.max[1] + 34, body], STEEL_DARK));
  g.add(steel([x0 - 6, cb.min[1] - 70, body], [x1 + 18, cb.max[1] + 34, floorZ], STEEL));
  // Fixed jaw with its hardened plate.
  g.add(steel([x0, cb.max[1] + 5, floorZ], [x1, cb.max[1] + 30, jawTop], STEEL));
  const plateBack = steel([x0 + STOP_PLATE, cb.max[1], floorZ], [x1, cb.max[1] + 5, jawTop], STEEL_DARK);
  g.add(plateBack);
  // Moving jaw (opens and closes in the animations).
  const moving = new THREE.Group();
  moving.add(steel([x0, cb.min[1] - 30, floorZ], [x1, cb.min[1] - 5, jawTop], STEEL));
  const plateFront = steel([x0 + STOP_PLATE, cb.min[1] - 5, floorZ], [x1, cb.min[1], jawTop], STEEL_DARK);
  moving.add(plateFront);
  // Screw and its hex end at the front.
  const screw = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 40, 24), new THREE.MeshStandardMaterial({ ...STEEL_DARK }));
  screw.rotation.x = Math.PI / 2;
  screw.position.copy(v3([cx, cb.min[1] - 50, floorZ - 14]));
  moving.add(screw);
  const hex = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 14, 6), new THREE.MeshStandardMaterial({ ...STEEL }));
  hex.rotation.x = Math.PI / 2;
  hex.position.copy(v3([cx, cb.min[1] - 74, floorZ - 14]));
  moving.add(hex);
  // The spacer between the part and the jaw or the stop (the front one moves with its jaw).
  if (spacer?.side === 'Y-') moving.add(steel([x0 + STOP_PLATE, cb.min[1], floorZ], [x1, front, jawTop], ALU));
  if (spacer?.side === 'Y+') g.add(steel([x0 + STOP_PLATE, back, floorZ], [x1, cb.max[1], jawTop], ALU));
  if (spacer?.side === 'X-') g.add(steel([x0 + STOP_PLATE, front, floorZ], [x0 + STOP_PLATE + spacer.mm, back, jawTop], ALU));
  g.add(moving);
  // The stop: a steel plate in the far-left corner, fixed to the back jaw, across the gap the part
  // sits in, level with the jaw tops. The part is slid left against it.
  g.add(steel([x0, cb.min[1] + 0.5, floorZ], [x0 + STOP_PLATE, cb.max[1] + 30, jawTop], STEEL_DARK));
  const jawMats = [plateBack, plateFront].map((p) => (p.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial);
  return { group: g, moving, jawMats };
}

/** Steel with the cale's height engraved on it (for its long sides). */
function engraved(text: string, aspect: number): THREE.Texture {
  const W = 512;
  const H = Math.max(32, Math.min(512, Math.round(W / Math.max(aspect, 0.2))));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#a9b3c1');
  grad.addColorStop(1, '#8e98a7');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  const size = Math.min(H * 0.55, 110);
  ctx.font = `700 ${size}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Engraved: a light edge below, the cut darker above.
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillText(text, W / 2 + 1.5, H / 2 + 2);
  ctx.fillStyle = '#3b4352';
  ctx.fillText(text, W / 2, H / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The two cales (parallels) of a setup, along X under the held part near its Y faces, each up to
 * the part's real underside above it, with their height engraved ("40 MM").
 */
function buildCales(setup: SetupInfo | null): THREE.Group | null {
  const s = setup?.stock;
  if (!setup || !s || setup.floorZ === null || !setup.cales?.length) return null;
  const floorZ = setup.floorZ;
  const restZ = setup.restZ ?? s.min[2];
  if (restZ - floorZ < 0.5) return null;
  const cb = setup.clampBox ?? { min: [s.min[0], s.min[1]], max: [s.max[0], s.max[1]] };
  const w = parallelWidth(cb.max[1] - cb.min[1]);
  const cales = setup.cales;
  const length = cb.max[0] + 8 - (cb.min[0] - 2);
  const g = new THREE.Group();
  const text = `${fmtMm(setup.support ?? restZ - floorZ)} MM`;
  cales.forEach(({ y: [y0, y1], top }) => {
    const min: Vec = [cb.min[0] - 2, y0, floorZ];
    const max: Vec = [cb.max[0] + 8, y1, top];
    const len = max[0] - min[0];
    const h = max[2] - min[2];
    const geo = new THREE.BoxGeometry(len, h, y1 - y0);
    const plain = new THREE.MeshStandardMaterial({ color: STEEL_DARK.color, metalness: STEEL_DARK.metalness, roughness: STEEL_DARK.roughness });
    const side = new THREE.MeshStandardMaterial({ map: engraved(text, len / h), metalness: 0.3, roughness: 0.5 });
    // Faces: +X, -X, +Y (top), -Y, +Z (front, machine -Y), -Z (back).
    const mesh = new THREE.Mesh(geo, [plain, plain, plain, plain, side, side]);
    const cale = new THREE.Group();
    cale.add(mesh);
    cale.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x2a313d, transparent: true, opacity: 0.35 })));
    cale.position.copy(v3([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]));
    g.add(cale);
  });
  // Their height as a tag over the right end, shown while they are changed.
  const tag = label(`▭ ${text}`, '#FFD27A');
  const h = Math.min(Math.max(length * 0.07, 5), 12);
  tag.scale.set(h * tag.userData.aspect, h, 1);
  const top = Math.max(...cales.map((c) => c.top));
  tag.position.copy(v3([cb.max[0] + 8, (cales[0].y[0] + cales[cales.length - 1].y[1]) / 2, top + h * 0.9]));
  tag.visible = false;
  g.add(tag);
  g.userData.tag = tag;
  return g;
}

const fmtMm = (v: number) => String(Math.round(v * 10) / 10).replace('.', ',');

/** A curved arrow around a turning axis (three.js frame) showing which way the part turns. */
function turnArrow(axis: THREE.Vector3, angle: number, radius: number, text: string): THREE.Group {
  const g = new THREE.Group();
  const arc = Math.min(Math.abs(angle), Math.PI * 1.7);
  const mat = new THREE.MeshBasicMaterial({ color: 0x5b8cf5, transparent: true, opacity: 0.95, depthTest: false });
  const tube = new THREE.Mesh(new THREE.TorusGeometry(radius, Math.max(0.8, radius * 0.035), 10, 64, arc), mat);
  tube.renderOrder = 11;
  g.add(tube);
  const head = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.12, radius * 0.28, 20), mat);
  head.renderOrder = 11;
  head.position.set(radius * Math.cos(arc), radius * Math.sin(arc), 0);
  head.rotation.z = arc; // cone points along +Y; turned to the arc's direction of travel
  g.add(head);
  const tag = label(text, '#9DB8FF');
  const h = Math.max(5, radius * 0.25);
  tag.scale.set(h * tag.userData.aspect, h, 1);
  tag.position.set(radius * Math.cos(arc / 2) * 1.25, radius * Math.sin(arc / 2) * 1.25, 0);
  g.add(tag);
  // The torus lies in its XY plane, turning around +Z: point +Z along the axis (negative angles
  // turn the other way).
  const dir = axis.clone().normalize().multiplyScalar(angle < 0 ? -1 : 1);
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  return g;
}

function disposeTree(o: THREE.Object3D) {
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

interface Api {
  invalidate: () => void;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  scene: THREE.Scene;
  world: THREE.Group;
  solid: THREE.Group;
  solidReady: boolean;
  /** Ask the worker for the part at an instant; force: again even if shown (e.g. weak spots measured). */
  requestMesh: (step: number, force?: boolean) => void;
  /** Colour the part again (weak spots on or off). */
  repaint: () => void;
  fit: () => void;
  progress: (step: number) => void;
  /** Objects hidden while the part turns. */
  setupObjects: THREE.Object3D[];
  stockFill: THREE.Object3D | null;
  anim: ((now: number) => boolean) | null;
  /** The vise's moving jaw: open = 0 (closed) .. 1 (open). */
  jaw: { obj: THREE.Object3D; travel: number } | null;
  /** Overlay objects (turn arrow) kept outside the world group. */
  overlay: THREE.Group;
  /** The cales (parallels) of the setup shown. */
  cales: THREE.Group | null;
  /** Instant last drawn (see clock). */
  shownPos: number;
  /** Instant of the program the solid should show (see stockSim SUB). */
  meshAt: number;
}

export default function Toolpath3D({ path, program, setup, range, clock, colorOf, fitKey, onSolid, isolate = false, heat = false }: Props) {
  const heatRef = useRef(heat);
  heatRef.current = heat;
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const setupRef = useRef(setup);
  setupRef.current = setup;
  const onSolidRef = useRef(onSolid);
  onSolidRef.current = onSolid;

  // Renderer, camera and controls live as long as the view. It only draws when something changed.
  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setClearColor(0x0a0f19);
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 5000);
    // Lit from every side and from the viewer: no face turns black, whichever way it is turned.
    const disposeLights = addLights(scene, renderer, camera);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.15;
    const world = new THREE.Group();
    scene.add(world);
    const solid = new THREE.Group();
    solid.matrixAutoUpdate = false;
    scene.add(solid);
    const overlay = new THREE.Group();
    scene.add(overlay);

    let dirty = true;
    const invalidate = () => {
      dirty = true;
    };
    controls.addEventListener('change', invalidate);
    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      dirty = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let raf = 0;
    const loop = (now: number) => {
      controls.update();
      const a = api.current;
      // Follow the clock: the tool moves on every frame while playing.
      const pos = clockRef.current.current;
      if (a && pos !== a.shownPos) {
        a.shownPos = pos;
        a.progress(pos);
      }
      if (a?.anim) {
        if (!a.anim(now)) a.anim = null;
        dirty = true;
      }
      if (dirty) {
        renderer.render(scene, camera);
        dirty = false;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    api.current = {
      invalidate,
      camera,
      controls,
      scene,
      world,
      solid,
      solidReady: false,
      requestMesh: () => undefined,
      repaint: () => undefined,
      fit: () => undefined,
      progress: () => undefined,
      setupObjects: [],
      stockFill: null,
      anim: null,
      jaw: null,
      overlay,
      cales: null,
      shownPos: NaN,
      meshAt: 0,
    };
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      disposeTree(world);
      disposeTree(solid);
      disposeLights();
      renderer.dispose();
      renderer.domElement.remove();
      api.current = null;
    };
  }, []);

  // The solid part: cut in a worker, its surface updated chunk by chunk.
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    const input = buildInput(path, program);
    if (!input) {
      onSolidRef.current?.({ state: 'off', share: 0 });
      return;
    }
    const worker = new Worker(new URL('../lib/stockSim.worker.ts', import.meta.url), { type: 'module' });
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.3, roughness: 0.55, side: THREE.DoubleSide });
    const chunks = new Map<number, THREE.Mesh>();
    let busy = false;
    let wanted = -1;
    let shown = -1;
    onSolidRef.current?.({ state: 'carving', share: 0 });

    const ask = (s: number, force = false) => {
      wanted = s;
      if (force) shown = -1;
      if (busy || !a.solidReady || s === shown) return;
      busy = true;
      worker.postMessage({ type: 'mesh', step: s, heat: heatRef.current });
    };
    a.requestMesh = ask;
    // Raw or cut colour, or the weak-spot colour of each point's wall thickness.
    const paint = (geo: THREE.BufferGeometry) => {
      const { cut, thick } = geo.userData as { cut: Uint8Array; thick?: Float32Array };
      const col = new Float32Array(cut.length * 3);
      const c = new THREE.Color();
      for (let i = 0; i < cut.length; i++) {
        const plain = cut[i] ? CUT : RAW;
        if (heatRef.current && thick) heatColor(thick[i], plain, c);
        else c.copy(plain);
        col[i * 3] = c.r;
        col[i * 3 + 1] = c.g;
        col[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    };
    a.repaint = () => {
      for (const mesh of chunks.values()) paint(mesh.geometry);
      a.invalidate();
    };

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'progress') onSolidRef.current?.({ state: 'carving', share: msg.share });
      if (msg.type === 'ready') {
        a.solidReady = true;
        if (setupRef.current) a.solid.matrix.copy(poseOf(setupRef.current));
        a.solid.matrixWorldNeedsUpdate = true;
        if (a.stockFill) a.stockFill.visible = false;
        onSolidRef.current?.({ state: 'ready', share: 1 });
        ask(a.meshAt);
      }
      if (msg.type === 'mesh') {
        for (const c of msg.chunks as ChunkMesh[]) {
          let mesh = chunks.get(c.id);
          if (!c.positions.length) {
            if (mesh) {
              a.solid.remove(mesh);
              mesh.geometry.dispose();
              chunks.delete(c.id);
            }
            continue;
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(c.positions, 3));
          geo.setAttribute('normal', new THREE.BufferAttribute(c.normals, 3));
          geo.userData = { cut: c.cut, thick: c.thick };
          paint(geo);
          if (mesh) {
            mesh.geometry.dispose();
            mesh.geometry = geo;
          } else {
            mesh = new THREE.Mesh(geo, material);
            mesh.matrixAutoUpdate = false;
            chunks.set(c.id, mesh);
            a.solid.add(mesh);
          }
        }
        shown = msg.step;
        busy = false;
        a.solid.matrixWorldNeedsUpdate = true;
        a.invalidate();
        if (wanted !== shown) ask(wanted);
      }
    };
    worker.postMessage({ type: 'init', input });

    return () => {
      worker.terminate();
      a.solidReady = false;
      a.requestMesh = () => undefined;
      a.repaint = () => undefined;
      for (const m of chunks.values()) {
        a.solid.remove(m);
        m.geometry.dispose();
      }
      material.dispose();
      onSolidRef.current?.({ state: 'off', share: 0 });
    };
  }, [path, program]);

  // The setup's scene: fixture, toolpath, tool, markers.
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    const { world, camera, controls } = a;
    disposeTree(world);
    world.clear();
    a.anim = null;
    a.setupObjects = [];

    const [first, last] = range;
    const moves = path.moves.slice(first, last + 1);

    // Toolpath: feeds in the tool's colour, rapids dashed grey, ghost of the whole setup.
    const feedPos: number[] = [];
    const feedCol: number[] = [];
    const rapidPos: number[] = [];
    const feedStart: number[] = [];
    const rapidStart: number[] = [];
    const col = new THREE.Color();
    const push = (arr: number[], p: Vec) => arr.push(p[0], p[2], -p[1]);
    // Each move's path and running length, to place the tool anywhere along it.
    const paths = moves.map(movePath);
    const runs = paths.map(runShares);
    for (const [n, m] of moves.entries()) {
      const pts = paths[n];
      feedStart.push(feedPos.length / 3);
      rapidStart.push(rapidPos.length / 3);
      const target = m.kind === 'rapid' ? rapidPos : feedPos;
      if (m.kind !== 'rapid') col.set(colorOf(m.tool));
      for (let i = 1; i < pts.length; i++) {
        push(target, pts[i - 1]);
        push(target, pts[i]);
        if (m.kind !== 'rapid') feedCol.push(col.r, col.g, col.b, col.r, col.g, col.b);
      }
    }
    const feedAttr = new THREE.Float32BufferAttribute(feedPos, 3);
    const ghostGeo = new THREE.BufferGeometry();
    ghostGeo.setAttribute('position', feedAttr);
    const ghost = new THREE.LineSegments(ghostGeo, new THREE.LineBasicMaterial({ color: 0x33415e, transparent: true, opacity: 0.55 }));
    world.add(ghost);
    const feedGeo = new THREE.BufferGeometry();
    feedGeo.setAttribute('position', feedAttr);
    feedGeo.setAttribute('color', new THREE.Float32BufferAttribute(feedCol, 3));
    const feeds = new THREE.LineSegments(feedGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }));
    world.add(feeds);
    const rapidGeo = new THREE.BufferGeometry();
    rapidGeo.setAttribute('position', new THREE.Float32BufferAttribute(rapidPos, 3));
    const rapids = new THREE.LineSegments(rapidGeo, new THREE.LineDashedMaterial({ color: 0x7f8ba0, dashSize: 2, gapSize: 2, transparent: true, opacity: 0.5 }));
    rapids.computeLineDistances();
    world.add(rapids);
    // The piece of the current move between its last corner and the tool.
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
    const trailMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
    const trail = new THREE.LineSegments(trailGeo, trailMat);
    trail.frustumCulled = false;
    trail.visible = false;
    world.add(trail);
    a.setupObjects.push(ghost, feeds, rapids, trail);

    // Fixture and the outline of the part.
    const stockGroup = new THREE.Group();
    const fixture = new THREE.Group();
    world.add(fixture);
    const jaws: THREE.MeshStandardMaterial[] = [];
    const s = setup?.stock;
    let floorZ = Math.min(path.min[2], 0) - 10;
    a.stockFill = null;
    if (setup && s) {
      floorZ = setup.floorZ ?? s.min[2];
      stockGroup.position.copy(v3([(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2, (s.min[2] + s.max[2]) / 2]));
      const outline = box(s.min, s.max, 0xb9c6da, 0.3, 0xdfe8f5);
      outline.position.sub(stockGroup.position);
      // The see-through block is shown until the solid part is ready.
      a.stockFill = outline.children[0];
      a.stockFill.visible = !a.solidReady;
      (outline.children[1] as THREE.LineSegments).material = new THREE.LineBasicMaterial({ color: 0xdfe8f5, transparent: true, opacity: 0.18 });
      stockGroup.add(outline);
      world.add(stockGroup);

      a.cales = buildCales(setup);
      if (a.cales) fixture.add(a.cales);
      a.jaw = null;
      if (setup.jawTopZ !== null) {
        const cb = setup.clampBox ?? { min: [s.min[0], s.min[1]], max: [s.max[0], s.max[1]] };
        const cx = (cb.min[0] + cb.max[0]) / 2;
        const vise = buildVise(cb, floorZ, setup.jawTopZ, setup.jawX, setup.grip, setup.spacer);
        fixture.add(vise.group);
        jaws.push(...vise.jawMats);
        a.jaw = { obj: vise.moving, travel: 14 };
        // The top of the jaws as a thin red line, for the jaw check.
        const line = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(setup.jawX[1] - setup.jawX[0], 0.01, cb.max[1] - cb.min[1] + 60)),
          new THREE.LineBasicMaterial({ color: 0xf26d6d, transparent: true, opacity: 0.5 }),
        );
        line.position.copy(v3([(setup.jawX[0] + setup.jawX[1]) / 2, (cb.min[1] + cb.max[1]) / 2, setup.jawTopZ]));
        fixture.add(line);
      } else {
        // A fixture: a steel block under the part, with the stop on the left.
        fixture.add(steel([s.min[0] - 8, s.min[1] - 8, floorZ - 30], [s.max[0] + 8, s.max[1] + 8, floorZ], STEEL));
        fixture.add(steel([s.min[0] - 18, s.min[1] - 8, floorZ - 30], [s.min[0] - 8, s.max[1] + 8, floorZ + Math.min(20, (setup.restZ ?? s.min[2]) - floorZ + 12)], STEEL_DARK));
      }

      // RAFI / TASTER: an arrow from the part toward the faces the program names, and a label.
      if (setup.marker && setup.marker.faces.length) {
        const marker = new THREE.Group();
        const d: Vec = [0, 0, 0];
        for (const f of setup.marker.faces) FACE_DIR[f].forEach((x, i) => (d[i] += x));
        const half: Vec = [(s.max[0] - s.min[0]) / 2, (s.max[1] - s.min[1]) / 2, (s.max[2] - s.min[2]) / 2];
        const edge = new THREE.Vector3(d[0] * half[0], d[2] * half[2], -d[1] * half[1]);
        const dir = new THREE.Vector3(d[0], d[2], -d[1]).normalize();
        const len = Math.max(12, Math.max(...half) * 0.6);
        marker.add(new THREE.ArrowHelper(dir, edge, len, 0xffa94d, len * 0.3, len * 0.18));
        const tag = label(`${setup.marker.name} ${setup.marker.faces.join(' ')}`, '#FFB869');
        const h = Math.max(6, Math.max(...half) * 0.22);
        tag.scale.set(h * tag.userData.aspect, h, 1);
        tag.position.copy(edge.clone().add(dir.clone().multiplyScalar(len + h)));
        marker.add(tag);
        stockGroup.add(marker);
        a.setupObjects.push(marker);
      }
    }

    // Floor grid under the fixture.
    const span = Math.max(path.max[0] - path.min[0], path.max[1] - path.min[1], 60) * 2.2;
    const grid = new THREE.GridHelper(span, 22, 0x2c3953, 0x1a2234);
    const center = s ? [(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2] : [(path.min[0] + path.max[0]) / 2, (path.min[1] + path.max[1]) / 2];
    grid.position.copy(v3([center[0], center[1], floorZ - (setup?.jawTopZ !== null && s ? 50 : s ? 30 : 0)]));
    world.add(grid);

    // Jaw hits: red spheres.
    const hits = new THREE.Group();
    for (const c of setup?.collisions ?? []) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1.8, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff4d4d }));
      m.position.copy(v3(c.point));
      m.userData.move = c.move;
      hits.add(m);
    }
    world.add(hits);

    // Tool: cutter plus holder, bottom at the tool tip.
    const tool = new THREE.Group();
    const cutterMat = new THREE.MeshStandardMaterial({ color: 0xe8edf5, metalness: 0.8, roughness: 0.25, transparent: true, opacity: 0.9 });
    const holderMat = new THREE.MeshStandardMaterial({ color: 0x55627a, metalness: 0.6, roughness: 0.4 });
    const cutter = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 32), cutterMat);
    const holder = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 32), holderMat);
    // Pointed tools (chamfer, spot drill, drill) get their tip: a cone under the cutter.
    const tipMesh = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 32), cutterMat);
    tipMesh.rotation.x = Math.PI;
    tool.add(cutter, holder, tipMesh);
    world.add(tool);
    a.setupObjects.push(tool);
    const sizeOf = new Map(path.tools.map((t) => [t.tool, t]));
    const hitMoves = new Set((setup?.collisions ?? []).map((c) => c.move));

    let toolOn: number | null | undefined;
    a.progress = (pos: number) => {
      // The move in progress (or the last one, once the setup is done) and the share of its time.
      const started = moves.length > 0 && pos > first;
      const k = started ? Math.min(Math.floor(pos), last) - first : -1;
      const cur = k >= 0 ? moves[k] : null;
      tool.userData.has = !!cur;
      tool.visible = !!cur && !a.anim;
      if (!cur) {
        feedGeo.setDrawRange(0, 0);
        rapidGeo.setDrawRange(0, 0);
        trail.visible = false;
        a.meshAt = instant(Math.min(pos, first));
      } else {
        const at = toolAlong(cur, paths[k], runs[k], pos - (first + k));
        // Lines: every move before this one, the corners of this one already passed, and the
        // piece from the last corner to the tool.
        const segs = Math.max(0, paths[k].length - 1);
        const done = Math.min(at.done, segs);
        const rapid = cur.kind === 'rapid';
        feedGeo.setDrawRange(0, feedStart[k] + (rapid ? 0 : done * 2));
        rapidGeo.setDrawRange(0, rapidStart[k] + (rapid ? done * 2 : 0));
        trail.visible = done < segs;
        if (trail.visible) {
          const from = paths[k][done];
          const attr = trailGeo.getAttribute('position') as THREE.BufferAttribute;
          attr.setXYZ(0, from[0], from[2], -from[1]);
          attr.setXYZ(1, at.p[0], at.p[2], -at.p[1]);
          attr.needsUpdate = true;
          trailMat.color.set(rapid ? 0x7f8ba0 : colorOf(cur.tool));
          trailMat.opacity = rapid ? 0.5 : 0.85;
        }
        // The tool's shape only changes with the tool.
        if (toolOn !== cur.tool) {
          toolOn = cur.tool;
          const info = sizeOf.get(cur.tool ?? -1);
          const r = Math.max(0.5, (info?.diameter ?? 6) / 2);
          // Cutting length as written; a face mill (tourteau) is a wide flat disk.
          const big = r >= 12;
          const len = big ? Math.min(Math.max(info?.length ?? 30, 12), 40) : Math.min(Math.max(info?.length ?? r * 8, r * 3, 12), 80);
          const slope = tipSlope(info?.label ?? '');
          const tipH = slope ? Math.min(r / slope, len * 0.8) : 0;
          tipMesh.visible = tipH > 0;
          if (tipH > 0) {
            tipMesh.scale.set(r, tipH, r);
            tipMesh.position.set(0, tipH / 2, 0);
          }
          cutter.scale.set(r, len - tipH, r);
          cutter.position.set(0, tipH + (len - tipH) / 2, 0);
          const hr = big ? Math.max(r * 0.38, 14) : Math.max(r * 1.25, 9);
          const hh = big ? 40 : 28;
          holder.scale.set(hr, hh, hr);
          holder.position.set(0, len + hh / 2, 0);
        }
        tool.position.copy(v3(at.p));
        const hit = hitMoves.has(first + k);
        cutterMat.color.set(hit ? 0xff5c5c : 0xe8edf5);
        jaws.forEach((j) => j.color.set(hit ? 0xa84a4a : STEEL_DARK.color));
        // The solid as it is with the tool right here.
        a.meshAt = instant(first + k + at.cut);
      }
      const reached = cur ? first + k : first - 1;
      hits.children.forEach((h) => ((h as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(h.userData.move <= reached ? 0xff4d4d : 0x7a3a3a));
      a.requestMesh(a.meshAt);
      a.invalidate();
    };
    a.shownPos = clockRef.current.current;
    a.progress(a.shownPos);

    a.fit = () => {
      const bb = new THREE.Box3();
      if (s) bb.expandByObject(stockGroup).expandByObject(fixture);
      if (feedPos.length) {
        feedGeo.computeBoundingBox();
        const pb = feedGeo.boundingBox!.clone();
        if (s) pb.intersect(new THREE.Box3().copy(bb).expandByScalar(60));
        bb.union(pb);
      }
      if (bb.isEmpty()) bb.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(50, 50, 50));
      const c = bb.getCenter(new THREE.Vector3());
      const size = bb.getSize(new THREE.Vector3()).length();
      controls.target.copy(c);
      camera.position.copy(c).add(new THREE.Vector3(0.7, 1.05, 1).normalize().multiplyScalar(size * 1.25));
      camera.near = size / 200;
      camera.far = size * 40;
      camera.updateProjectionMatrix();
      controls.update();
      a.invalidate();
    };
    a.fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, setup, range[0], range[1], colorOf]);

  useEffect(() => {
    if (fitKey) api.current?.fit();
  }, [fitKey]);

  useEffect(() => {
    const a = api.current;
    if (!a) return;
    a.repaint();
    // The first time: the worker measures the walls and sends the part again with them.
    if (heat) a.requestMesh(a.meshAt, true);
  }, [heat]);

  // Part only: hide the vise, supports, toolpath and tool.
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    a.world.visible = !isolate;
    if (isolate && a.solidReady) {
      // Frame the part alone.
      const bb = new THREE.Box3().setFromObject(a.solid);
      if (!bb.isEmpty()) {
        const c = bb.getCenter(new THREE.Vector3());
        const size = bb.getSize(new THREE.Vector3()).length();
        a.controls.target.copy(c);
        a.camera.position.copy(c).add(new THREE.Vector3(0.7, 1.05, 1).normalize().multiplyScalar(size * 1.35));
        a.controls.update();
      }
    } else if (!isolate) a.fit();
    a.invalidate();
  }, [isolate]);

  // Turning the part between setups: the jaw opens, the part lifts, turns (an arrow shows the
  // way) and sets down, then the jaw closes. Opening a setup directly just clamps it.
  const lastSetup = useRef<SetupInfo | null>(null);
  useEffect(() => {
    const a = api.current;
    const prev = lastSetup.current;
    lastSetup.current = setup;
    if (!a || !setup) return;
    const end = poseOf(setup);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    disposeTree(a.overlay);
    a.overlay.clear();
    const jaw = a.jaw;
    const setJaw = (open: number) => {
      if (jaw) jaw.obj.position.set(0, 0, open * jaw.travel); // three Z = machine -Y (towards the front)
    };
    const ease = (x: number) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
    if (!prev || prev.index >= setup.index || !a.solidReady || reduce) {
      a.solid.matrix.copy(end);
      a.solid.matrixWorldNeedsUpdate = true;
      if (reduce || !jaw) {
        setJaw(0);
        a.invalidate();
        return;
      }
      // Clamp: the jaw closes on the part.
      const t0 = performance.now();
      setJaw(1);
      a.anim = (now) => {
        const t = Math.min(1, (now - t0) / 450);
        setJaw(1 - ease(t));
        return t < 1;
      };
      a.invalidate();
      return;
    }
    const p0 = new THREE.Vector3();
    const q0 = new THREE.Quaternion();
    const p1 = new THREE.Vector3();
    const q1 = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    poseOf(prev).decompose(p0, q0, sc);
    end.decompose(p1, q1, sc);
    const height = setup.stock ? Math.max(setup.stock.max[2] - setup.stock.min[2], 20) : 30;

    // The arrow: the turn from the old pose to the new one, around the part's middle.
    let arrow: THREE.Group | null = null;
    const turn = q1.clone().multiply(q0.clone().invert());
    const angle = 2 * Math.acos(Math.min(1, Math.abs(turn.w))) * (turn.w < 0 ? -1 : 1);
    const axis = new THREE.Vector3(turn.x, turn.y, turn.z);
    if (axis.lengthSq() > 1e-9 && Math.abs(angle) > 0.1 && setup.stock) {
      axis.normalize();
      const st = setup.stock;
      const size = Math.max(st.max[0] - st.min[0], st.max[1] - st.min[1], st.max[2] - st.min[2]);
      // Name the machine axis it turns around (three X/Y/Z = machine X/Z/-Y).
      const m = [axis.x, -axis.z, axis.y];
      const big = m.map(Math.abs).indexOf(Math.max(...m.map(Math.abs)));
      const deg = Math.round(Math.abs((angle * 180) / Math.PI));
      arrow = turnArrow(axis, angle, size * 0.5, `${deg}° ${'XYZ'[big]}`);
      // Around the part's middle, a little above the jaws.
      arrow.position.copy(v3([(st.min[0] + st.max[0]) / 2, (st.min[1] + st.max[1]) / 2, st.max[2] + height * 0.35]));
      a.overlay.add(arrow);
    }

    // Changing cales, slowly enough to see which ones: with the part up, the old pair slides out to
    // the right and the new pair slides in with its height shown; then the part sets down on them.
    const newCales = a.cales;
    const oldCales = buildCales(prev);
    const changing = calesKey(prev) !== calesKey(setup) && (!!newCales || !!oldCales);
    const slide = setup.stock ? setup.stock.max[0] - setup.stock.min[0] + 120 : 150;
    if (oldCales && changing) a.overlay.add(oldCales);
    else if (oldCales) disposeTree(oldCales);
    const tagOf = (c: THREE.Group | null) => (c?.userData.tag as THREE.Sprite | undefined) ?? null;
    // Timeline (ms): unclamp, lift and turn, [change the cales], set down, clamp.
    const UNCLAMP = FLIP_MS * 0.15;
    const TURN = FLIP_MS * 0.55;
    const DOWN = FLIP_MS * 0.15;
    const CLAMP = FLIP_MS * 0.15;
    const SWAP = changing ? CALE_MS : 0;
    const tTurn = UNCLAMP;
    const tSwap = tTurn + TURN;
    const tDown = tSwap + SWAP;
    const tClamp = tDown + DOWN;
    const total = tClamp + CLAMP;
    const part = (ms: number, from: number, len: number) => (len > 0 ? Math.min(1, Math.max(0, (ms - from) / len)) : ms >= from ? 1 : 0);
    const placeCales = (ms: number) => {
      if (!changing) return;
      const sw = part(ms, tSwap, SWAP);
      const out = Math.min(1, sw / 0.28);
      const inn = Math.min(1, Math.max(0, (sw - 0.33) / 0.37));
      if (oldCales) {
        oldCales.position.x = ease(out) * slide;
        oldCales.visible = out < 1;
        tagOf(oldCales)!.visible = sw > 0 && out < 1;
      }
      if (newCales) {
        newCales.position.x = (1 - ease(inn)) * slide;
        newCales.visible = inn > 0;
        tagOf(newCales)!.visible = inn > 0 && ms < tClamp;
      }
    };
    placeCales(0);
    const start = performance.now();
    const hide = a.setupObjects;
    hide.forEach((o) => (o.visible = false));
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    a.solid.matrix.compose(p0, q0, one);
    setJaw(0);
    a.anim = (now) => {
      const ms = now - start;
      setJaw(ms < tTurn ? ease(ms / UNCLAMP) : ms >= tClamp ? 1 - ease(part(ms, tClamp, CLAMP)) : 1);
      // Up in the first part of the turn, turning, waiting up there while the cales change, down.
      const up = part(ms, tTurn, TURN);
      const lift = ease(Math.min(1, up / 0.4)) * (1 - ease(part(ms, tDown, DOWN)));
      const e = ease(Math.min(1, Math.max(0, (up - 0.2) / 0.8)));
      q.slerpQuaternions(q0, q1, e);
      p.lerpVectors(p0, p1, e);
      p.y += lift * height * 1.3;
      a.solid.matrix.compose(p, q, one);
      a.solid.matrixWorldNeedsUpdate = true;
      placeCales(ms);
      // The turn arrow while it turns (and until it sets down when nothing else happens).
      if (arrow) arrow.visible = changing ? ms < tSwap : ms < tClamp;
      if (ms >= total) {
        a.solid.matrix.copy(end);
        setJaw(0);
        if (newCales) {
          newCales.position.x = 0;
          newCales.visible = true;
          tagOf(newCales)!.visible = false;
        }
        disposeTree(a.overlay);
        a.overlay.clear();
        hide.forEach((o) => (o.visible = o.userData.has !== false));
        return false;
      }
      return true;
    };
    a.invalidate();
  }, [setup]);

  return <div ref={host} className="absolute inset-0 cursor-grab active:cursor-grabbing touch-none" />;
}
