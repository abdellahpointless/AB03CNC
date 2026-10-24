// Cale holders to 3D-print: one rack per machine, in two halves that each fit a 180 × 180 mm bed.
// Open rack, no lid (cheapest in filament): two slotted end combs joined by low side walls. Each
// slot holds one pair standing on edge; the heights are raised on the front, the machine on the back.
//
// Usage: node scripts/cales-holder-stl.mjs <outDir> [cale length mm] [cale thickness mm] [MACHINE ...]
import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [outDir, len = '150', thick = '10', ...names] = process.argv.slice(2);
if (!outDir) throw new Error('usage: node scripts/cales-holder-stl.mjs <outDir> [length] [thickness] [MACHINE ...]');
const L = Number(len); // cale length
const T = Number(thick); // cale thickness
const MACHINES = names.length ? names : ['HAAS-1', 'HAAS-2', 'HAAS-3', 'HAAS-4', 'HAAS-5', 'FANUC-1', 'FANUC-2', 'DMG-1'];
const HEIGHTS = [43, 42, 41, 40, 38, 35, 33, 30, 28, 25, 22, 20, 15, 8]; // as in src/lib/cales.ts
const BED = 180;

const CLEAR = 0.8; // play in each slot and along the length (FDM prints a little tight)
const WALL = 1.2; // 3 lines with a 0.4 mm nozzle
const FLOOR = 1.2; // under the cale ends
const HOLD = 10; // how far each comb reaches under the cale ends
const H = 10; // comb height: keeps the 43 mm pair upright
const SIDE_H = 5; // side walls joining the two combs
const EMBOSS = 0.6; // raised text

const S = 2 * T + CLEAR; // slot: one pair side by side
const PER_HALF = HEIGHTS.length / 2;
const font = new FontLoader().parse(
  JSON.parse(readFileSync(createRequire(import.meta.url).resolve('three/examples/fonts/helvetiker_bold.typeface.json'), 'utf8')),
);
const mat = new THREE.MeshBasicMaterial();

/** A solid block from x0..x1, y0..y1, z0..z1 (overlapping blocks are merged by the slicer). */
function block(g, x0, x1, y0, y1, z0, z1) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  g.add(m);
}

/** Raised text on the front face (y = 0) or, read from behind, on the back face (y = yBack). */
function text(g, str, size, x, z, yBack) {
  const geo = new TextGeometry(str, { font, size, depth: EMBOSS + 0.2, curveSegments: 4 });
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  geo.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, 0);
  geo.rotateX(Math.PI / 2); // stands up on the face, raised outwards (-y), 0.2 mm sunk into the wall
  if (yBack === undefined) geo.translate(x, 0.2, z);
  else {
    geo.rotateZ(Math.PI); // faces +y, reads left to right from behind
    geo.translate(x, yBack - 0.2, z);
  }
  g.add(new THREE.Mesh(geo, mat));
}

/** One comb: floor under the cale ends, end wall, a finger between every two slots. */
function comb(g, slots, y0, front) {
  const w = slots * S + (slots + 1) * WALL;
  block(g, 0, w, y0, y0 + WALL + HOLD, 0, FLOOR);
  block(g, 0, w, front ? y0 : y0 + HOLD, front ? y0 + WALL : y0 + HOLD + WALL, 0, H);
  for (let i = 0; i <= slots; i++) block(g, i * (S + WALL), i * (S + WALL) + WALL, y0, y0 + WALL + HOLD, 0, H);
  return w;
}

function holder(machine, heights) {
  const g = new THREE.Group();
  const len = L + CLEAR + 2 * WALL;
  const w = comb(g, heights.length, 0, true);
  comb(g, heights.length, len - WALL - HOLD, false);
  block(g, 0, WALL, 0, len, 0, SIDE_H);
  block(g, w - WALL, w, 0, len, 0, SIDE_H);
  heights.forEach((h, i) => text(g, String(h), 6, i * (S + WALL) + WALL + S / 2, H / 2));
  text(g, `${machine}  ${heights[0]}-${heights[heights.length - 1]}`, 5, w / 2, H / 2, len);
  return g;
}

function save(g, file) {
  g.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3());
  // Self-check: it must fit the bed.
  if (size.x > BED || size.y > BED) throw new Error(`${file} is ${size.x.toFixed(1)} × ${size.y.toFixed(1)} mm: too big for the ${BED} mm bed`);
  writeFileSync(`${outDir}/${file}`, Buffer.from(new STLExporter().parse(g, { binary: true }).buffer));
  console.log(`${file}  ${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm`);
}

mkdirSync(outDir, { recursive: true });
for (const m of MACHINES)
  for (const part of [HEIGHTS.slice(0, PER_HALF), HEIGHTS.slice(PER_HALF)])
    save(holder(m, part), `${m}-cales-${part[0]}-${part[part.length - 1]}.stl`);

// Print this first (a few grams): one pair must slide in with a little play.
const fit = new THREE.Group();
comb(fit, 2, 0, true);
save(fit, 'fit-test.stl');
