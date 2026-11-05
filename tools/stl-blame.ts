/**
 * Which setup of a program turned or placed the part wrong, found against the real finished part (STL).
 *
 * A tool never cuts into the finished part, and every bit of raw block that is not in it is cut by
 * some setup. So each setup is judged alone: for every way the part can lie in it (24 quarter
 * turns), its tools' cuts are laid onto the STL; the finished material they would cut (wrong) and the
 * waste they cut (right) are counted. The right way cuts no finished material and as much waste as
 * any way can. The setup the app turned wrong is the one whose chosen way does worse than another,
 * however many setups there are.
 *
 *   npm run stl-blame -- <program> <part.stl> [<program> <part.stl> ...]
 */
import { readFileSync } from 'node:fs';
import { parseToolpath, speedsFor, type Vec } from '../src/lib/toolpath';
import { analyseProgram, DEFAULT_JAW_HEIGHT, type SetupInfo } from '../src/lib/setups';
import { buildInput, carve, KEPT, materialExtreme, type Grid, type SimInput } from '../src/lib/stockSim';
import { ALL, apply, mul, transpose, turnedBox, type Mat3 } from '../src/lib/orient';

const VOXELS = 300_000;
/** Less finished material cut than this (mm³) is the sim's own roughness, not a wrong turn. */
const NOISE = 15;

/** Triangles of a binary or text STL: 9 numbers each. */
function readStl(path: string): Float64Array {
  const buf = readFileSync(path);
  const count = buf.length >= 84 ? buf.readUInt32LE(80) : 0;
  if (buf.length === 84 + count * 50) {
    const out = new Float64Array(count * 9);
    for (let i = 0; i < count; i++) for (let k = 0; k < 9; k++) out[i * 9 + k] = buf.readFloatLE(84 + i * 50 + 12 + k * 4);
    return out;
  }
  const v = [...buf.toString('utf8').matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].flatMap((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  return Float64Array.from(v);
}

/** Which sample centres of grid g are inside the STL placed by p -> R p + t (parity of crossings along Z). */
function inside(tris: Float64Array, R: Mat3, t: Vec, g: Grid): Uint8Array {
  const [nx, ny, nz] = g.n;
  const hits: number[][] = Array.from({ length: nx * ny }, () => []);
  const P: Vec[] = [];
  for (let i = 0; i < tris.length; i += 3) {
    const q = apply(R, [tris[i], tris[i + 1], tris[i + 2]]);
    P.push([q[0] + t[0], q[1] + t[1], q[2] + t[2]]);
  }
  for (let f = 0; f < P.length; f += 3) {
    const [a, b, c] = [P[f], P[f + 1], P[f + 2]];
    const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(den) < 1e-12) continue;
    const i0 = Math.max(0, Math.ceil((Math.min(a[0], b[0], c[0]) - g.origin[0]) / g.step[0] - 0.5));
    const i1 = Math.min(nx - 1, Math.floor((Math.max(a[0], b[0], c[0]) - g.origin[0]) / g.step[0] - 0.5));
    const j0 = Math.max(0, Math.ceil((Math.min(a[1], b[1], c[1]) - g.origin[1]) / g.step[1] - 0.5));
    const j1 = Math.min(ny - 1, Math.floor((Math.max(a[1], b[1], c[1]) - g.origin[1]) / g.step[1] - 0.5));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const x = g.origin[0] + (i + 0.5) * g.step[0];
        const y = g.origin[1] + (j + 0.5) * g.step[1];
        const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den;
        const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den;
        if (u >= 0 && v >= 0 && u + v <= 1) hits[j * nx + i].push(u * a[2] + v * b[2] + (1 - u - v) * c[2]);
      }
  }
  const occ = new Uint8Array(nx * ny * nz);
  hits.forEach((h, col) => {
    h.sort((p, q) => p - q);
    const z = h.filter((v, n) => n === 0 || v - h[n - 1] > 1e-7);
    for (let n = 0; n + 1 < z.length; n += 2)
      for (let k = 0; k < nz; k++) {
        const pz = g.origin[2] + (k + 0.5) * g.step[2];
        if (pz > z[n] && pz < z[n + 1]) occ[k * nx * ny + col] = 1;
      }
  });
  return occ;
}

function blame(programPath: string, stlPath: string) {
  const text = readFileSync(programPath, 'utf8');
  const lines = text.split('\n');
  const tp = parseToolpath(text, speedsFor('HAAS'));
  const an = analyseProgram(tp, { jawHeight: DEFAULT_JAW_HEIGHT });
  const full = buildInput(tp, an);
  if (!full) return console.log(`${programPath}: no part size in the header, nothing to compare`);
  const base: SimInput = { ...full, maxVoxels: VOXELS, surfaceMoves: false };
  // The simulated finished part: where to lay the STL.
  const g = carve(base);
  const ext = ([0, 1, 2] as const).map((a) => [materialExtreme(base, g, base.moves.length, a, -1)!, materialExtreme(base, g, base.moves.length, a, 1)!]);
  const size = ext.map(([lo, hi]) => hi - lo);
  const mid = ext.map(([lo, hi]) => (lo + hi) / 2) as Vec;
  const tris = readStl(stlPath);
  const lo: Vec = [Infinity, Infinity, Infinity];
  const hi: Vec = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) [lo[k], hi[k]] = [Math.min(lo[k], tris[i + k]), Math.max(hi[k], tris[i + k])];
  const stlMid: Vec = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) as Vec;
  const vol = g.step[0] * g.step[1] * g.step[2];

  /** What setup k's tools cut with the part lying as `O`, shifted by `d` (machine mm): finished material (bad) and waste (good), mm³. */
  const cutInto = (occ: Uint8Array, s: SetupInfo, O: Mat3, d: Vec = [0, 0, 0]) => {
    // Placed like the app places it: against the stop (X-), the fixed jaw (Y+), its top where the app has it.
    const stock = s.stock!;
    const own = turnedBox(transpose(s.orient), stock.min.map((v, k) => v - s.offset[k]) as Vec, stock.max.map((v, k) => v - s.offset[k]) as Vec);
    const tb = turnedBox(O, own.min, own.max);
    const t: Vec = [stock.min[0] - tb.min[0] + d[0], stock.max[1] - tb.max[1] + d[1], stock.max[2] - tb.max[2] + d[2]];
    const moves = base.moves.map((m) => (m.setup === s.index ? { ...m, setup: 0 } : { ...m, points: [] }));
    const cut = carve({ ...base, moves, setups: [{ orient: O, offset: t }], dropLoose: false });
    let bad = 0;
    let good = 0;
    for (let v = 0; v < occ.length; v++) if (cut.removed[v] !== KEPT) occ[v] ? bad++ : good++;
    return { mm3: bad * vol, waste: good * vol };
  };
  /** Waste cut is the job, finished material cut is ten times as bad (a way cutting only air scores nothing). */
  const score = (w: { mm3: number; waste: number }) => w.waste - 10 * w.mm3;
  const worse = (p: { mm3: number; waste: number }, q: { mm3: number; waste: number }) => score(p) < score(q) - Math.max(10 * NOISE, Math.abs(score(q)) * 0.05);

  // The STL turned every way that has the simulated part's size. Setup 1 is the part's own frame, so it
  // must be right: of the ways where it is, the one where the STL best overlaps the simulated part.
  const fits = ALL.filter((R) => {
    const b = turnedBox(R, lo, hi);
    return [0, 1, 2].every((k) => Math.abs(b.max[k] - b.min[k] - size[k]) < Math.max(1.5, size[k] * 0.05));
  });
  if (!fits.length) return console.log(`${programPath}: the STL (${hi.map((v, k) => (v - lo[k]).toFixed(1)).join(' × ')}) is not the simulated part (${size.map((v) => v.toFixed(1)).join(' × ')})`);
  const setups = an.setups.filter((s) => s.stock && s.moves);
  let lay: { R: Mat3; occ: Uint8Array; iou: number; first: { mm3: number; waste: number } } | null = null;
  for (const R of fits) {
    const c = apply(R, stlMid);
    const occ = inside(tris, R, [mid[0] - c[0], mid[1] - c[1], mid[2] - c[2]], g);
    let both = 0;
    let either = 0;
    for (let v = 0; v < occ.length; v++) {
      const sim = g.removed[v] === KEPT;
      if (sim && occ[v]) both++;
      if (sim || occ[v]) either++;
    }
    const first = setups.length ? cutInto(occ, setups[0], setups[0].orient) : { mm3: 0, waste: 0 };
    const iou = both / either;
    if (!lay || worse(lay.first, first) || (!worse(first, lay.first) && iou > lay.iou)) lay = { R, occ, iou, first };
  }
  const rows = setups.map((s) => {
    const ways = ALL.map((O) => ({ O, ...cutInto(lay!.occ, s, O) })).sort((p, q) => score(q) - score(p));
    return { s, app: ways.find((w) => w.O.join() === s.orient.join())!, ways };
  });
  const best = { R: lay!.R, occ: lay!.occ, rows };

  console.log(`\n${programPath}  vs  ${stlPath}`);
  console.log(`finished part ${size.map((v) => v.toFixed(1)).join(' × ')} mm; simulated part and STL overlap ${(lay!.iou * 100).toFixed(1)}%`);
  // Each setup's turn is written from the setup before: a wrong turn early makes every later one
  // wrong too. The first wrong one is the cause; a later one whose own turn is right only follows it.
  let first: number | null = null;
  best.rows.forEach(({ s, app, ways }, n) => {
    const said = (w: { mm3: number; waste: number }) => `cuts ${w.mm3.toFixed(0)} mm³ of the finished part and ${w.waste.toFixed(0)} mm³ of waste`;
    // The program's own instructions (M0 stops), not the tool comments around them.
    const note = tp.setups[s.index].notes.filter((x) => /(?<![A-Z\d])M0?0(?!\d)/i.test(lines[x.line] ?? '')).map((x) => x.text).join(' / ').slice(0, 80) || '(no instructions)';
    const right = ways[0];
    const ties = ways.filter((w) => !worse(w, right)).length;
    let verdict: string;
    if (right.mm3 > 4 * NOISE && right.mm3 > right.waste * 0.25) {
      // No way of lying avoids the finished part: the STL is not what this program makes, or the part sits elsewhere.
      // Every setup after it starts from there, so it counts as the first problem.
      if (first === null) first = s.index;
      verdict = `NO WAY FITS: the app's way ${said(app)}; even the best way ${said(right)}. The STL and the program may not belong together (another revision?), or the part is placed more than 2 mm off: fix nothing from this one alone.`;
    } else if (!worse(app, right)) verdict = `OK: ${said(app)}${ties > 1 ? ` (${ties} ways do as well: the STL cannot tell them apart)` : ''}`;
    else {
      const prev = n > 0 ? best.rows[n - 1] : null;
      const relApp = prev ? mul(s.orient, transpose(prev.s.orient)) : null;
      // Any way the setup before could rightly lie (ties included), turned as the app turns it here, is a right way here.
      const good = (r: (typeof best.rows)[number]) => r.ways.filter((w) => !worse(w, r.ways[0])).map((w) => w.O.join());
      const follows = first !== null && prev && relApp && prev.ways.filter((w) => !worse(w, prev.ways[0])).some((w) => good(best.rows[n]).includes(mul(relApp, w.O).join()));
      if (follows) verdict = `follows setup ${first! + 1}: its own turn is right, it starts from setup ${first! + 1}'s wrong position`;
      else {
        if (first === null) first = s.index;
        // Turned right but placed wrong? Slide the app's way along each machine axis.
        let shift = '';
        for (const k of [0, 1, 2])
          for (const d of [-2, -1, -0.5, 0.5, 1, 2]) {
            const dd: Vec = [0, 0, 0];
            dd[k] = d;
            const m = cutInto(best.occ, s, s.orient, dd);
            if (!shift && worse(app, m) && !worse(m, right)) shift = ` Or the app's turn, moved ${d > 0 ? '+' : ''}${d} mm in ${'XYZ'[k]}: ${said(m)}.`;
          }
          // Strong: the app's way cuts a real chunk of the part and the other way almost none. Small
        // setups (a chamfer) give small numbers a slightly misplaced part can explain.
        const strong = app.mm3 >= 200 && right.mm3 <= app.mm3 * 0.2;
        verdict = `WRONG (${strong ? 'strong' : 'weak: check by hand'}): ${said(app)}. Turned ${right.O.join(',')} it ${said(right)}.${shift}`;
      }
    }
    console.log(`  setup ${s.index + 1}  [${note}]  (program line ${s.line + 1})`);
    console.log(`    app ${s.orient.join(',')} -> ${verdict}`);
    if (verdict.startsWith('WRONG') || verdict.startsWith('NO WAY')) console.log(`    best ways: ${ways.slice(0, 4).map((w) => `${w.O.join(',')} (${w.mm3.toFixed(0)} / ${w.waste.toFixed(0)})`).join('  ')}`);
  });
  console.log(first === null ? '  => no setup is wrong' : `  => cause: setup ${first + 1}`);
}

const args = process.argv.slice(2);
if (args.length < 2 || args.length % 2) {
  console.log('usage: npm run stl-blame -- <program> <part.stl> [<program> <part.stl> ...]');
  process.exit(1);
}
for (let i = 0; i < args.length; i += 2) blame(args[i], args[i + 1]);
