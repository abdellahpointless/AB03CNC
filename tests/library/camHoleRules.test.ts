/**
 * The owner's hole rules (2026-11-27) on reference parts: each planned as before (`holes: { legacy: true }`) and as now,
 * both simulated (src/lib/cam/holeSim.ts: Haas cycles, Setting 22, trapezoidal time), every hole of the old program found
 * in the new one at the same centre and bottom, never starting in the material, no slower, the check no worse. With HOLE_REPORT=<file>
 * the table (lines, time, holes) is written there. Programs by id. Skipped without CNC_LIBRARY=<folder>.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareHoles, simulate } from '../../src/lib/cam/holeSim';
import { LIB, plan } from './plan';

const PARTS = [['P242c06c0', 'ALU'], ['P5295c45b', 'POM'], ['P52e28c09', 'PCGF'], ['Pf2990f37', 'ALU']] as const;
const rows: Record<string, unknown>[] = [];

describe.skipIf(!LIB)('reference library: holes as the owner asked, against the old way', () => {
  for (const [id, material] of PARTS)
    it(`${id}: every hole where it was, as deep, never starting in the material, no slower`, { timeout: 30 * 60_000 }, async () => {
      const [before, after] = [await plan(id, material, { holes: { legacy: true } }), await plan(id, material)];
      const [a, b] = [simulate(before.code), simulate(after.code)];
      const problems = compareHoles(a, b);
      const cycles = (r: typeof a) => r.holes.filter((h) => h.how !== 'milled');
      const kinds = (r: typeof a) => Object.fromEntries(['G81', 'G73', 'G83', 'milled'].map((k) => [k, r.holes.filter((h) => h.how === k).length]));
      rows.push({
        id,
        material,
        lines: [a.lines, b.lines],
        seconds: [Math.round(a.seconds), Math.round(b.seconds)],
        holes: [a.holes.length, b.holes.length],
        cycles: [kinds(a), kinds(b)],
        milledG01: [before.code.split('\n').filter((l) => / G01 /.test(l)).length, after.code.split('\n').filter((l) => / G01 /.test(l)).length],
        check: [before.check, after.check].map((c) => ({ match: c.match, collisions: c.collisions, rapids: c.rapids, cales: c.cales })),
        problems,
      });
      if (process.env.HOLE_REPORT) writeFileSync(process.env.HOLE_REPORT, JSON.stringify(rows, null, 1));
      if (process.env.HOLE_CODE) for (const [k, r] of [['before', before], ['after', after]] as const) writeFileSync(`${process.env.HOLE_CODE}/${id}.${k}.nc`, r.code);
      expect(problems).toEqual([]);
      expect(cycles(b).length).toBe(cycles(a).length);
      // Lines are reported, not held: the safe start adds one a tool and a G99 group's end two; the time is held.
      expect(b.seconds).toBeLessThanOrEqual(a.seconds * 1.01);
      expect(after.check.collisions).toBeLessThanOrEqual(before.check.collisions);
      expect(after.check.rapids ?? 0).toBeLessThanOrEqual(before.check.rapids ?? 0);
      expect(after.check.match).toBeGreaterThanOrEqual(before.check.match - 0.002);
    });
});
