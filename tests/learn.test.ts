import { describe, expect, it } from 'vitest';
import plate from './models/O1042013.C60.txt?raw';
import { readProgram, summarise } from '../src/lib/cam/learn';
import knowledge from '../src/lib/cam/shopKnowledge.json';

describe('learning from a program (O1042013, FH top plate)', () => {
  const p = readProgram(plate, 'O1042013');
  it('reads the part, its setups and each operation with its cutting data', () => {
    expect(p.material).toBe('FH');
    expect(p.size).toEqual([100, 50, 40]);
    expect(p.setups).toBe(6);
    const profile = p.samples.find((x) => x.op === 'PROFIL_20MM')!;
    expect(profile).toMatchObject({ type: 'SF', d: 20, length: 55, kind: 'contour', s: 2200, f: 650, fz: 585 });
    expect(profile.ap).toBeCloseTo(3.8, 1);
    const face = p.samples.find((x) => x.type === 'MK')!;
    expect(face).toMatchObject({ kind: 'face', d: 93, s: 4500 });
  });
  it('summarises programs into cutting data and an order of operations', () => {
    const k = summarise([p]);
    expect(k.cut.FH.SF.some((r) => r.d === 20 && r.kind === 'contour' && r.s === 2200)).toBe(true);
    expect(k.order[0]).toBe('face');
  });
  it('ships what was learned from the uploaded programs', () => {
    expect(knowledge.programs).toBeGreaterThanOrEqual(30);
    expect(Object.keys(knowledge.cut).sort()).toEqual(expect.arrayContaining(['ALU', 'FH', 'POM']));
  });
});
