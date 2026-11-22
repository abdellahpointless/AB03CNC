/**
 * CAM AI on two reference programs whose later clamping holds the part by a band narrower than what
 * stands above it: the final validation of Phase 5 found end mills going into the jaws there (270 and 135
 * hits). Each is planned as tools/camLibrary.ts plans it (the engineers' blank, the part's family from the
 * header) and must not collide. Programs by id (P and the first 8 hex digits of the file's SHA-1).
 * Skipped without CNC_LIBRARY=<folder>.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readProgram } from '../../src/lib/cam/learn';
import { partTypeOf } from '../../src/lib/cam/partType';
import { camProgram } from '../../src/lib/cam/program';
import { readTris } from '../../src/lib/model';

const LIB = process.env.CNC_LIBRARY;

/** The program with this id and its folder's 3D model. */
function find(id: string): { text: string; pdf: Uint8Array } | null {
  for (const folder of readdirSync(LIB!)) {
    const dir = join(LIB!, folder);
    if (!/^\d+_/.test(folder) || !statSync(dir).isDirectory()) continue;
    const files = readdirSync(dir).filter((n) => n !== 'info.json' && statSync(join(dir, n)).isFile()).map((n) => readFileSync(join(dir, n)));
    const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';
    const prog = files.find((b) => !isPdf(b) && `P${createHash('sha1').update(b).digest('hex').slice(0, 8)}` === id);
    const pdf = files.find(isPdf);
    if (prog && pdf) return { text: prog.toString('latin1'), pdf: new Uint8Array(pdf) };
  }
  return null;
}

describe.skipIf(!LIB)('reference library: CAM AI keeps off the jaws', () => {
  for (const id of ['P6b923b7f', 'Pf2990f37'])
    it(`${id}: no tool into the jaws, held by a narrow band`, { timeout: 30 * 60_000 }, async () => {
      const found = find(id);
      expect(found, id).toBeTruthy();
      const tris = await readTris(found!.pdf);
      if ('error' in tris) throw new Error(String(tris.error));
      const read = readProgram(found!.text, id);
      // The engineers' blank, its sides matched to the model's by size.
      const size = [0, 1, 2].map((k) => {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = k; i < tris.length; i += 3) [lo, hi] = [Math.min(lo, tris[i]), Math.max(hi, tris[i])];
        return hi - lo;
      });
      const blank = [...read.raw!].sort((a, b) => a - b);
      const raw: [number, number, number] = [0, 0, 0];
      [0, 1, 2].sort((a, b) => size[a] - size[b]).forEach((axis, k) => (raw[axis] = blank[k]));
      const named = found!.text.split('\n').slice(0, 15).find((l) => /\d\s*X\s*\d+(?:[.,]\d+)?\s*X\s*\d/i.test(l))?.replace(/^\s*N\d+\s*/, '').replace(/^\(/, '').split('/')[0] ?? '';
      const r = camProgram({ tris, material: 'ALU', tools: [], brand: 'HAAS', name: 'TEIL', raw, partType: partTypeOf(named) ?? undefined });
      expect(r.check.collisions).toBe(0);
    });
});
