import { describe, expect, it } from 'vitest';
import { liveStep, NO_LIVE, type Live } from '../src/lib/cam/live';
import type { LiveEvent } from '../src/lib/cam/program';

// The CAM AI page's progress while the planner works: it only moves forward, also when the planner starts over.
const pass = (key: string): LiveEvent[] => [
  { kind: 'reset' },
  { kind: 'stage', stage: 'features' },
  { kind: 'stage', stage: 'stock' },
  { kind: 'stage', stage: 'setup', setup: 0, of: 2, side: 'Z+' },
  { kind: 'path', setup: 0, purpose: 'rough', pts: [0, 0, 0, 1, 1, 1], key, tool: 'SF 8' },
  { kind: 'stage', stage: 'setup', setup: 1, of: 2, side: 'Z-' },
  { kind: 'stage', stage: 'check' },
  { kind: 'stage', stage: 'post' },
];

describe('CAM AI progress', () => {
  it('never goes back over two passes, stays under 100 and ends with the last pass', () => {
    let l: Live = NO_LIVE;
    const seen: Live[] = [];
    for (const e of [...pass('a'), ...pass('b')]) seen.push((l = liveStep(l, e)));
    seen.forEach((x, i) => {
      if (i) expect(x.pct).toBeGreaterThanOrEqual(seen[i - 1].pct);
      expect(x.pct).toBeLessThan(100);
      // What is shown never loses a step once it is done.
      if (i) expect(x.stages.length).toBeGreaterThanOrEqual(seen[i - 1].stages.length);
    });
    expect(l.paths.map((p) => p.key)).toEqual(['b']);
    expect(l.stages).toContain('post');
    expect(l.next).toBeNull();
    expect(l.pct).toBeGreaterThan(seen[7].pct);
  });

  it('keeps a finished pass on screen when the planner starts over twice before the next one gets going', () => {
    let l: Live = NO_LIVE;
    for (const e of [...pass('a'), { kind: 'reset' } as LiveEvent, ...pass('c')]) l = liveStep(l, e);
    expect(l.paths.map((p) => p.key)).toEqual(['c']);
    let m: Live = NO_LIVE;
    for (const e of [...pass('a'), { kind: 'reset' } as LiveEvent, { kind: 'reset' } as LiveEvent]) m = liveStep(m, e);
    expect(m.paths.map((p) => p.key)).toEqual(['a']);
    expect(m.stages).toContain('post');
  });

  it('keeps the first pass on screen while the second one runs', () => {
    let l: Live = NO_LIVE;
    for (const e of [...pass('a'), ...pass('b').slice(0, 5)]) l = liveStep(l, e);
    expect(l.paths.map((p) => p.key)).toEqual(['a']);
    expect(l.stages).toContain('post');
  });

  // Finding H1-34: after a turn by hand the planner tried the blank centred (dropped at its first setup), then two POM
  // nests and their programs, minutes at "100 %" with the dropped try shown as "Setup 1 · 0 operations · Working".
  it('never shows a try dropped after it began, keeps the finished pass on screen', () => {
    const dropped: LiveEvent[] = [{ kind: 'reset' }, { kind: 'stage', stage: 'features' }, { kind: 'stage', stage: 'stock' }, { kind: 'stage', stage: 'setup', setup: 0, of: 4, side: 'Y+' }, { kind: 'stage', stage: 'post' }];
    let l: Live = NO_LIVE;
    for (const e of [...pass('a'), ...dropped]) l = liveStep(l, e);
    expect(l.paths.map((p) => p.key)).toEqual(['a']);
    expect(l.stages).toContain('check');
    expect(l.next).toBeNull();
  });

  it('stays under 100 over many tries and counts them', () => {
    let l: Live = NO_LIVE;
    for (let k = 0; k < 6; k++) for (const e of pass(String(k))) {
      l = liveStep(l, e);
      expect(l.pct).toBeLessThan(100);
    }
    expect(l.tries).toBe(6);
  });
});
