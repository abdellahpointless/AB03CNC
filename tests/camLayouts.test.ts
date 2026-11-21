import { describe, expect, it } from 'vitest';
import { layouts, toModelAxes } from '../src/lib/cam/layouts';
import { camProgram, checkProgram } from '../src/lib/cam/program';
import { analyseProgram, DEFAULT_JAW_HEIGHT } from '../src/lib/setups';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';
import type { Tool } from '../src/types';
import { heightPart } from './heightPart';

// A 40x30x12 plate with a 20x12 pocket 6 deep in its top; a 300x60x20 bar.
const plate = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 6 : 12))));
const bar = heightPart(Array.from({ length: 60 }, () => Array.from({ length: 300 }, () => 20)));

describe('how the part lies in the vise', () => {
  it('lists all 12 ways, best first: the pocket side up, low and flat', () => {
    const all = layouts(plate);
    expect(all).toHaveLength(12);
    expect(all[0]).toMatchObject({ side: 'Z+', fits: true, twoVises: false });
    expect(all[0].size[2]).toBeCloseTo(12, 5);
    expect(all[0].topShare).toBeGreaterThan(all.find((l) => l.side === 'Z-')!.topShare);
  });

  it('turns a long bar so one vise holds it (300 between the jaws, 60 along them)', () => {
    const best = layouts(bar)[0];
    expect(best.twoVises).toBe(false);
    expect(best.size.map((v) => Math.round(v))).toEqual([60, 300, 20]);
  });

  it('excess given along the vise goes back on the model axes', () => {
    const turned = layouts(plate).find((l) => l.side === 'Z+' && l.spin)!;
    // Turned a quarter: the vise X is the model Y.
    expect(toModelAxes(turned.R, [1, 2, 3])).toEqual([2, 1, 3]);
  });

  it('the planner follows the chosen layout', () => {
    const tools: Tool[] = [{ id: 'f', number: 1, category: 'tourteau', description: '', diameter: 40, length: 30 }];
    const r = camProgram({ tris: plate, material: 'ALU', tools, brand: 'HAAS', raw: [44, 34, 16], orient: { side: 'Z+', spin: true } });
    // Turned: the 34 side lies along the jaws (X), the 44 between them (Y).
    expect(r.code).toMatch(/M0 \(TEIL MIT 34 IN X UND 44 IN Y EINSPANNEN/);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 180_000);
});

describe('where a clamping puts the part', () => {
  it('puts the faces the vise holds at the stop and the fixed jaw, and writes their size, in every clamping (gap P1)', () => {
    // After the first clamping has cut the outside, the jaws hold the finished faces, not the raw stock above them.
    const r = camProgram({ tris: plate, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 16], noNest: true, orient: { side: 'Z+', spin: false } });
    const an = analyseProgram(parseToolpath(r.code, speedsFor('HAAS')), { jawHeight: DEFAULT_JAW_HEIGHT });
    expect(an.setups.length).toBeGreaterThanOrEqual(2);
    an.setups.forEach((s, k) => {
      expect(s.grip && s.clampBox, `clamping ${k + 1}`).toBeTruthy();
      // The app's reader finds the held faces where the program puts the part (its grid: 0.3 mm).
      expect(Math.abs(s.grip!.stop - s.clampBox!.min[0]), `clamping ${k + 1} at the stop`).toBeLessThanOrEqual(0.3);
      expect(Math.abs(s.clampBox!.max[1] - s.grip!.back), `clamping ${k + 1} at the fixed jaw`).toBeLessThanOrEqual(0.3);
    });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.misplaced).toBe(0);
    // The second clamping written with the whole stock's size (44 x 34), as CAM AI wrote it before: the
    // vise holds 40 x 30 there, the part would sit 2 mm off; the check counts it, and that locks the program.
    const wrong = r.code.replace(/(DREHEN\/)(\d+(?:\.\d+)?) IN X UND (\d+(?:\.\d+)?) IN Y/, (_m, pre: string, x: string, y: string) => `${pre}${Number(x) + 4} IN X UND ${Number(y) + 4} IN Y`);
    expect(wrong).not.toBe(r.code);
    expect(checkProgram(plate, wrong, 'HAAS', undefined, r.pose).misplaced).toBeGreaterThan(0);
  }, 300_000);

  it('places a part held by a band off its middle where the program puts it (P1: the boss the jaws grip after the turn)', () => {
    // A 30 x 30 x 8 plate with a 12 x 24 boss 6 high off the middle in X: turned over, the jaws hold the boss only.
    const boss = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 30 }, (_, i) => (i >= 4 && i < 16 && j >= 3 && j < 27 ? 14 : 8))));
    const r = camProgram({ tris: boss, material: 'ALU', tools: [], brand: 'HAAS', raw: [34, 34, 18], noNest: true, orient: { side: 'Z+', spin: false } });
    const an = analyseProgram(parseToolpath(r.code, speedsFor('HAAS')), { jawHeight: DEFAULT_JAW_HEIGHT });
    expect(an.setups.length).toBeGreaterThanOrEqual(2);
    // The held band really is off the stock's middle (else this tests nothing).
    expect(r.setups.some((s) => Math.abs(s.held[0] + s.held[2] - s.box[0] - s.box[2]) / 2 > 2)).toBe(true);
    an.setups.forEach((s, k) => {
      expect(s.grip && s.clampBox, `clamping ${k + 1}`).toBeTruthy();
      expect(Math.abs(s.grip!.stop - s.clampBox!.min[0]), `clamping ${k + 1} at the stop`).toBeLessThanOrEqual(0.3);
      expect(Math.abs(s.clampBox!.max[1] - s.grip!.back), `clamping ${k + 1} at the fixed jaw`).toBeLessThanOrEqual(0.3);
    });
    expect(r.check.misplaced).toBe(0);
    expect(r.check.collisions).toBe(0);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 300_000);
});

describe('turning the part over', () => {
  it('reaches a later clamping with one turn where one will do (a review found two after the turn about X)', () => {
    // A 40 x 30 x 12 block with an off-centre pocket and a step on its top, laid X+ up first.
    const tris = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 4 && i < 16 && j >= 5 && j < 14 ? 6 : i >= 30 && i < 38 && j >= 20 && j < 28 ? 9 : 12))));
    const r = camProgram({ tris, material: 'ALU', tools: [], brand: 'HAAS', noNest: true, orient: { side: 'X+', spin: false } });
    expect(r.setups.length).toBeGreaterThanOrEqual(3);
    expect(r.setups[1].notes[0]).toMatch(/^TEIL 180 GRAD UM X DREHEN\//);
    for (const s of r.setups.slice(2)) expect((s.notes[0].match(/DREHEN/g) ?? []).length, s.notes[0]).toBe(1);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 300_000);

  it('turns it about X, as the shop mostly does (docs/knowledge: second clamping X180 in 63 of 100, Y180 in 31), laid along X or across', () => {
    for (const spin of [false, true]) {
      const r = camProgram({ tris: plate, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 16], noNest: true, orient: { side: 'Z+', spin } });
      expect(r.setups[1].notes[0], `spin ${spin}`).toMatch(/^TEIL 180 GRAD UM X DREHEN\//);
      expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    }
  }, 600_000);
});

