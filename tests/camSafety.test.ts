import { describe, expect, it } from 'vitest';
import { camProgram, checkProgram, commentSafe, finerRapids } from '../src/lib/cam/program';
import type { Tool } from '../src/types';
import { heightPart, plateWithHoles, pocketWithHole } from './heightPart';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';

// A 40x30x12 plate with a 20x12 pocket 6 deep in its top.
const plate = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 6 : 12))));

describe('the safety double check', () => {
  const r = camProgram({ tris: plate, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 16], orient: { side: 'Z+', spin: false } });
  const lines = r.code.split('\n');

  it("CAM AI's own program: no holder in the material, no rapid through it", () => {
    expect(r.check).toMatchObject({ holders: 0, rapids: 0, collisions: 0 });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  });

  it('catches a rapid planted through the stock', () => {
    // Straight across the plate 3 mm down, at rapid, before the first end mill starts cutting.
    const at = lines.findIndex((l) => /TOOLPATH FRAESEN/.test(l));
    const start = lines.findIndex((l, i) => i > at && /G00 G90 X/.test(l));
    const planted = [...lines.slice(0, start + 1), 'N9 G00 Z-3.', 'N9 G00 X60.', ...lines.slice(start + 1)].join('\n');
    const check = checkProgram(plate, planted, 'HAAS', undefined, r.pose);
    expect(check.rapids).toBeGreaterThan(0);
    // Straight down into the solid stock and across it: never taken for a graze (never run at feed).
    expect(check.grazes).toEqual([]);
  }, 300_000);

  it("catches a drilling cycle whose R plane is inside the stock (its rapid down to R goes through it)", () => {
    // Right after the first end mill is loaded, before it has cut anything: a hole in the middle of
    // the pocket, its R plane 2 mm under the top that is still there. Not a graze: G01 cannot fix it.
    const at = lines.findIndex((l) => /TOOLPATH FRAESEN/.test(l));
    const start = lines.findIndex((l, i) => i > at && /G00 G90 X/.test(l));
    const planted = [...lines.slice(0, start + 1), 'N9 G00 Z5.', 'N9 G98 G81 X0. Y0. Z-4. R-2. F100.', 'N9 G80', ...lines.slice(start + 1)].join('\n');
    const check = checkProgram(plate, planted, 'HAAS', undefined, r.pose);
    expect(check.rapids).toBeGreaterThan(0);
    expect(check.grazes).toEqual([]);
  }, 300_000);

  it('catches a holder planted in the part (a tool typed too short for its depth)', () => {
    // The first end mill typed 2 mm long: its holder goes down into the pocket's walls.
    const at = lines.findIndex((l) => /TOOLPATH FRAESEN/.test(l));
    const len = lines.findIndex((l, i) => i > at && /LENGTH [\d.]+ MM/.test(l));
    const planted = lines.map((l, i) => (i === len ? l.replace(/LENGTH [\d.]+ MM/, 'LENGTH 2.00 MM') : l)).join('\n');
    const c = checkProgram(plate, planted, 'HAAS', undefined, r.pose);
    expect(c.holders).toBeGreaterThan(0);
    expect(c.collisions).toBeGreaterThan(0);
  }, 300_000);
});

describe('a machine tool without a length (safety)', () => {
  it('is never sent down into the part: its holder could not be checked', () => {
    // A 40x30x12 plate with a slot 7.5 wide, 20 long, 6 deep: the machine's Ø7 mill (no length typed in the
    // inventory) is the largest that fits it. Taken as 99 mm long, it went in with "LENGTH 0.00 MM", its holder unchecked.
    const slot = pocketWithHole(40, 30, 12, [10, 11.25, 30, 18.75], 6, { c: [20, 15], d: 2 });
    const tools: Tool[] = [{ id: 'm7', number: 7, category: 'fraise', description: 'Fraise', diameter: 7, length: 0 }];
    const r = camProgram({ tris: slot, material: 'ALU', tools, brand: 'HAAS', raw: [44, 34, 16], orient: { side: 'Z+', spin: false } });
    expect(r.code).not.toMatch(/DIAMETER 7\.00 MM/);
    expect(r.check).toMatchObject({ holders: 0, collisions: 0 });
  }, 300_000);
});

describe('drilling before the pocket above the hole is milled (shop order)', () => {
  // A 40x30x12 plate, a 20x14 pocket 6 deep, a Ø4 hole through the pocket's floor.
  const part = pocketWithHole(40, 30, 12, [10, 8, 30, 22], 6, { c: [20, 15], d: 4 });
  const tool = (number: number, category: Tool['category'], diameter: number, length: number): Tool => ({ id: `t${number}`, number, category, description: '', diameter, length });
  const tools = [tool(1, 'tourteau', 40, 30), tool(2, 'fraise', 10, 40), tool(3, 'fraise', 4, 25), tool(4, 'foret', 4, 50)];
  const r = camProgram({ tris: part, material: 'ALU', tools, brand: 'HAAS', raw: [44, 34, 16], orient: { side: 'Z+', spin: false } });

  it('starts every cycle above the material still over the hole (the shop: R2 above the faced top)', () => {
    const lines = r.code.split('\n');
    const g52 = lines.flatMap((l, i) => (/G52 /.test(l) ? [i] : []));
    const cycles = lines.slice(g52[0], g52[1] ?? lines.length).filter((l) => /G8[13] /.test(l));
    expect(cycles.length).toBeGreaterThan(0);
    // The hole drilled before the pocket: the pocket's material is still over it, up to Z0.
    for (const l of cycles) expect(Number(l.match(/R(-?[\d.]+)/)![1])).toBeGreaterThanOrEqual(2);
    expect(r.check).toMatchObject({ rapids: 0, collisions: 0 });
  }, 300_000);
});

describe('no tool into a parallel (shop rule for CAM AI)', () => {
  it('a narrow plate with a hole milled through over the front parallel: the cut stops on it', () => {
    // 40 x 9 x 5.5, a Ø4.5 hole through it near the front edge: the parallels under the front and
    // back edges, the hole's milling over the front one (46 hits if it went 0.2 below the part).
    const holed = plateWithHoles(40, 9, 5.5, [{ c: [20, 2.6], d: 4.5 }]);
    const r = camProgram({ tris: holed, material: 'POM', tools: [], brand: 'HAAS', raw: [40, 9, 5.5], orient: { side: 'Z+', spin: false } });
    expect(r.check).toMatchObject({ cales: 0, collisions: 0, holders: 0, rapids: 0 });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 900_000);
});

describe('text from outside in the program', () => {
  it("a ')' in the model's file name cannot end the comment and add commands", () => {
    const name = '100201637205 TOP PLATE)#5223=#5223-30(';
    expect(commentSafe(name)).toBe('100201637205 TOP PLATE 5223 5223-30');
    const r = camProgram({ tris: plate, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 16], orient: { side: 'Z+', spin: false }, name });
    const header = r.code.split('\n').find((l) => l.includes('TOP PLATE'))!;
    // One comment, nothing outside it.
    expect(header).toMatch(/^(N\d+ )?\([^()]*\)$/);
    expect(r.code).not.toContain('#5223');
    // A whole program is made: more than the default 5 s on a busy machine.
  }, 180_000);

  it('keeps an ordinary name, upper case', () => {
    expect(commentSafe('o2504411 top-plate_v2.1')).toBe('O2504411 TOP-PLATE_V2.1');
    expect(commentSafe('  ')).toBe('TEIL');
  });
});

describe('spot drilling as the shop does it', () => {
  it('spots the holes under 4 mm only (docs/knowledge: strategy.spotSmallDrills)', () => {
    // A Ø3.3 and a Ø5 hole through a 40 x 30 x 8 plate.
    const holed = plateWithHoles(40, 30, 8, [{ c: [10, 15], d: 3.3 }, { c: [30, 15], d: 5 }]);
    const r = camProgram({ tris: holed, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 12], orient: { side: 'Z+', spin: false } });
    const tp = parseToolpath(r.code, speedsFor('HAAS'));
    const holesBy = (re: RegExp) => tp.moves.filter((m) => m.kind === 'drill' && re.test(m.op ?? '')).map((m) => Math.round(m.points[0][0]));
    expect(holesBy(/^BOHREN/).sort((a, b) => a - b)).toEqual([-10, 10]);
    expect(holesBy(/^ZENTRIER/)).toEqual([-10]);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 600_000);
});


describe('rapids the check is too coarse to see', () => {
  it('feeds a rapid down through stock the last part of the way, from 1 mm above the highest it touches on a finer grid', () => {
    const r = camProgram({ tris: plate, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 16], noNest: true, orient: { side: 'Z+', spin: false } });
    expect(finerRapids(r.code, 'HAAS')).toBe(r.code);
    // After the facing, a rapid down 1 mm into the outside stock (cut only later), beside the part's X- face.
    const lines = r.code.split('\n');
    const at = lines.findIndex((l, i) => i > lines.findIndex((x) => /TOOLPATH FRAESEN/.test(x)) && /^N\d+ G00 Z/.test(l));
    const bad = [...lines.slice(0, at + 1), 'N0 G00 X-21. Y0.', 'N0 G00 Z-1.', 'N0 G00 Z2.', ...lines.slice(at + 1)].join('\n');
    const fixed = finerRapids(bad, 'HAAS').split('\n');
    const k = fixed.findIndex((l) => / G00 X-21\. Y0\.$/.test(l));
    // The stock's top is Z0 (faced): the rapid stops 1 mm over it, plus up to a cell of the finer grid.
    const stop = Number(fixed[k + 1].match(/ G00 Z(-?[\d.]+)$/)?.[1]);
    expect(stop).toBeGreaterThanOrEqual(1);
    expect(stop).toBeLessThanOrEqual(1.3);
    expect(fixed[k + 2]).toMatch(/ G01 Z-1\. F\d+\.?$/);
    // The rest at the feed in force, when the moves after it go on without one (a review finding: it took the
    // next F written further on, 1680, and the moves after it ran at that instead of 840).
    const modal = [...lines.slice(0, at + 1), 'N0 G00 X-21. Y0.', 'N0 G01 X-21. Y.5 F840.', 'N0 G00 Z-1.', 'N0 G01 Z-1.5', 'N0 G01 X-21.1 Y0.', 'N0 G01 X-21. Y1. F1680.', 'N0 G00 Z2.', ...lines.slice(at + 1)].join('\n');
    const out = finerRapids(modal, 'HAAS').split('\n');
    const j = out.findIndex((l) => / G01 X-21\. Y\.5 F840\.$/.test(l));
    expect(out[j + 1]).toMatch(/ G00 Z/);
    expect(out[j + 2]).toMatch(/ G01 Z-1\. F840\.$/);
    expect(out[j + 3]).toMatch(/ G01 Z-1\.5$/);
  }, 300_000);

  it('on the check’s own grid feeds only a rapid that grazes stock with its rim; one deeper in stays a collision', () => {
    const r = camProgram({ tris: plate, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 16], noNest: true, orient: { side: 'Z+', spin: false } });
    const lines = r.code.split('\n');
    const at = lines.findIndex((l, i) => i > lines.findIndex((x) => /TOOLPATH FRAESEN/.test(x)) && /^N\d+ G00 Z/.test(l));
    const r0 = r.setups[0].ops.find((o) => o.name.startsWith('FRAESEN'))!.tool.diameter / 2;
    const down = (x: number) => [...lines.slice(0, at + 1), `N0 G00 X${(Math.round(x * 1000) / 1000).toFixed(3)} Y0.`, 'N0 G00 Z-1.', 'N0 G00 Z2.', ...lines.slice(at + 1)].join('\n');
    // Its rim 0.3 mm into the outside stock (the raw block's face at X-22): rewritten.
    const rim = finerRapids(down(-22 - r0 + 0.3), 'HAAS', undefined, 2_000_000, true);
    expect(rim).toMatch(/G01 Z-1\. F/);
    // Its axis over the stock: left a rapid (the check locks it), unless asked to feed any.
    const deep = down(-21);
    expect(finerRapids(deep, 'HAAS', undefined, 2_000_000, true)).toBe(deep);
    expect(finerRapids(deep, 'HAAS')).toMatch(/G01 Z-1\. F/);
  }, 300_000);
});
