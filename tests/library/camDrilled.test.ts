/**
 * You (batch 10): no end mill after a drill in a hole the drill could have made. On these reference parts the reader
 * took a hole for blind (Z-10 of a 20.5 mm part, Pf2990f37) while the model is open under it through the part: the
 * drill stopped there and an end mill of its Ø went on down the same hole. Planned as tools/camLibrary.ts plans it;
 * programs by id. Skipped without CNC_LIBRARY=<folder>.
 */
import { describe, expect, it } from 'vitest';
import type { CamOp } from '../../src/lib/cam/program';
import { LIB, plan } from './plan';

/**
 * Each drilled hole of a clamping (cycle positions, the drill's Ø and tip), and the end mills of its Ø that go on down it
 * more than 1 mm past the drill's tip (where the drill should have gone). Cleaning a drill's point where the hole opens
 * into a cavity with a floor stays: the drill cannot make that floor (the material is not the drill's to remove).
 */
function millsInDrilled(ops: CamOp[]): string[] {
  const holes: { x: number; y: number; d: number; tip: number }[] = [];
  const out: string[] = [];
  for (const op of ops) {
    if (op.kind === 'drill' && op.purpose === 'drill') {
      let x = NaN;
      let y = NaN;
      let tip = NaN;
      for (const l of op.lines) {
        x = Number(l.match(/X(-?[\d.]+)/)?.[1] ?? x);
        y = Number(l.match(/Y(-?[\d.]+)/)?.[1] ?? y);
        if (/G8[1-3]/.test(l)) tip = Number(l.match(/ Z(-?[\d.]+)/)![1]);
        if (/G8[1-3]/.test(l) || (/^X|^Y/.test(l.trim()) && holes.length)) holes.push({ x, y, d: op.tool.diameter, tip });
      }
      continue;
    }
    if (op.kind !== 'pocket' && op.kind !== 'contour' && op.kind !== 'finish') continue;
    let p = [NaN, NaN, NaN];
    for (const l of op.lines) {
      p = ['X', 'Y', 'Z'].map((a, k) => Number(l.match(new RegExp(`${a}(-?[\\d.]+)`))?.[1] ?? p[k]));
      if (!/^G0?[123]\b/.test(l) || p[2] > -0.2) continue;
      const r = op.tool.diameter / 2;
      for (const h of holes) if (p[2] < h.tip - 1 && r >= h.d / 2 - 0.5 && r <= h.d / 2 + 0.03 && Math.hypot(p[0] - h.x, p[1] - h.y) < Math.max(h.d / 2 - r, 0) + 0.05) out.push(`Ø${h.d} at ${h.x},${h.y}: ${op.name} Ø${op.tool.diameter} Z${p[2]}`);
    }
  }
  return [...new Set(out)];
}

describe.skipIf(!LIB)('reference library: a hole open on down in the model is drilled to where it closes, no end mill after the drill', () => {
  // Pf2990f37, P6b923b7f, P29c8c5a5: open on down through the part. P242c06c0, P16bf7182: a Ø3.3 hole the reader ended
  // 5 mm above where the model closes. P5295c45b: a Ø1.6 hole the reader split in two (open on to 1 mm over the bottom).
  for (const [id, material] of [['Pf2990f37', 'ALU'], ['P6b923b7f', 'ALU'], ['P29c8c5a5', 'PCGF'], ['P242c06c0', 'ALU'], ['P16bf7182', 'ALU'], ['P5295c45b', 'POM']] as const)
    it(`${id}: no end mill of a hole's Ø goes on down a drilled hole`, { timeout: 30 * 60_000 }, async () => {
      const r = await plan(id, material);
      expect(r.setups.flatMap((s) => millsInDrilled(s.ops))).toEqual([]);
      expect(r.check.collisions).toBe(0);
      expect(r.check.cales).toBe(0);
      expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    });
});
