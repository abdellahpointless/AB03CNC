/**
 * CAM AI's smaller end mills on a reference part: a ring that ground still left above its level makes it
 * start higher (program.ts upTo), and what a larger mill's own raised rings cut there is gone. Planned as
 * tools/camLibrary.ts plans it. Programs by id (P and the first 8 hex digits of the file's SHA-1).
 * Skipped without CNC_LIBRARY=<folder>.
 */
import { describe, expect, it } from 'vitest';
import { LIB, plan } from './plan';

describe.skipIf(!LIB)('reference library: a smaller end mill is not sent up for ground a larger one took', () => {
  // Pcbf6262d (PC GF): the Ø3 takes a band from Z0 (a sliver the Ø8 left at the top); the Ø1.5 that follows
  // under it ran one of its rings 73 passes from Z0 for that same sliver, already gone (0.8 of its 5.8 minutes).
  it('Pcbf6262d: the Ø1.5 roughing starts under the band its Ø3 took', { timeout: 30 * 60_000 }, async () => {
    const r = await plan('Pcbf6262d', 'PCGF');
    const lines = r.setups.flatMap((s) => s.ops).filter((o) => o.name === 'FRAESEN_1.5MM').flatMap((o) => o.lines);
    expect(lines.length).toBeGreaterThan(0);
    const highest = Math.max(...lines.flatMap((l) => (/^G01\b.*Z/.test(l) ? [Number(l.match(/Z(-?[\d.]+)/)![1])] : [])));
    expect(highest).toBeLessThan(-9);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  });
});
