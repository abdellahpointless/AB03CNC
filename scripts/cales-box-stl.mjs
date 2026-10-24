// The cales box from the app, to 3D-print in two parts: the base (the same for every machine) and a
// lift-off lid with the machine name engraved on top. Same layout as the app: one pair per slot side
// by side, 43 mm on the left down to 8 mm, taller pairs sitting deeper, heights printed behind the slots.
// Thin walls and an open floor in the middle keep the filament low. Each part fits a 180 × 180 mm bed.
//
// Taking a pair out: press its back end down; it tips over a small ridge and the front end lifts up.
//
// Usage: node scripts/cales-box-stl.mjs <outDir> [MACHINE ...]
import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [outDir, ...names] = process.argv.slice(2);
if (!outDir) throw new Error('usage: node scripts/cales-box-stl.mjs <outDir> [MACHINE ...]');
const MACHINES = names.length ? names : ['HAAS-1', 'HAAS-2', 'HAAS-3', 'HAAS-4', 'HAAS-5', 'FANUC-1', 'FANUC-2', 'DMG-1'];
const HEIGHTS = [43, 42, 41, 40, 38, 35, 33, 30, 28, 25, 22, 20, 15, 8]; // as in src/lib/cales.ts
const BED = 180;

const L = 125; // cale length
const T = 5; // cale thickness
const CLEAR = 0.8; // play per slot and along the length (FDM prints a little tight)
const WALL = 0.8; // 2 lines with a 0.4 mm nozzle
const FLOOR = 0.8;
const S = 2 * T + CLEAR; // slot: one pair side by side
const SL = L + 1; // slot length
const FRONT = 1.5; // gap in front of the slots (room for the lid's front tab)
const LABELS = 12; // strip behind the slots with the heights
const COMB = 15; // dividers only at both ends of the slots: less plastic
const RAISE = 4; // every pair sits at least this high, so its back end can be pressed down
const PIVOT = 15; // ridge this far from the back end: press behind it, the front lifts
const slotDepth = (h) => 6 + (h - 8) * 0.45; // how deep a pair sits, as in the app
const DEEPEST = slotDepth(HEIGHTS[0]);
const bottom = (h) => FLOOR + RAISE + DEEPEST - slotDepth(h); // where a pair rests
const TOP = FLOOR + RAISE + DEEPEST; // height of the dividers and of the base walls

const IW = HEIGHTS.length * S + (HEIGHTS.length - 1) * WALL;
const ID = FRONT + SL + LABELS;
const OW = IW + 2 * WALL;
const OD = ID + 2 * WALL;
const slotX = (i) => WALL + i * (S + WALL); // left edge of slot i
const Y0 = WALL + FRONT; // front of the slots
const Y1 = Y0 + SL; // back of the slots

const LID_ROOM = Math.max(...HEIGHTS.map((h) => bottom(h) + h)) + 1 - TOP; // above the base walls
const LID_TOP = 1.2;
const ENGRAVE = 0.6;
const LID_TAB = 3; // tabs going down inside the base, front and back, so the lid stays put

const font = new FontLoader().parse(
  JSON.parse(readFileSync(createRequire(import.meta.url).resolve('three/examples/fonts/helvetiker_bold.typeface.json'), 'utf8')),
);
const mat = new THREE.MeshBasicMaterial();
let volume = 0;

/** A solid block x0..x1, y0..y1, z0..z1 (blocks may overlap: the slicer merges them). */
function block(g, x0, x1, y0, y1, z0, z1) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  g.add(m);
  volume += (x1 - x0) * (y1 - y0) * (z1 - z0);
}

/** Outer walls of a w × d rectangle, z0..z1. */
function walls(g, w, d, t, z0, z1, x = 0, y = 0) {
  block(g, x, x + w, y, y + t, z0, z1);
  block(g, x, x + w, y + d - t, y + d, z0, z1);
  block(g, x, x + t, y, y + d, z0, z1);
  block(g, x + w - t, x + w, y, y + d, z0, z1);
}

function base() {
  const g = new THREE.Group();
  // Floor: solid at both ends, open in the middle where the cales just span across.
  block(g, 0, OW, 0, Y0 + COMB, 0, FLOOR);
  block(g, 0, OW, Y1 - COMB - PIVOT, OD, 0, FLOOR);
  walls(g, OW, OD, WALL, 0, TOP);
  HEIGHTS.forEach((h, i) => {
    const x = slotX(i);
    if (i > 0)
      for (const [y0, y1] of [[Y0, Y0 + COMB], [Y1 - COMB, Y1]]) block(g, x - WALL, x, y0, y1, 0, TOP); // dividers
    block(g, x, x + S, Y0, Y0 + 5, 0, bottom(h)); // front rest
    block(g, x, x + S, Y1 - PIVOT - 1.5, Y1 - PIVOT + 1.5, 0, bottom(h)); // ridge it tips over
    const num = new TextGeometry(String(h), { font, size: 5.5, depth: 0.8, curveSegments: 4 });
    num.computeBoundingBox();
    const b = num.boundingBox;
    num.translate(x + S / 2 - (b.min.x + b.max.x) / 2, Y1 + LABELS / 2 - (b.min.y + b.max.y) / 2, FLOOR - 0.2);
    g.add(new THREE.Mesh(num, mat));
  });
  return g;
}

/** Glyph outlines of `text`, centred on (cx, cy). */
function glyphs(text, size, cx, cy) {
  const shapes = font.generateShapes(text, size);
  const box = new THREE.Box2();
  shapes.forEach((s) => s.getPoints().forEach((p) => box.expandByPoint(p)));
  const dx = cx - (box.min.x + box.max.x) / 2;
  const dy = cy - (box.min.y + box.max.y) / 2;
  const moved = (path) => new THREE.Shape(path.getPoints().map((p) => new THREE.Vector2(p.x + dx, p.y + dy)));
  return shapes.map((s) => ({ outline: moved(s), counters: s.holes.map(moved) }));
}

function lid(machine) {
  const g = new THREE.Group();
  const h = LID_ROOM + LID_TOP; // from the top of the base walls to the top of the lid
  walls(g, OW, OD, WALL, 0, h);
  // Tabs inside the base (front and back strips are free of cales), clear of the walls by 0.3 mm.
  for (const y of [WALL + 0.3, OD - WALL - 0.3 - WALL]) block(g, WALL + 0.3, OW - WALL - 0.3, y, y + WALL, -LID_TAB, 0.01);
  // Top: lower layer solid, upper layer with the name cut out (counters of the letters kept).
  block(g, 0, OW, 0, OD, h - LID_TOP, h - ENGRAVE);
  const letters = glyphs(machine, 18, OW / 2, OD / 2);
  const plate = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(OW, 0), new THREE.Vector2(OW, OD), new THREE.Vector2(0, OD)]);
  plate.holes.push(...letters.map((l) => l.outline));
  const parts = [plate, ...letters.flatMap((l) => l.counters)];
  for (const shape of parts) {
    const geo = new THREE.ExtrudeGeometry(shape, { depth: ENGRAVE, bevelEnabled: false, curveSegments: 6 });
    geo.translate(0, 0, h - ENGRAVE);
    g.add(new THREE.Mesh(geo, mat));
  }
  volume += OW * OD * ENGRAVE;
  // Printed upside down (flat top on the bed): turned over, not mirrored, so the name reads right.
  g.rotation.x = Math.PI;
  return g;
}

function save(g, file) {
  g.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(g);
  g.position.sub(box.min); // sits on the bed at the origin
  g.updateMatrixWorld(true);
  const size = box.getSize(new THREE.Vector3());
  // Self-check: it must fit the bed.
  if (size.x > BED || size.y > BED) throw new Error(`${file} is ${size.x.toFixed(1)} × ${size.y.toFixed(1)} mm: too big for the ${BED} mm bed`);
  writeFileSync(`${outDir}/${file}`, Buffer.from(new STLExporter().parse(g, { binary: true }).buffer));
  console.log(`${file}  ${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm  ≈ ${Math.round(volume * 1.24e-3)} g PLA`);
  volume = 0;
}

mkdirSync(outDir, { recursive: true });
save(base(), 'cales-box-base.stl');
for (const m of MACHINES) save(lid(m), `cales-box-lid-${m}.stl`);
