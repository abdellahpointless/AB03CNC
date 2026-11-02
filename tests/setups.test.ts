import { describe, expect, it } from 'vitest';
import { parseToolpath } from '../src/lib/toolpath';
import { analyseProgram, analyseSetups, partSizes, readInstructions, spacerAt } from '../src/lib/setups';
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

  it('checks the jaws of the modular clamp like a vise, but not a part held in a fixture', () => {
    const mod = parseToolpath(program(30).replace('TEIL MIT 54 IN X UND 44 IN Y EINSPANNEN', 'MOD. SPANNEN F. RUECKS./54 IN X UND 44 IN Y'), S);
    const [a] = analyseSetups(mod, { jawHeight: 42 });
    expect(a.clamp).toBe('module');
    expect(a.jawTopZ).toBe(a.floorZ! + 42);
    const fix = parseToolpath(program(30).replace('TEIL MIT 54 IN X UND 44 IN Y EINSPANNEN', 'MOD. IN ALUVORRICHTUNG SPANNEN'), S);
    const [b] = analyseSetups(fix, { jawHeight: 80 });
    expect(b.clamp).toBe('fixture');
    expect(b.jawTopZ).toBeNull();
    expect(b.collisions).toEqual([]);
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
  it('reads the other ways the shop writes sizes and supports', () => {
    // Raw block after "//" instead of ZUSCHNITT (O0164578); a lone size after "//" is the finished part (O0169538).
    expect(partSizes(['TOP PLATE POM / 100X50X30 // 104X54X40'])).toMatchObject({ finished: [100, 50, 30], raw: [104, 54, 40] });
    expect(partSizes([' INSERT (TOP PLATE FH // 150X100X30 ) '])).toMatchObject({ finished: [150, 100, 30], raw: null });
    expect(readInstructions(['TEIL MIT 104 UM X UND 54 UM Y EINSPANNEN']).sizes).toEqual({ x: 104, y: 54 });
    expect(readInstructions(['36 MM UNTERLAGE IN 21MM'])).toMatchObject({ support: 36, restDepth: 21 });
    expect(readInstructions(['15 MM ZWISCHENLAGE IN Y-']).spacer).toEqual({ mm: 15, side: 'Y-' });
  });

  it('turns the part over when a later clamping first says it is the back side (O0162220)', () => {
    // First side: raw 154x104x60 faced in layers; the outline cut 20 deep. Then "RUECKS." with no
    // turn written: the first side was the front, so the part lies upside down now.
    const face = (zs: number[]) => zs.flatMap((z) => ['G0 X206.5 Y-17.833', `G1 Z${z} F600`, 'G1 X-56.5', 'G0 Z10.', 'G0 X206.5 Y-82.167', `G1 Z${z}`, 'G1 X-56.5', 'G0 Z10.']);
    const code = [
      '%', 'O0220', '(TOP PLATE POM / 150X100X50 / ZUSCHNITT:154X104X60)',
      'M0 (TEIL MIT 154 IN X UND 104 IN Y EINSPANNEN)', 'M0 (40 MM UNTERLAGE)', 'G52 X-48. Y48. Z40.',
      'T3 M6 (MESSERKOPF D93 / MK_93.00_030_000_KS)', '(DIAMETER 93.00 MM/LENGTH 30.00 MM)', 'G0 G90 X206.5 Y-17.833 S2500 M3', 'G43 H3 Z10.',
      ...face([3.333, 1.667, 0]),
      'T20 M6 (20MM FRAESER / SF_20.00_065_000_KS)', '(DIAMETER 20.00 MM/LENGTH 65.00 MM)', 'G0 X-10. Y10.', 'G43 H20 Z5.', 'G1 Z-20. F500', 'G1 X160.', 'G1 Y-110.', 'G1 X-10.', 'G1 Y10.', 'G0 Z50.',
      'T3 M6 (MESSERKOPF D93 / MK_93.00_030_000_KS)', '(DIAMETER 93.00 MM/LENGTH 30.00 MM)',
      'M0 (MOD. SPANNEN F. RUECKS. / 150 IN X / RAFI X+ Y- )', 'M0 (15 MM UNTERLAGE)', 'G52 X-50. Y50. Z8.', 'G0 G90 X206.5 Y-17.833 S2500 M3', 'G43 H3 Z10.',
      ...face([3.5, 0]),
      'M30', '%',
    ].join('\n');
    const { setups } = analyseProgram(parseToolpath(code, S), { jawHeight: 45 });
    expect(setups[1].orient).toEqual([1, 0, 0, 0, -1, 0, 0, 0, -1]);
    // The faced top (Z0) is now underneath; 7 mm of raw stock is left above Z0 to face off.
    expect(setups[1].stock!.max[2]).toBeCloseTo(7, 1);
    expect(setups[1].stock!.min[2]).toBeCloseTo(-50, 1);
    expect(setups[1].floorZ! + 8).toBeCloseTo(-57, 5);
  });

  it('moves the jaw out by a spacer: a cut just past the part touches the spacer, not the jaw', () => {
    const toFront = program(-30);
    expect(analyseSetups(parseToolpath(toFront, S), { jawHeight: 60 })[0].collisions).toHaveLength(1);
    const spaced = analyseSetups(parseToolpath(toFront.replace('M0 (38 MM UNTERLAGE)', 'M0 (38 MM UNTERLAGE)\nM0 (15 MM ZWISCHENLAGE IN Y-)'), S), { jawHeight: 60 })[0];
    expect(spacerAt(spaced, 'Y-')).toBe(15);
    expect(spaced.collisions).toEqual([]);
    // A thin spacer is not enough: the D10 reaches 13 mm past the part.
    const thin = analyseSetups(parseToolpath(toFront.replace('M0 (38 MM UNTERLAGE)', 'M0 (38 MM UNTERLAGE)\nM0 (5 MM ZWISCHENLAGE IN Y-)'), S), { jawHeight: 60 })[0];
    expect(thin.collisions).toHaveLength(1);
  });
});
