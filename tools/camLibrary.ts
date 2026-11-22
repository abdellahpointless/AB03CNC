/**
 * CAM AI on the reference library (Phase 4 validation): for each part with a 3D model, the program
 * CAM AI makes from the model, simulated and checked against the model, next to the engineers'
 * program (setups, parallels, tools, cutting data, cycles, line count, time).
 *
 *   npm run cam-library -- <library folder> <out.jsonl> [program file ...]
 *
 * One JSON line per program, written as each is done (a long run keeps what it finished). Only
 * program ids and numbers are written, never file or part names (the results may be shared).
 */
import { createHash } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProgram } from '../src/lib/cam/learn';
import { partTypeOf } from '../src/lib/cam/partType';
import { camProgram } from '../src/lib/cam/program';
import { CAM_MATERIALS, type CamMaterial } from '../src/lib/cam/tools';
import { readTris } from '../src/lib/model';
import { movePath } from '../src/lib/playback';
import { analyseProgram, DEFAULT_JAW_HEIGHT, readInstructions } from '../src/lib/setups';
import { buildInput, carve, KEPT } from '../src/lib/stockSim';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';

const [LIB, OUT, ...ONLY] = process.argv.slice(2);
if (!LIB || !OUT) throw new Error('usage: npm run cam-library -- <library folder> <out.jsonl> [program file ...]');

/** The header's material as CAM AI names it (null: CAM AI does not cut it). */
const MATERIAL: Record<string, CamMaterial> = { ALU: 'ALU', POM: 'POM', FH: 'FH', 'PC GF': 'PCGF', MS: 'MS', PEEK: 'PEEK', EPO: 'EPO', RESOPAL: 'RESOPAL' };

/** What a program does, read the same way for both (the engineers' and CAM AI's). */
function summary(code: string) {
  const fanuc = /H#513|M254|G94\s+M95/.test(code);
  const tp = parseToolpath(code, speedsFor(fanuc ? 'FANUC' : 'HAAS'));
  const an = analyseProgram(tp, { jawHeight: DEFAULT_JAW_HEIGHT });
  const read = readProgram(code);
  const lines = code.split('\n');
  const count = (re: RegExp) => lines.filter((l) => re.test(l.replace(/\([^)]*\)/g, ''))).length;
  // Straight moves that write the feed again unchanged (the shop leaves it out: gcode.feedOnlyWhenChanged).
  let feed = '';
  let sameFeed = 0;
  for (const l of lines) {
    const c = l.replace(/\([^)]*\)/g, '');
    if (/M0?6(?![0-9])|G8\d/.test(c)) feed = '';
    const f = c.match(/(?<![A-Z])F(\d*\.?\d*)/)?.[1];
    if (f === undefined) continue;
    if (feed && Number(f) === Number(feed) && /(?<![A-Z])G0*1(?![0-9])|^\s*(N\d+\s*)?[XYZ]/.test(c)) sameFeed++;
    feed = f;
  }
  // Where the time goes: minutes per tool (its code's type and Ø, else its number: never the comment's
  // free text), in rapids, and in tool changes.
  const byTool = new Map<string, number>();
  for (const t of tp.tools) {
    const c = t.label.match(/\b([A-Z]{2,3})_(\d+\.\d+)_\d{3}_/);
    const key = c ? `${c[1]} ${Number(c[2])}` : `T${t.tool}`;
    byTool.set(key, (byTool.get(key) ?? 0) + t.seconds / 60);
  }
  const min1 = (s: number) => Math.round(s * 10) / 10;
  const time = {
    tools: [...byTool].sort((a, b) => b[1] - a[1]).map(([k, m]) => [k, min1(m)]),
    rapid: min1(tp.moves.filter((m) => m.kind === 'rapid').reduce((s, m) => s + m.seconds, 0) / 60),
    changes: min1((tp.totalSeconds - tp.tools.reduce((s, t) => s + t.seconds, 0)) / 60),
  };
  return {
    sameFeed,
    time,
    // Per clamping, how far inside the written box the held faces (between the vise floor and the jaw
    // tops) lie at the stop and at the fixed jaw (mm): what the part would sit off where the program puts it.
    placement: an.setups.map((s) => (s.grip && s.clampBox ? [Math.round((s.grip.stop - s.clampBox.min[0]) * 100) / 100, Math.round((s.clampBox.max[1] - s.grip.back) * 100) / 100] : null)),
    setups: an.setups.length,
    parallels: an.setups.map((s) => readInstructions(s.notes).support),
    turns: an.setups.slice(1).map((s) => s.turns.map((t) => `${t.axis}${t.deg}`).join(' ') || '-'),
    tools: [...new Set(read.samples.map((s) => `${s.type} ${s.d}`))].sort(),
    cutting: read.samples.map((s) => ({ kind: s.kind, tool: `${s.type} ${s.d}`, s: s.s, f: s.f })),
    order: read.order.map((o) => o.join(' > ')),
    cycles: { G81: count(/(?<![A-Z])G81(?![0-9])/), G83: count(/(?<![A-Z])G83(?![0-9])/), G84: count(/(?<![A-Z])G84(?![0-9])/) },
    arcs: count(/(?<![A-Z])G0*[23](?![0-9])/),
    lines: lines.length,
    minutes: Math.round(tp.totalSeconds / 6) / 10,
  };
}

/**
 * CAM_FINE=<voxels>: what the app's check (300k voxels) can miss, counted again on a finer grid:
 * rapids that take material (a crash), and straight feed plunges of an end mill into material
 * (over a quarter of its disc down their depth; reported only, the check has no rule for them).
 */
function fine(code: string, voxels: number) {
  const tp = parseToolpath(code, speedsFor('HAAS'));
  const sim = buildInput(tp, analyseProgram(tp, { jawHeight: DEFAULT_JAW_HEIGHT }));
  if (!sim) return null;
  // Every move cuts, rapids too, as in the check: what a rapid would take first.
  const g = carve({ ...sim, moves: tp.moves.map((m) => ({ setup: m.setup, tool: m.tool, points: movePath(m) })), maxVoxels: voxels, surfaceMoves: false, dropLoose: false });
  const vox = g.step[0] * g.step[1] * g.step[2];
  const took = new Int32Array(tp.moves.length);
  for (const i of g.removed) if (i !== KEPT) took[i]++;
  let rapids = 0;
  let rapidMm3 = 0;
  let plunges = 0;
  tp.moves.forEach((m, i) => {
    if (!took[i]) return;
    const [a, b] = [m.points[0], m.points[m.points.length - 1]];
    if (m.kind === 'rapid') {
      rapids++;
      rapidMm3 += took[i] * vox;
    } else if (m.kind === 'feed' && /FRAESEN|SCHLICHT/.test(m.op ?? '') && Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-4 && b[2] < a[2]) {
      const r = (m.dia ?? 0) / 2;
      if (r > 0 && took[i] * vox > 0.25 * Math.PI * r * r * (a[2] - b[2])) plunges++;
    }
  });
  return { voxel: Math.round(g.size * 1000) / 1000, rapids, rapidMm3: Math.round(rapidMm3 * 10) / 10, plunges };
}

const seen = new Set<string>();
if (!ONLY.length) writeFileSync(OUT, '');
for (const folder of readdirSync(LIB).sort()) {
  const dir = join(LIB, folder);
  if (!/^\d+_/.test(folder) || !statSync(dir).isDirectory()) continue;
  const files = readdirSync(dir).filter((n) => n !== 'info.json' && statSync(join(dir, n)).isFile()).sort();
  const pdf = files.map((n) => readFileSync(join(dir, n))).find((b) => b.subarray(0, 5).toString('latin1') === '%PDF-');
  if (!pdf) continue;
  for (const file of files) {
    if (ONLY.length && !ONLY.includes(file)) continue;
    const bytes = readFileSync(join(dir, file));
    const text = bytes.toString('latin1');
    if (bytes.subarray(0, 5).toString('latin1') === '%PDF-' || !/[GMT]\d/.test(text)) continue;
    const hash = createHash('sha1').update(bytes).digest('hex');
    if (seen.has(hash)) continue;
    seen.add(hash);
    const read = readProgram(text, file);
    const material = MATERIAL[read.material ?? ''] ?? null;
    // Named by a neutral id (P and the first 8 hex digits of the file's SHA-1), never its file name.
    const row: Record<string, unknown> = { id: `P${hash.slice(0, 8)}`, material: read.material };
    const tris = await readTris(new Uint8Array(pdf));
    if (!material || !CAM_MATERIALS.includes(material)) row.result = 'material not cut by CAM AI';
    else if ('error' in tris) row.result = `model: ${tris.error}`;
    else {
      // The engineers' blank, its sides matched to the model's by size.
      let raw: [number, number, number] | null = null;
      if (read.raw) {
        const xs: number[] = [];
        for (let i = 0; i < tris.length; i += 3) xs.push(tris[i]);
        const size = [0, 1, 2].map((k) => {
          let lo = Infinity;
          let hi = -Infinity;
          for (let i = k; i < tris.length; i += 3) {
            lo = Math.min(lo, tris[i]);
            hi = Math.max(hi, tris[i]);
          }
          return hi - lo;
        });
        const bySize = [0, 1, 2].sort((a, b) => size[a] - size[b]);
        const blank = [...read.raw].sort((a, b) => a - b);
        raw = [0, 0, 0];
        bySize.forEach((axis, k) => (raw![axis] = blank[k]));
        if (raw.some((v, k) => v < size[k] - 0.01)) raw = null;
      }
      const named = text.split('\n').slice(0, 15).find((l) => /\d\s*X\s*\d+(?:[.,]\d+)?\s*X\s*\d/i.test(l))?.replace(/^\s*N\d+\s*/, '').replace(/^\(/, '').split('/')[0] ?? '';
      const t0 = Date.now();
      try {
        const r = camProgram({ tris, material, tools: [], brand: 'HAAS', name: 'TEIL', raw, partType: partTypeOf(named) ?? undefined });
        row.result = 'made';
        row.seconds = Math.round((Date.now() - t0) / 1000);
        row.check = {
          match: r.check.match,
          collisions: r.check.collisions,
          // Of those, tools or holders into the stop below the jaw tops.
          stops: r.check.stops,
          cales: r.check.cales,
          misplaced: r.check.misplaced,
          gougeMm3: Math.round(Math.max(0, ...r.check.pieces.filter((p) => p.kind === 'cut').map((p) => p.mm3))),
          missing: r.missing.length,
          // The vise check (physics.ts): every clamping holds the part safely; else the app locks the program.
          vise: r.setups.every((s) => s.physics.ok),
        };
        // What CAM AI tells the operator it did not do (camAi.note.*), by key.
        row.notes = r.notes.map((n) => n.key);
        // Clampings in the POM nest: how far its top (walls, set screws under it) stays under the face the face
        // mill cuts, mm (0.5 or more).
        row.nests = r.setups.filter((s) => s.nest).map((s) => Math.round(-(s.nest!.min[2] + s.nest!.size[2]) * 100) / 100);
        // Per clamping, how far the stock above the jaws stands out past the held face at the stop (mm):
        // only there does the stop's height matter (a stop above the jaws would touch that stock instead).
        row.overhang = r.setups.map((s) => Math.round((s.held[0] - s.box[0]) * 100) / 100);
        row.cam = summary(r.code);
        if (process.env.CAM_FINE) row.fine = fine(r.code, Number(process.env.CAM_FINE));
        // CAM_CODE_DIR=<folder>: also keep the program itself, named by the id (for studying its moves).
        if (process.env.CAM_CODE_DIR) writeFileSync(join(process.env.CAM_CODE_DIR, `${row.id}.nc`), r.code);
      } catch (e) {
        row.result = `failed: ${(e as Error).message}`;
      }
    }
    row.engineers = summary(text);
    appendFileSync(OUT, `${JSON.stringify(row)}\n`);
    console.log(file, row.result, row.seconds ?? '', (row.check as { match?: number } | undefined)?.match ?? '');
  }
}
