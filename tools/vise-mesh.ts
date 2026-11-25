/*
 * The shop's vise for the 3D views (src/lib/viseModel.ts), from its maker's STEP model (Haas HMV-6F-08, not in the
 * repository): each body read once, in the vise's own frame (mm): X0 the jaw plates' left end, Y0 the fixed jaw
 * plate's face, Z0 the bed the parallels stand on; machine X/Y/Z as in the app (moving jaw at Y-, the fixed one at Y+).
 * Two things change, as the shop's vise is: the jaw plates' tops are raised to exactly 45 mm over the bed (the model
 * has 44.5), and both jaws are made 150 mm long, shortened from their right end (the model's are 152). Thread inside
 * the jaws and the body (never seen) is left out to keep the mesh small.
 *
 *   npm run vise-mesh -- "<path to the .step>"
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import occtimportjs from 'occt-import-js';

type Mesh = { name: string; attributes: { position: { array: number[] }; normal?: { array: number[] } }; index: { array: number[] } };
type Occt = { ReadStepFile: (buf: Uint8Array, p: Record<string, unknown>) => { success: boolean; meshes: Mesh[] } };

const JAW_HEIGHT = 45;
const JAW_LENGTH = 150;
/** Model units per stored unit: positions as 16-bit integers of 1/50 mm. */
const Q = 50;
/** The bodies by their number in the model ("... - part 07"): what each is, which mesh it goes to. */
const BODIES: Record<string, { mesh: MeshName; keep?: (y: number) => boolean }> = {
  '01': { mesh: 'fixedBody' }, // the cast body
  '03': { mesh: 'fixedJaw' }, // the fixed jaw
  '07': { mesh: 'fixedPlate' }, // its jaw plate
  '04': { mesh: 'fixedBody', keep: (y) => y < 5 || y > 380 }, // the screw: its two ends, the rest inside the body
  '06': { mesh: 'fixedBody' }, // the cover over the screw's slot
  '09': { mesh: 'fixedBody' }, // the screw's hex end
  '12': { mesh: 'fixedBody', keep: (y) => y < 383.5 }, // the fixed plate's screws: heads only
  '13': { mesh: 'fixedBody', keep: (y) => y < 383.5 },
  '02': { mesh: 'movingJaw' }, // the moving jaw
  '08': { mesh: 'movingPlate' }, // its jaw plate
  '05': { mesh: 'movingBody' }, // the nut under it
  '10': { mesh: 'movingBody', keep: (y) => y > 123 }, // the moving plate's screws: heads only
  '11': { mesh: 'movingBody', keep: (y) => y > 123 },
  '14': { mesh: 'movingBody' }, // the plates on the moving jaw's sides
  '14 (1)': { mesh: 'movingBody' },
};
/** The jaws and what is on their right end: shortened there to JAW_LENGTH. */
const JAWS = new Set(['02', '03', '07', '08', '14 (1)']);
/**
 * The jaws' tapped holes for the plate screws (along Y, near this X/Z in the model, over these Y): their thread, some
 * 8,000 triangles a hole, swapped for a plain tube at the thread's outside radius (the hole's mouth stays where it is).
 */
const HOLES: Record<string, { x: number; z: number; y: [number, number] }[]> = {
  '03': [{ x: -372.7, z: -19.2, y: [383.5, 435.5] }, { x: -274.3, z: -19.2, y: [383.5, 435.5] }],
  '02': [{ x: -372.2, z: -18.2, y: [0, 123] }, { x: -273.8, z: -18.2, y: [0, 123] }],
};
const MESHES = ['fixedBody', 'fixedJaw', 'fixedPlate', 'movingBody', 'movingJaw', 'movingPlate'] as const;
type MeshName = (typeof MESHES)[number];

const occt = await (occtimportjs as unknown as () => Promise<Occt>)();
const file = process.argv[2];
if (!file) throw new Error('usage: npm run vise-mesh -- <vise.step>');
const r = occt.ReadStepFile(new Uint8Array(readFileSync(file)), { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.25, angularDeflection: 0.6 });
if (!r.success) throw new Error('The STEP file could not be read.');
const byNo = new Map(r.meshes.map((m) => [m.name.match(/part (\d+(?: \(\d+\))?)$/)?.[1] ?? m.name, m]));
const missing = Object.keys(BODIES).filter((k) => !byNo.has(k));
if (missing.length || byNo.size !== Object.keys(BODIES).length) throw new Error(`Not the expected vise: bodies ${[...byNo.keys()].join(', ')}`);

const box = (m: Mesh) => {
  const p = m.attributes.position.array;
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let k = 0; k < p.length; k += 3) for (let a = 0; a < 3; a++) (b[a] = Math.min(b[a], p[k + a])), (b[a + 3] = Math.max(b[a + 3], p[k + a]));
  return b;
};
// The frame: the fixed plate's left end and face, the bed (the body's top, where the plates stand).
const fixedPlate = box(byNo.get('07')!);
const movingPlate = box(byNo.get('08')!);
const body = box(byNo.get('01')!);
const [X0, Y0, Z0] = [fixedPlate[0], fixedPlate[1], body[5]];
if (Math.abs(fixedPlate[2] - Z0) > 0.01 || Math.abs(movingPlate[2] - Z0) > 0.01) throw new Error('The jaw plates do not stand on the bed.');
const modelHeight = fixedPlate[5] - Z0;

const out: Record<MeshName, { pos: number[]; nrm: number[]; idx: number[] }> = Object.fromEntries(MESHES.map((n) => [n, { pos: [], nrm: [], idx: [] }])) as never;
for (const [no, spec] of Object.entries(BODIES)) {
  const m = byNo.get(no)!;
  const p = m.attributes.position.array;
  const n = m.attributes.normal?.array;
  const plate = no === '07' || no === '08';
  // Each plate from its own top (the two differ by 0.005 mm in the model).
  const lift = plate ? JAW_HEIGHT - (box(m)[5] - Z0) : 0;
  // The jaws' right end band (past their screw holes, under 132 mm) moved in as a whole.
  const trim = JAWS.has(no) ? JAW_LENGTH - (fixedPlate[3] - X0) : 0;
  const o = out[spec.mesh];
  const base = o.pos.length / 3;
  for (let k = 0; k < p.length; k += 3) {
    let z = p[k + 2] - Z0;
    // The jaw height: the plate's top band raised as a whole (its screw holes, under 34 mm, stay where they are).
    if (plate && z > 38) z += lift;
    const x = p[k] - X0;
    o.pos.push(x > 140 ? x + trim : x, p[k + 1] - Y0, z);
    o.nrm.push(n ? n[k] : 0, n ? n[k + 1] : 0, n ? n[k + 2] : 1);
  }
  const ix = m.index.array;
  // Each tapped hole: its axis (the middle of the thread) and outside radius, from the model itself.
  const holes = (HOLES[no] ?? []).map((h) => {
    const near: number[] = [];
    for (let k = 0; k < p.length; k += 3) if (p[k + 1] >= h.y[0] - 0.01 && p[k + 1] <= h.y[1] + 0.01 && Math.hypot(p[k] - h.x, p[k + 2] - h.z) < 7) near.push(k);
    const xs = near.map((k) => p[k]);
    const zs = near.map((k) => p[k + 2]);
    const ax = (Math.min(...xs) + Math.max(...xs)) / 2;
    const az = (Math.min(...zs) + Math.max(...zs)) / 2;
    const r = Math.max(...near.map((k) => Math.hypot(p[k] - ax, p[k + 2] - az)));
    if (!(r > 3 && r < 7)) throw new Error(`Hole of body ${no} not found where expected.`);
    return { ax, az, r, y: h.y };
  });
  const inHole = (k: number) => holes.some((h) => p[k + 1] >= h.y[0] - 0.01 && p[k + 1] <= h.y[1] + 0.01 && Math.hypot(p[k] - h.ax, p[k + 2] - h.az) <= h.r + 0.01);
  let dropped = 0;
  for (let t = 0; t < ix.length; t += 3) {
    if (spec.keep && ![0, 1, 2].some((j) => spec.keep!(p[3 * ix[t + j] + 1]))) continue;
    if (holes.length && [0, 1, 2].every((j) => inHole(3 * ix[t + j]))) {
      dropped++;
      continue;
    }
    o.idx.push(base + ix[t], base + ix[t + 1], base + ix[t + 2]);
  }
  // The tubes: 24 sides, seen from inside (normals toward the axis).
  for (const h of holes) {
    const at = o.pos.length / 3;
    const S = 24;
    for (let i = 0; i < S; i++) {
      const a = (2 * Math.PI * i) / S;
      const [c, sn] = [Math.cos(a), Math.sin(a)];
      for (const y of h.y) {
        o.pos.push(h.ax + h.r * c - X0, y - Y0, h.az + h.r * sn - Z0);
        o.nrm.push(-c, 0, -sn);
      }
    }
    for (let i = 0; i < S; i++) {
      const [a0, a1, b0, b1] = [at + 2 * i, at + 2 * i + 1, at + 2 * ((i + 1) % S), at + 2 * ((i + 1) % S) + 1];
      // Wound so its front faces the axis.
      o.idx.push(a0, b0, a1, a1, b0, b1);
    }
  }
  if (holes.length) console.error(`body ${no}: ${dropped} thread triangles swapped for ${holes.length} tubes (r ${holes.map((h) => h.r.toFixed(2)).join(', ')} mm)`);
}

// Each mesh: its vertices as 16-bit integers (1/50 mm), normals as 8-bit, indices 16 or 32-bit; one base64 string.
const parts: { name: MeshName; vertices: number; triangles: number }[] = [];
const chunks: Buffer[] = [];
for (const name of MESHES) {
  const { pos, nrm, idx } = out[name];
  // Only the vertices the kept triangles use.
  const used = new Map<number, number>();
  const remap = idx.map((i) => (used.has(i) ? used.get(i)! : (used.set(i, used.size), used.size - 1)));
  const v = [...used.keys()];
  const P = new Int16Array(v.length * 3);
  const N = new Int8Array(v.length * 3);
  v.forEach((i, k) => {
    for (let a = 0; a < 3; a++) {
      const q = Math.round(pos[3 * i + a] * Q);
      if (Math.abs(q) > 32767) throw new Error('The vise is too big for 16-bit positions.');
      P[3 * k + a] = q;
      N[3 * k + a] = Math.round(Math.max(-1, Math.min(1, nrm[3 * i + a])) * 127);
    }
  });
  const I = v.length > 65535 ? new Uint32Array(remap) : new Uint16Array(remap);
  // Each array padded to 4 bytes, so the page can view them in place.
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  chunks.push(pad(Buffer.from(P.buffer)), pad(Buffer.from(N.buffer)), pad(Buffer.from(I.buffer)));
  parts.push({ name, vertices: v.length, triangles: remap.length / 3 });
}
const data = Buffer.concat(chunks).toString('base64');

const plateTop = Math.max(...out.fixedPlate.pos.filter((_, k) => k % 3 === 2), ...out.movingPlate.pos.filter((_, k) => k % 3 === 2));
const sizes = (b: number[]) => [b[0] - X0, b[1] - Y0, b[2] - Z0, b[3] - X0, b[4] - Y0, b[5] - Z0].map((x) => Math.round(x * 100) / 100);
const frame = {
  modelJawLength: Math.round((fixedPlate[3] - fixedPlate[0]) * 100) / 100,
  jawLength: Math.round(Math.max(...out.fixedPlate.pos.filter((_, k) => k % 3 === 0)) * 1000) / 1000,
  /** The moving plate's face as modelled (fully open): how far it is from the fixed one. */
  opening: Math.round((Y0 - movingPlate[4]) * 100) / 100,
  modelJawHeight: Math.round(modelHeight * 100) / 100,
  jawHeight: Math.round(plateTop * 1000) / 1000,
  body: sizes(body),
};
console.log(JSON.stringify({ frame, parts, bytes: data.length }, null, 1));

writeFileSync(
  // npm runs it from the repository's root.
  resolve('src/lib/viseModel.ts'),
  `// Generated by tools/vise-mesh.ts from the shop's vise (Haas HMV-6F-08), its jaw plates raised to ${JAW_HEIGHT} mm. Do not edit.
/** The vise's frame (mm): X0 the jaws' left end, Y0 the fixed jaw plate's face, Z0 the bed; the moving jaw as modelled, fully open. */
export const VISE_FRAME = ${JSON.stringify({ ...frame, quantum: 1 / Q })} as const;
/** Its meshes, in this order in DATA: positions (Int16 ×3, 1/${Q} mm), normals (Int8 ×3), indices (Uint16, or Uint32 over 65535 vertices), each padded to 4 bytes. */
export const VISE_PARTS = ${JSON.stringify(parts)} as const;
export const VISE_DATA = '${data}';
`,
);
