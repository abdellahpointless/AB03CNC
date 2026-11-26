import { describe, expect, it } from 'vitest';
import { passed, safe } from '../src/components/CamAiResult';
import type { CamSummary } from '../src/lib/cam/cam.worker';

// You (2026-11-27): a tool changed by hand to another Ø may leave the part bigger, so the vise holds it off where a
// later clamping's zero assumes ("misplaced"). The operator knows why: their tick accepts it. Nothing that hits is.
const base = { collisions: 0, cales: 0, misplaced: 0, match: 1, sized: true, gouge: 0, notes: [], setups: [{ physics: { ok: true }, ops: [{ unsafe: false }] }] } as unknown as CamSummary;

describe('a part changed by hand, accepted as it is', () => {
  it('passes with the tick when the vise holds it off its zero, never without', () => {
    const off = { ...base, misplaced: 1, match: 0.97 } as CamSummary;
    expect(safe(off)).toBe(false);
    expect(passed(off)).toBe(false);
    expect(passed(off, true)).toBe(true);
  });
  it('never passes what hits the machine or the vise, tick or not', () => {
    for (const bad of [{ collisions: 1 }, { cales: 1 }]) expect(passed({ ...base, ...bad, misplaced: 1 } as CamSummary, true)).toBe(false);
  });
  it('passes as before without changes', () => {
    expect(passed(base)).toBe(true);
    expect(passed({ ...base, match: 0.97 } as CamSummary)).toBe(false);
  });
});
