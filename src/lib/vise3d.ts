/*
 * The vise, its jaws and the parallels in three.js, shared by the 3D views. Machine X/Y/Z map to three.js
 * X/Z/-Y (Y up), so the operator side of the machine (Y-) faces the camera.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Vec } from './toolpath';
import { spacerAt, STOP_PLATE, type SetupInfo } from './setups';

/** Machine coordinates -> three.js. */
export const v3 = (p: Vec) => new THREE.Vector3(p[0], p[2], -p[1]);

/** A box in machine coordinates with dark edges, its edges rounded by `round` mm. */
export function box(min: Vec, max: Vec, color: number, opacity: number, edges = 0x000000, round = 0): THREE.Group {
  const g = new THREE.Group();
  const [w, h, d] = [max[0] - min[0], max[2] - min[2], max[1] - min[1]];
  // Rounded: 2 segments per edge keeps it a few hundred triangles.
  const geo = round > 0 ? new RoundedBoxGeometry(w, h, d, 2, Math.min(round, w / 2, h / 2, d / 2) * 0.999) : new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color, transparent: opacity < 1, opacity, metalness: 0.35, roughness: 0.55, depthWrite: opacity >= 1 }),
  );
  mesh.castShadow = mesh.receiveShadow = opacity >= 1;
  g.add(mesh);
  if (edges) g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, round > 0 ? 50 : 1),new THREE.LineBasicMaterial({ color: edges, transparent: true, opacity: 0.7 })));
  g.position.copy(v3([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]));
  return g;
}

// Brushed steel: moderate metalness, so it picks up the studio surroundings without going dark.
export const STEEL = { color: 0xc9d1dc, metalness: 0.3, roughness: 0.42 };
export const STEEL_DARK = { color: 0x98a3b3, metalness: 0.35, roughness: 0.45 };
/** Ground steel (the bed, the jaw plates, the screw end): brighter and smoother. */
export const GROUND = { color: 0xdde3ea, metalness: 0.45, roughness: 0.3 };
/** A spacer plate (ZWISCHENLAGE): soft aluminium, lighter and duller than the steel. */
export const ALU = { color: 0xe4e8ee, metalness: 0.12, roughness: 0.62 };

/** A box of a given steel finish with dark edges (machine coordinates), its edges rounded by `round` mm. */
export function steel(min: Vec, max: Vec, finish: { color: number; metalness: number; roughness: number }, round = 0): THREE.Group {
  const g = box(min, max, finish.color, 1, 0x2a313d, round);
  const m = (g.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
  m.metalness = finish.metalness;
  m.roughness = finish.roughness;
  ((g.children[1] as THREE.LineSegments).material as THREE.LineBasicMaterial).opacity = 0.35;
  return g;
}

/** How deep the shop's vise reaches under its bed (its body's underside; viseModel.ts, checked by a test). */
export const VISE_DEPTH = 73;

type VisePart = 'fixedBody' | 'fixedJaw' | 'fixedPlate' | 'movingBody' | 'movingJaw' | 'movingPlate';
interface ViseMeshes {
  geos: Record<VisePart, THREE.BufferGeometry>;
  /** The moving plate's face as modelled (fully open), from the fixed one (mm); the plates' height over the bed. */
  opening: number;
  jawHeight: number;
}
let decoded: ViseMeshes | null = null;
let loading: Promise<ViseMeshes> | null = null;

/** The shop's vise (viseModel.ts, a file of its own, loaded once): its meshes in the vise's frame, three.js axes. */
export function loadVise(): Promise<ViseMeshes> {
  loading ??= import('./viseModel').then(({ VISE_DATA, VISE_PARTS, VISE_FRAME }) => {
    const bin = Uint8Array.from(atob(VISE_DATA), (c) => c.charCodeAt(0));
    let at = 0;
    const take = (bytes: number) => {
      const b = bin.buffer.slice(at, at + bytes);
      at += Math.ceil(bytes / 4) * 4;
      return b;
    };
    const q = VISE_FRAME.quantum;
    const geos = {} as Record<VisePart, THREE.BufferGeometry>;
    for (const part of VISE_PARTS) {
      const n = part.vertices;
      const P = new Int16Array(take(n * 6));
      const N = new Int8Array(take(n * 3));
      const I = n > 65535 ? new Uint32Array(take(part.triangles * 12)) : new Uint16Array(take(part.triangles * 6));
      // Machine X/Y/Z -> three.js X/Z/-Y, as v3.
      const pos = new Float32Array(n * 3);
      const nrm = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) {
        pos[3 * k] = P[3 * k] * q;
        pos[3 * k + 1] = P[3 * k + 2] * q;
        pos[3 * k + 2] = -P[3 * k + 1] * q;
        nrm[3 * k] = N[3 * k] / 127;
        nrm[3 * k + 1] = N[3 * k + 2] / 127;
        nrm[3 * k + 2] = -N[3 * k + 1] / 127;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      geo.setIndex(new THREE.BufferAttribute(I, 1));
      geos[part.name] = geo;
    }
    decoded = { geos, opening: VISE_FRAME.opening, jawHeight: VISE_FRAME.jawHeight };
    return decoded;
  });
  return loading;
}

/** The model's own finishes: a dark grey cast body, ground jaws, the jaw plates' lighter steel. */
const CAST = { color: 0x5b6068, metalness: 0.3, roughness: 0.55 };
const FINISH: Record<VisePart, { color: number; metalness: number; roughness: number }> = {
  fixedBody: CAST,
  movingBody: CAST,
  fixedJaw: GROUND,
  movingJaw: GROUND,
  fixedPlate: STEEL,
  movingPlate: STEEL,
};

/**
 * The shop's vise (a Haas HMV-6F, from its maker's model; its jaws 150 mm long, their plates 45 mm over the bed): the
 * fixed jaw at the back (Y+), the moving jaw at the front (Y-) with the screw's hex end, each jaw plate on the part's
 * real faces (grip), the jaws from the stop's face (jawsFrom); the stop before them, that the part is pushed against. Its meshes come in once loaded
 * (loadVise): `ready` resolves when they are in.
 */
export function buildVise(hold: { min: [number, number]; max: [number, number] }, floorZ: number, jawTop: number, spans: [number, number][], grip: SetupInfo['grip'], spacers: SetupInfo['spacers']) {
  const g = new THREE.Group();
  const front = grip?.front ?? hold.min[1];
  const back = grip?.back ?? hold.max[1];
  // The jaw plates stand a spacer's thickness off the part on the side it is written.
  const cb = { min: [hold.min[0], front - spacerAt({ spacers }, 'Y-')], max: [hold.max[0], back + spacerAt({ spacers }, 'Y+')] };
  // Moving jaws (open and close together in the animations).
  const moving = new THREE.Group();
  // The jaws and their plates: red when a tool or holder goes into them (one set of materials per vise drawn).
  const mats = Object.fromEntries(
    (Object.keys(FINISH) as VisePart[]).map((k) => {
      const m = new THREE.MeshStandardMaterial({ ...FINISH[k] });
      m.userData.base = m.color.getHex();
      return [k, m];
    }),
  ) as Record<VisePart, THREE.MeshStandardMaterial>;
  const jawMats = [mats.fixedJaw, mats.fixedPlate, mats.movingJaw, mats.movingPlate];
  // Each vise at its span, its jaws' left end at the stop's face on the first (the stop before it), at the span's
  // start on the second: the fixed jaw's face on the part's back, the moving one on its front.
  const place = (v: ViseMeshes) => {
    for (const [i, [x0]] of spans.entries()) {
      for (const k of Object.keys(FINISH) as VisePart[]) {
        const mesh = new THREE.Mesh(v.geos[k], mats[k]);
        mesh.castShadow = mesh.receiveShadow = true;
        const movingPart = k.startsWith('moving');
        mesh.position.copy(v3([x0 + (i === 0 ? STOP_PLATE : 0), cb.max[1] - (movingPart ? cb.max[1] - cb.min[1] - v.opening : 0), floorZ]));
        // The plates' tops at the jaw height used for the checks (45 mm, as modelled, unless set otherwise).
        if (k.endsWith('Plate')) mesh.scale.y = (jawTop - floorZ) / v.jawHeight;
        (movingPart ? moving : g).add(mesh);
      }
    }
  };
  const ready = decoded ? (place(decoded), Promise.resolve()) : loadVise().then(place);
  const [x0] = spans[0];
  const x1 = spans[spans.length - 1][1];
  // The spacer between the part and the jaw or the stop (the front one moves with its jaw).
  const plates = spacers.map((sp) => {
    const plate =
      sp.side === 'Y-' ? steel([x0 + STOP_PLATE, cb.min[1], floorZ], [x1, front, jawTop], ALU)
      : sp.side === 'Y+' ? steel([x0 + STOP_PLATE, back, floorZ], [x1, cb.max[1], jawTop], ALU)
      : steel([x0 + STOP_PLATE, front, floorZ], [x0 + STOP_PLATE + sp.mm, back, jawTop], ALU);
    (sp.side === 'Y-' ? moving : g).add(plate);
    return plate;
  });
  // Their edges turn green once a tool has cut into one (fine: that is what they are there for).
  const spacerEdges = plates.length ? { lines: plates.map((p) => (p.children[1] as THREE.LineSegments).material as THREE.LineBasicMaterial), face: plates.map((p) => (p.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial) } : null;
  g.add(moving);
  // The stop: a steel plate in the far-left corner, against the back jaw, across the gap the part
  // sits in, level with the jaw tops. The part is slid left against it.
  g.add(steel([x0, cb.min[1] + 0.5, floorZ], [x0 + STOP_PLATE, cb.max[1], jawTop], STEEL_DARK, 0.6));
  return { group: g, moving, jawMats, spacerEdges, ready };
}

/** Steel with the cale's height engraved on it (for its long sides). */
export function engraved(text: string, aspect: number): THREE.Texture {
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

/** How far the moving jaw opens to let the part out (mm). */
export const JAW_TRAVEL = 35;

/**
 * Parallels: a bar per run start (x) and per pair side (y, up to its top), PARALLEL_LENGTH long from the floor,
 * their height engraved on their long sides ("40 MM").
 */
export function buildParallels(runs: number[], length: number, bars: { y: [number, number]; top: number }[], floorZ: number, text: string): THREE.Group {
  const g = new THREE.Group();
  runs.flatMap((x) => bars.map((c) => ({ ...c, x }))).forEach(({ y: [y0, y1], top, x }) => {
    const min: Vec = [x, y0, floorZ];
    const max: Vec = [x + length, y1, top];
    const len = max[0] - min[0];
    const h = max[2] - min[2];
    const geo = new THREE.BoxGeometry(len, h, y1 - y0);
    const plain = new THREE.MeshStandardMaterial({ color: STEEL_DARK.color, metalness: STEEL_DARK.metalness, roughness: STEEL_DARK.roughness });
    const side = new THREE.MeshStandardMaterial({ map: engraved(text, len / h), metalness: 0.3, roughness: 0.5 });
    // Faces: +X, -X, +Y (top), -Y, +Z (front, machine -Y), -Z (back).
    const mesh = new THREE.Mesh(geo, [plain, plain, plain, plain, side, side]);
    mesh.castShadow = mesh.receiveShadow = true;
    const cale = new THREE.Group();
    cale.add(mesh);
    cale.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x2a313d, transparent: true, opacity: 0.35 })));
    cale.position.copy(v3([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]));
    g.add(cale);
  });
  return g;
}
