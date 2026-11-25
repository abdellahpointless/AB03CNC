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
/** The vise's painted cast body and jaws (anthracite blue, like the shop's precision vises). */
export const PAINT = { color: 0x43536a, metalness: 0.1, roughness: 0.62 };
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

/** A cylinder along machine Y (the screw), centred at c. */
export function alongY(c: Vec, r: number, len: number, sides: number, finish: { color: number; metalness: number; roughness: number }) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, sides), new THREE.MeshStandardMaterial({ ...finish }));
  m.rotation.x = Math.PI / 2;
  m.position.copy(v3(c));
  m.castShadow = true;
  return m;
}

/**
 * A precision machine vise like the shop's: a painted cast body on two mounting lugs, a ground
 * bed the parallels stand on, the fixed jaw at the back (Y+), the moving jaw at the front (Y-),
 * both with ground jaw plates, and the screw's housing with its hex end at the front; the stop on
 * the left that the part is pushed against. The jaw plates and the stop touch the part's real
 * faces (grip), so nothing cuts into it. About a dozen low-poly meshes per vise.
 */
export function buildVise(hold: { min: [number, number]; max: [number, number] }, floorZ: number, jawTop: number, spans: [number, number][], grip: SetupInfo['grip'], spacers: SetupInfo['spacers']) {
  const g = new THREE.Group();
  const front = grip?.front ?? hold.min[1];
  const back = grip?.back ?? hold.max[1];
  // The jaw plates stand a spacer's thickness off the part on the side it is written.
  const cb = { min: [hold.min[0], front - spacerAt({ spacers }, 'Y-')], max: [hold.max[0], back + spacerAt({ spacers }, 'Y+')] };
  const base = floorZ - 50;
  const bed = floorZ - 10;
  // The body reaches past the jaw fully open (JAW_TRAVEL) to the screw housing.
  const yFront = cb.min[1] - 30 - JAW_TRAVEL - 8;
  const yBack = cb.max[1] + 34;
  // Moving jaws (open and close together in the animations).
  const moving = new THREE.Group();
  const jaws: THREE.Object3D[] = [];
  // Each vise: the first has the stop; the second, to its right, is open on both sides.
  spans.forEach(([x0, x1], i) => {
    const cx = (x0 + x1) / 2;
    const plateFrom = i === 0 ? x0 + STOP_PLATE : x0;
    // Cast body, its two mounting lugs, and the ground bed on top.
    g.add(steel([x0 - 6, yFront, base], [x1 + 6, yBack, bed], PAINT, 4));
    const mid = (yFront + yBack) / 2;
    g.add(steel([x0 - 24, mid - 22, base], [x0 - 2, mid + 22, base + 12], PAINT, 3));
    g.add(steel([x1 + 2, mid - 22, base], [x1 + 24, mid + 22, base + 12], PAINT, 3));
    g.add(steel([x0 - 2, cb.min[1] - 30, bed], [x1 + 2, cb.max[1] + 5, floorZ], GROUND, 1));
    // Fixed jaw: a painted block with its ground plate.
    const fixedJaw = steel([x0, cb.max[1] + 5, bed], [x1, yBack, jawTop], PAINT, 3);
    const plateBack = steel([plateFrom, cb.max[1], floorZ], [x1, cb.max[1] + 5, jawTop], GROUND, 0.6);
    g.add(fixedJaw, plateBack);
    const movingJaw = steel([x0, cb.min[1] - 30, bed], [x1, cb.min[1] - 5, jawTop], PAINT, 3);
    const plateFront = steel([plateFrom, cb.min[1] - 5, floorZ], [x1, cb.min[1], jawTop], GROUND, 0.6);
    moving.add(movingJaw, plateFront);
    jaws.push(fixedJaw, plateBack, movingJaw, plateFront);
    // Screw housing at the front, the screw's end and its hex (the screw turns, it does not travel).
    g.add(steel([cx - 30, yFront - 14, base + 6], [cx + 30, yFront + 2, bed + 6], PAINT, 3));
    g.add(alongY([cx, yFront - 22, bed - 14], 8, 16, 20, GROUND));
    g.add(alongY([cx, yFront - 36, bed - 14], 12, 14, 6, STEEL_DARK));
  });
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
  // The stop: a steel plate in the far-left corner, fixed to the back jaw, across the gap the part
  // sits in, level with the jaw tops. The part is slid left against it.
  g.add(steel([x0, cb.min[1] + 0.5, floorZ], [x0 + STOP_PLATE, cb.max[1] + 30, jawTop], STEEL_DARK, 0.6));
  // The jaws and their plates: red when a tool or holder goes into them.
  const jawMats = jaws.map((p) => {
    const m = (p.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    m.userData.base = m.color.getHex();
    return m;
  });
  return { group: g, moving, jawMats, spacerEdges };
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
