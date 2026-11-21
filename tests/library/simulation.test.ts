/// <reference types="node" />
/*
 * The reference library through the app's simulation, program by program, as the toolpath view
 * does it (empty turn memory): how alike the simulated part and the part's 3D model are, what the
 * setup check rejects and what collides. Compared with the recorded snapshot
 * (simulation.snap.json): any change, better or worse, fails until the snapshot is updated on
 * purpose (vitest -u), so its diff shows exactly which programs a change moved.
 *
 * Skipped without CNC_LIBRARY=<folder> (the library is the shop's and stays out of the repository).
 * Programs are named by file and a hash of their text and model, never by order.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTris } from '../../src/lib/model';
import { differences, layModel } from '../../src/lib/modelCompare';
import { analyseProgram, DEFAULT_JAW_HEIGHT } from '../../src/lib/setups';
import { buildInput } from '../../src/lib/stockSim';
import { parseToolpath, speedsFor } from '../../src/lib/toolpath';

const LIB = process.env.CNC_LIBRARY;
const hash = (b: Buffer | string) => createHash('sha1').update(b).digest('hex').slice(0, 8);

interface Row {
  result: string;
  match?: number;
  pieces?: number;
  setups: number;
  rejects: string[];
  collisions: Record<string, number>;
  conflicts: number;
}

async function simulate(text: string, model: Buffer | null): Promise<Row> {
  const tp = parseToolpath(text, speedsFor(/H#513|M254|G94\s+M95/.test(text) ? 'FANUC' : 'HAAS'));
  const an = analyseProgram(tp, { jawHeight: DEFAULT_JAW_HEIGHT });
  const collisions: Record<string, number> = {};
  for (const s of an.setups) for (const c of s.collisions) collisions[c.what ?? 'jaw'] = (collisions[c.what ?? 'jaw'] ?? 0) + 1;
  const row: Row = {
    result: '',
    setups: an.setups.length,
    rejects: an.setups.flatMap((s) => s.rejects.map((r) => (r.kind === 'cale' ? `setup ${s.index + 1}: cale ${r.mm}` : `setup ${s.index + 1}: size ${r.axis} ${r.want} (cut ${r.found})`))),
    collisions: Object.fromEntries(Object.entries(collisions).sort()),
    conflicts: an.setups.filter((s) => s.conflict).length,
  };
  const input = buildInput(tp, an);
  const tris = model ? await readTris(new Uint8Array(model)) : null;
  if (!input) row.result = 'no simulation input';
  else if (!tris || 'error' in tris) row.result = 'no model';
  else {
    const laid = layModel(tris, input, an.setups);
    if ('mismatch' in laid) row.result = 'size mismatch';
    else {
      const d = differences(laid);
      row.result = 'compared';
      row.match = Number(d.match.toFixed(4));
      row.pieces = d.pieces.length;
    }
  }
  return row;
}

describe.skipIf(!LIB)('reference library: simulation against the 3D models', () => {
  it('every program gives the recorded result', { timeout: 60 * 60_000 }, async () => {
    const rows: Record<string, Row> = {};
    const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';
    for (const folder of readdirSync(LIB!).sort()) {
      const dir = join(LIB!, folder);
      if (!/^\d+_/.test(folder) || !statSync(dir).isDirectory()) continue;
      const files = readdirSync(dir).filter((n) => n !== 'info.json' && statSync(join(dir, n)).isFile());
      const pdf = files.map((n) => readFileSync(join(dir, n))).find(isPdf) ?? null;
      for (const n of files) {
        const bytes = readFileSync(join(dir, n));
        const text = bytes.toString('latin1');
        if (isPdf(bytes) || !/[GMT]\d/.test(text)) continue;
        // The same program with the same model (a copy in another order) is one entry.
        const key = `${n} ${hash(bytes)}${pdf ? `/${hash(pdf)}` : ''}`;
        rows[key] ??= await simulate(text, pdf);
      }
    }
    const sorted = Object.fromEntries(Object.entries(rows).sort(([a], [b]) => a.localeCompare(b)));
    await expect(`${JSON.stringify(sorted, null, 1)}\n`).toMatchFileSnapshot('./simulation.snap.json');
  });
});
