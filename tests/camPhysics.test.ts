import { describe, expect, it } from 'vitest';
import { cantilever, checkSetup, drillBuckling, drillThrust, millForce, toolDeflection, type SetupLoad } from '../src/lib/cam/physics';

// Every value below is worked out by hand from the formula in physics.ts.
describe('cutting and tool formulas', () => {
  it('milling force: kc·ap·ae·vf / (π·D·n)', () => {
    // 700·5·8·2000 / (π·8·12000) = 185.7 N
    expect(millForce(700, 5, 8, 2000, 12000, 8)).toBeCloseTo(185.7, 1);
  });
  it('tool bending: F·L³ / (3·E·I), core 0.8 Ø', () => {
    // I = π·8⁴/64 = 201.06; 100·40³ / (3·550000·201.06) = 0.0193 mm
    expect(toolDeflection(100, 40, 10)).toBeCloseTo(0.0193, 4);
  });
  it('drill thrust and the load it buckles under', () => {
    // 0.5·200·2·(200/8000) = 5 N
    expect(drillThrust(200, 2, 200, 8000)).toBeCloseTo(5, 6);
    // I = π·1.2⁴/64 = 0.1018; π²·210000·0.1018 / (0.7·50)² = 172.2 N
    expect(drillBuckling(50, 2)).toBeCloseTo(172.2, 0);
  });
  it('a part sticking out bends as a cantilever', () => {
    // I = 40·10³/12 = 3333.3; 300·65³ / (3·71000·3333.3) = 0.116 mm
    expect(cantilever(300, 65, 40, 10, 71000)).toBeCloseTo(0.116, 3);
  });
});

describe('the vise and the part', () => {
  const base: SetupLoad = { material: 'ALU', length: 100, width: 40, height: 20, grip: 3, thin: 20, contact: { jaws: 100, rest: [100, 100], stop: true }, loads: [{ side: 400, down: 200, reach: 100 }] };

  it('holds an aluminium block: slipping sets the least force, the vise the most', () => {
    const c = checkSetup(base);
    // Slip 1.5·400/(2·0.3) = 1000 N; tip 1.5·400·20 / min(1.5 + 0.3·40, 0.3·100/2) = 889 N.
    // Crush 125·(100·3)/1.2 = 31250 N, over the vise's 30000.
    expect(c.clamp).toEqual({ min: 1000, max: 30000, use: 1300 });
    expect(c).toMatchObject({ ok: true, feed: 1, issues: [], force: { side: 400, down: 200 } });
  });

  it('a deeper grip carries more force before the jaws crush the part', () => {
    const short = { ...base, length: 40, height: 10, thin: 10, contact: { jaws: 40, rest: [40, 40] as [number, number], stop: true }, loads: [{ side: 6000, down: 0, reach: 40 }] };
    // Slip 1.5·6000/0.6 = 15000 N; tip 1.5·6000·10 / min(1.5 + 12, 0.3·40/2) = 15000 N. Most
    // 125·(40·3)/1.2 = 12500 N: slowed to 0.83.
    expect(checkSetup(short)).toMatchObject({ ok: true, feed: 0.83, issues: [{ key: 'slowed', share: 0.83 }] });
    // Gripped 6 mm: most 25000 N.
    expect(checkSetup({ ...short, grip: 6 })).toMatchObject({ ok: true, feed: 1, issues: [] });
  });

  it('POM is squeezed out of size long before it is crushed', () => {
    // A precise part may be squeezed 0.02 mm: most 0.02·2800·(100·20)/40 = 2800 N. Side 400 needs
    // 1.5·400/(2·0.2) = 1500 N: held.
    expect(checkSetup({ ...base, material: 'POM', squeeze: 0.02 })).toMatchObject({ ok: true, feed: 1 });
    // Side 1000 needs 3750 N: 0.75 of the feed on a precise part; on another (0.05 mm: 7000 N,
    // crushing 20·300/1.2 = 5000 N) held.
    expect(checkSetup({ ...base, material: 'POM', squeeze: 0.02, loads: [{ side: 1000, down: 0, reach: 100 }] })).toMatchObject({ ok: true, feed: 0.75 });
    expect(checkSetup({ ...base, material: 'POM', loads: [{ side: 1000, down: 0, reach: 100 }] })).toMatchObject({ ok: true, feed: 1 });
    // Side 3000 needs 11250 N on a part that may take 2800: refused.
    const hard = checkSetup({ ...base, material: 'POM', squeeze: 0.02, loads: [{ side: 3000, down: 0, reach: 100 }] });
    expect(hard.ok).toBe(false);
    expect(hard.issues).toContainEqual({ key: 'cannotHold', need: 11250, most: 2800 });
  });

  it('3-2-1: on both parallels, against the jaws over a length, against the stop', () => {
    const c = checkSetup({ ...base, contact: { jaws: 10, rest: [0, 50], stop: false } });
    // 10 mm of jaw also tips easily (arm 0.3·10/2 = 1.5): 8000 N needed, 3125 N crushes: slowed.
    expect(c.issues.map((i) => i.key).sort()).toEqual(['jawContact', 'restContact', 'slowed', 'stopContact']);
    expect(c.ok).toBe(false);
  });

  it('a thin part past the parallels bends under a drill: refused', () => {
    const c = checkSetup({ ...base, length: 190, thin: 10, height: 10, loads: [{ side: 0, down: 300, reach: 190 }] });
    expect(c.issues).toContainEqual({ key: 'overhang', mm: 65 });
    expect(c.ok).toBe(false);
  });
});
