import { describe, expect, it } from 'vitest';
import { parseToolpath } from '../src/lib/toolpath';
import { analyseProgram, analyseSetups, partSizes, readInstructions } from '../src/lib/setups';
import { carve, KEPT, buildInput } from '../src/lib/stockSim';

const S = { rapid: 30_000, toolChange: 2 };

// Two setups like the shop's programs: raw 54x44x30, finished 49x40x15, zero in the middle.
const program = (side: number) =>
  [
    '%',
    'O1061213 (KONTAKTTRAEGERPLATTE POM / 49X40X15 / ZUSCHNITT:54X44X30)',
    'M0 (TEIL MIT 54 IN X UND 44 IN Y EINSPANNEN)',
    'M0 (38 MM UNTERLAGE)',
    'G52 X-23. Y28. Z10.',
    'T1 M6 (MESSERKOPF D50 / MK_50)',
    '(DIAMETER 50.00 MM/LENGTH 40.00 MM)',
    'G0 G90 G54 X-60. Y0 S3000 M3',
    'G43 H1 Z5.',
    'G1 Z0 F800',
    'G1 X60.',
    'G0 Z50.',
    'T2 M6 (FRAESER D10)',
    '(DIAMETER 10.00 MM/LENGTH 30.00 MM)',
    'G0 G90 G54 X-30. Y0 S6000 M3',
    'G43 H2 Z5.',
    'G1 Z-10. F300',
    'G1 X30.',
    `G1 Y${side}.`,
    'G0 Z50.',
    'M0 (TEIL 180 GRAD UM Y DREHEN/49 IN X UND 40 IN Y)',
    'M0 (38 MM UNTERLAGE / Z+ IN 15MM)',
    'G52 X-25.5 Y30. Z-4.',
    'T1 M6 (MESSERKOPF D50 / MK_50)',
    'G0 G90 G54 X-60. Y0 S3000 M3',
    'G43 H1 Z18.',
    'G1 Z12. F800',
    'G1 X60.',
    'G0 Z50.',
    'M30',
    '%',
  ].join('\n');

describe('setups', () => {
  it('reads the header sizes', () => {
    expect(partSizes(['CONTOUR INSERT ALU / 24X26.5X10 / ZUSCHNITT:28X30X20'])).toEqual({ finished: [24, 26.5, 10], raw: [28, 30, 20], name: 'CONTOUR INSERT ALU' });
    expect(partSizes(['TOP PLATE FH / 50X50X40']).raw).toBeNull();
  });

  it('understands the operator instructions', () => {
    expect(readInstructions(['TEIL MIT 28 IN X UND 30 IN Y EINSPANNEN', '40 MM UNTERLAGE'])).toMatchObject({ sizes: { x: 28, y: 30 }, support: 40, clamp: 'vise', rotation: null });
    expect(readInstructions(['TEIL 180 GRAD UM Y DREHEN/', '41 MM UNTERLAGE IN EP 5 MM'])).toMatchObject({ rotation: { axis: 'Y', deg: 180 }, support: 41, restDepth: 5 });
    expect(readInstructions(['TEIL MIT/90 IN X /Z+ IN Y-/ 21.5 IN X UND 24.5 IN Y EINSPANNEN'])).toMatchObject({ rotation: { axis: 'X', deg: 90 }, topToward: 'Y-', sizes: { x: 21.5, y: 24.5 } });
    expect(readInstructions(['MOD. SPANNEN F. RUECKS./50 IN XY'])).toMatchObject({ clamp: 'module', side: 'back', sizes: { x: 50, y: 50 } });
    expect(readInstructions(['MOD. HOCHKANT/PERS. Y+/RAFI X- Z-', '8 MM UNTERLAGE'])).toMatchObject({ onEdge: true, marker: { name: 'RAFI', faces: ['X-', 'Z-'] }, support: 8 });
    expect(readInstructions(['MOD.SPANNEN F. FRONTSEITE /50 IN X /TASTER IN X+ Y-', '50 MM ZWISCHENLAGE IN X-'])).toMatchObject({ side: 'front', marker: { name: 'TASTER', faces: ['X+', 'Y-'] }, spacer: { mm: 50, side: 'X-' } });
  });

  it('places the part and the jaws in each setup', () => {
    const tp = parseToolpath(program(10), S);
    const [a, b] = analyseSetups(tp, { jawHeight: 42 });
    expect(tp.setups).toHaveLength(2);
    expect(a.stock).toEqual({ min: [-27, -22, -30], max: [27, 22, 0] });
    // The vise floor from the G52 shift: G54 Z-57 - Z10.
    expect(a.floorZ).toBe(-67);
    expect(a.jawTopZ).toBe(-25);
    expect(a.collisions).toEqual([]);
    // Second side: 30 high minus nothing faced, raw top 15 above Z0 as the program says.
    expect(b.rotation).toEqual({ axis: 'Y', deg: 180 });
    // What is left of the raw block is turned over; the vise holds the finished 49x40 side.
    expect(b.stock).toEqual({ min: [-27, -22, -15], max: [27, 22, 15] });
    expect(b.clampBox).toEqual({ min: [-24.5, -20], max: [24.5, 20] });
    expect(b.jawTopZ).toBe(-53 + 42);
  });

  it('finds a tool that goes into the jaws', () => {
    // The D10 cutter moves to Y30 at Z-10: outside the part (Y 22), 16 mm below the jaw top (Z-26)? No: above.
    // With a 60 mm jaw it is 8 mm below the top of the jaws.
    const tp = parseToolpath(program(30), S);
    expect(analyseSetups(tp, { jawHeight: 42 })[0].collisions).toEqual([]);
    const hits = analyseSetups(tp, { jawHeight: 60 })[0].collisions;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ tool: 2, depth: 3 });
    expect(hits[0].line).toBe(18);
  });

  it('does not check jaws on a modular fixture', () => {
    const tp = parseToolpath(program(30).replace('TEIL MIT 54 IN X UND 44 IN Y EINSPANNEN', 'MOD. SPANNEN F. RUECKS./54 IN X UND 44 IN Y'), S);
    const [a] = analyseSetups(tp, { jawHeight: 80 });
    expect(a.clamp).toBe('module');
    expect(a.jawTopZ).toBeNull();
    expect(a.collisions).toEqual([]);
  });

  it('turns a top plate by where its RAFI points and which side is up', () => {
    // The shop's top plate 100x50x30: back, front, then on edge three times (O0170834).
    const lines = ['%', 'O0834', '(TOP PLATE FH / 100X50X30)'];
    const setup = (notes: string[], g52: string, x: number, y: number) => {
      lines.push(...notes.map((n) => `M0 (${n})`), g52, 'T2 M6 (FRAESER D6)', '(DIAMETER 6.00 MM/LENGTH 30.00 MM)', `G0 G90 X${x} Y${y} S5000 M3`, 'G43 H2 Z5.', 'G1 Z-2. F300', `G1 X${x + 1}.`, 'G0 Z50.');
    };
    setup(['MOD. SPANNEN F. RUECKS./100 IN X/RAFI X+Y+', '38 MM UNTERLAGE'], 'G52 X-50. Y50. Z11.', 50, -25);
    setup(['MOD. SPANNEN F. FRONTSEITE/100 IN X/RAFI IN X+Y-', '30 MM UNTERLAGE'], 'G52 X-50. Y50. Z3.', 50, -25);
    setup(['MOD. HOCHKANT/PERS IN Y+/RAFI IN X+Z+'], 'G52 X-50. Y50. Z-7.', 50, -15);
    setup(['MOD. HOCHKANT/PERS. Y+/RAFI X- Z+'], 'G52 X-50. Y50. Z43.', 25, -15);
    setup(['MOD. HOCHKANT/PERS. Y+/RAFI X+ Z-'], 'G52 X-50. Y50. Z43.', 25, -15);
    lines.push('M30', '%');
    const { setups, part } = analyseProgram(parseToolpath(lines.join('\n'), S), { jawHeight: 42 });
    expect(part).toEqual({ min: [0, -50, -30], max: [100, 0, 0] });
    const size = (i: number) => setups[i].stock!.max.map((v, k) => v - setups[i].stock!.min[k]);
    expect(setups.map((x) => size(setups.indexOf(x)))).toEqual([[100, 50, 30], [100, 50, 30], [100, 30, 50], [50, 30, 100], [50, 30, 100]]);
    // Back -> front: turned around X. On edge: front face toward Y+.
    expect(setups[1].orient).toEqual([1, 0, 0, 0, -1, 0, 0, 0, -1]);
    for (const s of setups.slice(2)) expect(s.orient.slice(3, 6)).toEqual([0, 0, -1]);
    // Every setup stands on the same floor (G54 Z-57): bottom - support + G52 Z.
    const g52z = [11, 3, -7, 43, 43];
    setups.forEach((s, i) => expect(s.floorZ! + g52z[i]).toBeCloseTo(-57, 5));
  });

  it('reads where the part rests on the parallels (EP)', () => {
    expect(readInstructions(['38 MM UNTERLAGE SUR EP 8 MM']).restDepth).toBe(8);
    expect(readInstructions(['38 MM UNTERLAGE IN EPAISEUR 20']).restDepth).toBe(20);
    expect(readInstructions(['41 MM UNTERLAGE IN EP 4.5 MM']).restDepth).toBe(4.5);
    expect(readInstructions(['40 MM UNTERLAGE']).restDepth).toBeNull();
  });

  it('turns 180 around Y then 90 around Z when the instruction says X+ becomes Y+', () => {
    const r = readInstructions(['TEIL 180 GRAD UM Y DREHEN', 'TEIL 90 GRAD UM Z DREHEN/X+ WIRD Y+']);
    expect(r.turns).toEqual([{ axis: 'Y', deg: 180 }, { axis: 'Z', deg: 90 }]);
    expect(readInstructions(['TEIL MIT/90 IN X /Z+ IN Y-/ 21.5 IN X UND 24.5 IN Y EINSPANNEN']).turns).toEqual([{ axis: 'X', deg: 90 }]);
  });

  it('cuts the part away move by move', () => {
    const tp = parseToolpath(program(10), S);
    const an = analyseProgram(tp, { jawHeight: 42 });
    const g = carve({ ...buildInput(tp, an)!, maxVoxels: 200_000 });
    const kept = g.removed.reduce((n, r) => n + (r === KEPT ? 1 : 0), 0);
    // The facing passes and the slot take material away; most of the block stays.
    expect(kept).toBeLessThan(g.removed.length);
    expect(kept).toBeGreaterThan(g.removed.length * 0.5);
    // Nothing is cut by a rapid move.
    const rapids = new Set(tp.moves.flatMap((m, i) => (m.kind === 'rapid' ? [i] : [])));
    expect(Array.from(g.removed).some((r) => rapids.has(r))).toBe(false);
  });
});
