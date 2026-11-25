import { describe, expect, it } from 'vitest';
import { parseToolpath } from '../src/lib/toolpath';
import { partLook } from '../src/lib/partLook';
import { analyseProgram, analyseSetups, caleSlide, exportBlocked, jawsFrom, overJaws, partSizes, readInstructions, spacerAt, viseSpans, type Collision } from '../src/lib/setups';
import { carve, KEPT, buildInput } from '../src/lib/stockSim';
import { rewriteTurns } from '../src/lib/fixTurns';

const S = { rapid: 30_000, toolChange: 2 };
const programLines = (_tp: unknown, line: number) => program(10).replace('M0 (38 MM UNTERLAGE / Z+ IN 15MM)', 'M0 (CALCO 39 MM NA BASE DE 5 MM)').split('\n')[line];

// Two setups like the shop's programs: raw 54x44x30, finished 49x40x15, zero in the middle.
const program = (side: number) =>
  [
    '%',
    'O1999213 (KONTAKTTRAEGERPLATTE POM / 49X40X15 / ZUSCHNITT:54X44X30)',
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
    expect(readInstructions(['MOD.SPANNEN F. FRONTSEITE /50 IN X /TASTER IN X+ Y-', '50 MM ZWISCHENLAGE IN X-'])).toMatchObject({ side: 'front', marker: { name: 'TASTER', faces: ['X+', 'Y-'] }, spacers: [{ mm: 50, side: 'X-' }] });
  });

  it("CAM AI's POM nest is held in the vise, its wall on every jaw side", () => {
    const n = readInstructions(['TEIL IN POM-NEST LEGEN', '38 MM UNTERLAGE']);
    expect(n.clamp).toBe('vise');
    expect(n.spacers.map((x) => x.side).sort()).toEqual(['X-', 'Y+', 'Y-']);
    expect(readInstructions(['TEIL IN VORRICHT SPANNEN']).clamp).toBe('fixture');
  });

  it('a setup without its own M0 is still held in the vise (never drawn without jaws)', () => {
    const code = program(10).split('\n').filter((l) => !/^M0 \((TEIL 180|38 MM UNTERLAGE \/ Z\+)/.test(l)).join('\n');
    const tp = parseToolpath(code, S);
    expect(tp.setups).toHaveLength(2);
    expect(tp.setups[1].notes).toEqual([]);
    const [, b] = analyseSetups(tp, { jawHeight: 42 });
    expect(b.clamp).toBe('vise');
    expect(b.stock).not.toBeNull();
    expect(b.jawTopZ).not.toBeNull();
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

  it('takes a tool by its circle against a jaw\'s end, not by its square (CAM AI\'s check had locked a program whose mill cleared the jaw)', () => {
    // A vise from X-35 to X115, its jaw faces at Y-22 and Y22; a D10 (radius 5).
    const at = (x: number, y: number) => overJaws([[-35, 115]], [-22, 22], [x, y, 0], 5);
    // 4 mm past the Y+ jaw's end and 4 mm inside its face: the circle clears the jaw's corner (5.66 mm from it).
    expect(at(119, 18)).toBe(false);
    // The same before the Y- jaw's start.
    expect(at(-39, -18)).toBe(false);
    // 3 mm and 3 mm: it reaches the corner (4.24 mm).
    expect(at(118, 19)).toBe(true);
    // Beside the jaw: within its radius of the face, and clear of it.
    expect(at(100, 18)).toBe(true);
    expect(at(100, 16)).toBe(false);
    // Past the end, over the jaw's side of its face: within its radius of the end, and further.
    expect(at(119, 30)).toBe(true);
    expect(at(121, 30)).toBe(false);
    // Two vises 50 mm apart: in the gap, clear of both.
    expect(overJaws([[-35, 115], [165, 315]], [-22, 22], [140, 30, 0], 5)).toBe(false);
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
    // The shop's top plate 100x50x30: back, front, then on edge three times (O0999834).
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
    const { setups, part, white } = analyseProgram(parseToolpath(lines.join('\n'), S), { jawHeight: 42 });
    expect(part).toEqual({ min: [0, -50, -30], max: [100, 0, 0] });
    // Back side up first: the white face (front, where the RAFI is) is underneath in the part frame.
    expect(white!.map((v) => v + 0)).toEqual([0, 0, -1]);
    const size = (i: number) => setups[i].stock!.max.map((v, k) => v - setups[i].stock!.min[k]);
    expect(setups.map((x) => size(setups.indexOf(x)))).toEqual([[100, 50, 30], [100, 50, 30], [100, 30, 50], [50, 30, 100], [50, 30, 100]]);
    // Back -> front: turned around X. On edge: front face toward Y+.
    expect(setups[1].orient).toEqual([1, 0, 0, 0, -1, 0, 0, 0, -1]);
    for (const s of setups.slice(2)) expect(s.orient.slice(3, 6)).toEqual([0, 0, -1]);
    // Every setup stands on the same floor (G54 Z-57): bottom - support + G52 Z.
    const g52z = [11, 3, -7, 43, 43];
    setups.forEach((s, i) => expect(s.floorZ! + g52z[i]).toBeCloseTo(-57, 5));
  });

  it("draws CAM AI's parallels exactly as tall as written, never up to the part over them", () => {
    // The owner saw 38 mm parallels drawn as tall as the jaws. CAM AI's own program: the parallels stand on its
    // G52 floor, as tall as the note says, whatever the reader makes of the part above them.
    const marked = (g52z: string) =>
      program(10)
        .replace('O1999213 ', 'O1999213\n(3D-MODELL)\n')
        .replace('G52 X-23. Y28. Z10.', 'G52 X-23. Y28. Z11.')
        .replace('M0 (TEIL 180 GRAD UM Y DREHEN/49 IN X UND 40 IN Y)', 'M0 (TEIL 180 GRAD UM Y DREHEN/49 IN X UND 40 IN Y/Z+ IN 4MM)')
        .replace('M0 (38 MM UNTERLAGE / Z+ IN 15MM)', 'M0 (38 MM UNTERLAGE)')
        .replace('G52 X-25.5 Y30. Z-4.', `G52 X-25.5 Y30. Z${g52z}`);
    for (const z of ['7.', '11.', '20.']) {
      for (const s of analyseProgram(parseToolpath(marked(z), S), { jawHeight: 45 }).setups) {
        expect(s.support).toBe(38);
        expect(s.cales?.length).toBeGreaterThan(0);
        for (const c of s.cales!) expect(c.top - s.floorZ!).toBeCloseTo(38, 6);
        expect(s.jawTopZ! - s.floorZ!).toBeCloseTo(45, 6);
      }
    }
  });

  it("stands a later clamping of CAM AI's own program where its G52 and parallels put it, even 1 mm from the facing guess", () => {
    // The study (docs/knowledge/cam-part-study.md, E2): the facing guess stood a part 1.04 mm too high in a later
    // clamping, so the 3D view showed every floor there 1 mm too deep. An engineers' G52 keeps 1.5 mm of tolerance.
    const two = (mark: boolean) =>
      program(10)
        .replace('O1999213 ', mark ? 'O1999213\n(3D-MODELL)\n' : 'O1999213\n')
        .replace('G52 X-23. Y28. Z10.', 'G52 X-23. Y28. Z11.')
        .replace('M0 (38 MM UNTERLAGE / Z+ IN 15MM)', 'M0 (38 MM UNTERLAGE)')
        .replace('G52 X-25.5 Y30. Z-4.', 'G52 X-25.5 Y30. Z-3.');
    const top = (mark: boolean) => analyseProgram(parseToolpath(two(mark), S), { jawHeight: 45 }).setups[1].stock!.max[2];
    // Clamping 1 as the planner writes it (floor G54 Z-57 - 11, 38 mm parallels, 30 mm of stock: its top at Z0).
    // Clamping 2: floor Z-57 + 3, the same parallels and stock: its top at 14, not the guess's 15.
    expect(top(true)).toBeCloseTo(14, 5);
    expect(top(false)).toBeCloseTo(15, 5);
  });

  it('reads where the part rests on the parallels (EP)', () => {
    expect(readInstructions(['38 MM UNTERLAGE SUR EP 8 MM']).restDepth).toBe(8);
    expect(readInstructions(['38 MM UNTERLAGE IN EPAISEUR 20']).restDepth).toBe(20);
    expect(readInstructions(['41 MM UNTERLAGE IN EP 4.5 MM']).restDepth).toBe(4.5);
    expect(readInstructions(['40 MM UNTERLAGE']).restDepth).toBeNull();
  });

  it('reads every way the CAM programmers describe a setup', () => {
    const r = (line: string) => readInstructions([line]);
    expect(r('TEIL 90 GRAD UM X DREHEN/Z+ WIRD Y+/30 IN X 20.5 IN Y')).toMatchObject({ turns: [{ axis: 'X', deg: -90 }], sizes: { x: 30, y: 20.5 } });
    expect(r('TEIL 90 GRAD UM X DREHEN/Z+ WIRD Y-').turns).toEqual([{ axis: 'X', deg: 90 }]);
    expect(r('TEIL 90 GRAD UM Y DREHEN/Z+ WIRD X+/30 IN X UND Y')).toMatchObject({ turns: [{ axis: 'Y', deg: 90 }], sizes: { x: 30, y: 30 } });
    expect(r('TEIL 90 GRAD UM Z DREHEN/X+ WIRD Y+/36 IN X AND 41 IN Y')).toMatchObject({ turns: [{ axis: 'Z', deg: 90 }], sizes: { x: 36, y: 41 } });
    expect(r('TEIL 180 GRAD UM Z DREHEN/36 IN X 41 IN Y')).toMatchObject({ turns: [{ axis: 'Z', deg: 180 }], sizes: { x: 36, y: 41 } });
    expect(r('TEIL 180 GRAD UM Y DREHEN/24 IN X UND 20.4 IN Y')).toMatchObject({ turns: [{ axis: 'Y', deg: 180 }], sizes: { x: 24, y: 20.4 } });
    expect(r('MOD. SPANNEN F. RUECKS./ 100 UM X UND 100 UM Y ')).toMatchObject({ clamp: 'module', side: 'back', sizes: { x: 100, y: 100 }, turns: [] });
    expect(r('MOD. SPANNEN F. FRONTSEITE/ 100 IN XY/RAFI IN X-Y-')).toMatchObject({ side: 'front', sizes: { x: 100, y: 100 }, marker: { name: 'RAFI', faces: ['X-', 'Y-'] } });
    expect(r('MOD. HOCHKANT/PERS. Y+/90 GRAD UM Y DREHEN/Z+ WIRD X-')).toMatchObject({ onEdge: true, pers: 'Y+', turns: [{ axis: 'Y', deg: -90 }] });
    expect(r('MOD. HOCHKANT/PERS. Y+/ID WINDOW IN Z+')).toMatchObject({ pers: 'Y+', marker: { name: 'ID WINDOW', faces: ['Z+'] } });
    expect(r('F. RUECKS./60 UM X UND 66 UM Y /RAFI IN X+Y-')).toMatchObject({ side: 'back', sizes: { x: 60, y: 66 }, marker: { faces: ['X+', 'Y-'] } });
    expect(r(' 41  MM UNTERLAGE  / UNTER MASS 5 MM')).toMatchObject({ support: 41, restDepth: 5 });
    expect(r('36 MM UNTERLAGE IN EP 16 MM')).toMatchObject({ support: 36, restDepth: 16 });
    expect(r('15 MM ZWISCHENLAGE IN Y- IN EP 18.55 POUR LE BON FIXATION').spacers).toEqual([{ mm: 15, side: 'Y-' }]);
    expect(r('MISE EN POSITION SUR LA TABLE 8 MM UNTERLAGE').support).toBe(8);
    expect(r('FIXATION AVEC LES BRIDES SENS Y ET DEMONTER LES BRIDES SEN X').clamp).toBe('fixture');
    expect(r('MOD. SPANNEN F. RUECKS./100 IN X/RAF X+Y-').marker).toEqual({ name: 'RAFI', faces: ['X+', 'Y-'] });
    expect(r('TEIL MIT 60 UM X UND 66 UM Y EINSPANNEN')).toMatchObject({ clamp: 'vise', sizes: { x: 60, y: 66 }, turns: [] });
  });

  it('follows the RAFI when the written turn cannot give the written position, and says so', () => {
    const lines = ['%', 'O0835', '(TOP PLATE FH / 100X50X30)'];
    const setup = (notes: string[]) => {
      lines.push(...notes.map((n) => `M0 (${n})`), 'G52 X-50. Y50. Z3.', 'T2 M6 (FRAESER D6)', '(DIAMETER 6.00 MM/LENGTH 30.00 MM)', 'G0 G90 X50 Y-25 S5000 M3', 'G43 H2 Z5.', 'G1 Z-2. F300', 'G1 X51.', 'G0 Z50.');
    };
    setup(['MOD. SPANNEN F. FRONTSEITE/100 IN X/RAFI IN X+Y-', '30 MM UNTERLAGE']);
    // Turned 180 around X the RAFI would point X+ Y+: as written it cannot point X- Y-.
    setup(['MOD. SPANNEN F. RUECKS./180 GRAD UM X DREHEN/RAFI IN X-Y-', '30 MM UNTERLAGE']);
    // Agreeing: 180 around X puts the RAFI at X+ Y+ (from the first side).
    setup(['MOD. SPANNEN F. FRONTSEITE/RAFI IN X+Y-', '30 MM UNTERLAGE']);
    setup(['MOD. SPANNEN F. RUECKS./180 GRAD UM X DREHEN/RAFI IN X+Y+', '30 MM UNTERLAGE']);
    lines.push('M30', '%');
    const { setups } = analyseProgram(parseToolpath(lines.join('\n'), S), { jawHeight: 42 });
    expect(setups.map((s) => s.conflict)).toEqual([false, true, false, false]);
    // The RAFI and the back side up win: turned 180 around Y.
    expect(setups[1].orient).toEqual([-1, 0, 0, 0, 1, 0, 0, 0, -1]);
    expect(setups[3].orient).toEqual([1, 0, 0, 0, -1, 0, 0, 0, -1]);
  });

  it('UNTER MASS n: the parallels touch the part n mm below Z0, like IN EP (shop answer D4)', () => {
    const tp = parseToolpath(program(10).replace('M0 (38 MM UNTERLAGE / Z+ IN 15MM)', 'M0 (38 MM UNTERLAGE / UNTER MASS 5 MM / Z+ IN 15MM)'), S);
    const s = analyseProgram(tp, { jawHeight: 42 }).setups[1];
    expect(s.restZ).toBeCloseTo(-5, 5);
  });

  it('turns 180 around Y then 90 around Z when the instruction says X+ becomes Y+', () => {
    const r = readInstructions(['TEIL 180 GRAD UM Y DREHEN', 'TEIL 90 GRAD UM Z DREHEN/X+ WIRD Y+']);
    expect(r.turns).toEqual([{ axis: 'Y', deg: 180 }, { axis: 'Z', deg: 90 }]);
    expect(readInstructions(['TEIL MIT/90 IN X /Z+ IN Y-/ 21.5 IN X UND 24.5 IN Y EINSPANNEN']).turns).toEqual([{ axis: 'X', deg: 90 }]);
  });

  it('gives each written turn the direction written right after it (Z+ WIRD Y-, then Z+ WIRD X-)', () => {
    const r = readInstructions(['TEIL 90 GRAD UM X DREHEN/Z+ WIRD Y-', 'TEIL 90 GRAD UM Y DREHEN/Z+ WIRD X-', '22 MM UNTERLAGE']);
    // Z+ goes to Y- (a quarter turn around X), then the top goes to X- (back a quarter around Y).
    expect(r.turns).toEqual([{ axis: 'X', deg: 90 }, { axis: 'Y', deg: -90 }]);
    expect(readInstructions(['TEIL 90 GRAD UM X DREHEN/Z+ WIRD Y+']).turns).toEqual([{ axis: 'X', deg: -90 }]);
    expect(readInstructions(['TEIL 90 GRAD UM Y DREHEN/Z+ WIRD X+']).turns).toEqual([{ axis: 'Y', deg: 90 }]);
  });

  it('reads a header side written 0 ("100X50X0") as the height the first clamping shows', () => {
    const code = ['%', 'O1013', 'N3 (TOP PLATE FH / 100X50X0)', 'N9 G54', 'N10 M0 (MOD. SPANNEN F. RUECKS./100 IN X )', 'N11 M0 (36 MM UNTERLAGE)', 'N12 G52 X0.000 Y25.000 Z19.000', 'N13 T3 M6 (MESSERKOPF D80)', 'N14 G0 X-60. Y-25. Z1.', 'N15 G1 Z0. F500', 'N16 G1 X60.', 'N17 M30'].join('\n');
    const { part } = analyseProgram(parseToolpath(code, S), { jawHeight: 45 });
    expect(part!.max[2] - part!.min[2]).toBeCloseTo(40, 1);
    expect(partLook(code)).toBe('fh');
  });

  it('reads "15 MM UNTERLAGE/ IN Y-" as a spacer on the Y- side, not a second support (O1999043)', () => {
    const r = readInstructions(['TEIL 180 GRAD UM Y DREHEN/24 IN X UND 14 IN Y', '38 MM UNTERLAGE', '15  MM UNTERLAGE/ IN Y-']);
    expect(r.support).toBe(38);
    expect(r.spacers).toEqual([{ mm: 15, side: 'Y-' }]);
    // Written the other way round, the support is still the one without a side.
    expect(readInstructions(['15 MM UNTERLAGE IN Y-', '38 MM UNTERLAGE'])).toMatchObject({ support: 38, spacers: [{ mm: 15, side: 'Y-' }] });
    expect(readInstructions(['41 MM UNTERLAGE IN EP 4.5 MM'])).toMatchObject({ support: 41, restDepth: 4.5, spacers: [] });
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
    // Raw block after "//" instead of ZUSCHNITT (O0999578); a lone size after "//" is the finished part (O0999538).
    expect(partSizes(['TOP PLATE POM / 100X50X30 // 104X54X40'])).toMatchObject({ finished: [100, 50, 30], raw: [104, 54, 40] });
    expect(partSizes([' INSERT (TOP PLATE FH // 150X100X30 ) '])).toMatchObject({ finished: [150, 100, 30], raw: null });
    expect(readInstructions(['TEIL MIT 104 UM X UND 54 UM Y EINSPANNEN']).sizes).toEqual({ x: 104, y: 54 });
    expect(readInstructions(['36 MM UNTERLAGE IN 21MM'])).toMatchObject({ support: 36, restDepth: 21 });
    expect(readInstructions(['15 MM ZWISCHENLAGE IN Y-']).spacers).toEqual([{ mm: 15, side: 'Y-' }]);
    // The same plate under its other names, number before or after.
    expect(readInstructions(['10 MM INTERCALE EN Y+']).spacers).toEqual([{ mm: 10, side: 'Y+' }]);
    expect(readInstructions(['INTERCALLE 20MM X-']).spacers).toEqual([{ mm: 20, side: 'X-' }]);
    expect(readInstructions(['UNTERCALE 15 MM IN Y-']).spacers).toEqual([{ mm: 15, side: 'Y-' }]);
    expect(readInstructions(['36 MM UNTERLAGE']).spacers).toEqual([]);
    // One on each side: both plates, the part held between them.
    expect(readInstructions(['15 MM ZWISCHENLAGE IN Y-', '15 MM ZWISCHENLAGE IN Y+']).spacers).toEqual([{ mm: 15, side: 'Y-' }, { mm: 15, side: 'Y+' }]);
  });

  it('turns the part over when a later clamping first says it is the back side (O0999220)', () => {
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
    // With a spacer on the back too, both are kept: the one against the fixed back jaw pushes the
    // part 15 mm toward the operator, so this cut now stays inside the part.
    const both = analyseSetups(parseToolpath(toFront.replace('M0 (38 MM UNTERLAGE)', 'M0 (38 MM UNTERLAGE)\nM0 (15 MM ZWISCHENLAGE IN Y-)\nM0 (15 MM ZWISCHENLAGE IN Y+)'), S), { jawHeight: 60 })[0];
    expect([spacerAt(both, 'Y-'), spacerAt(both, 'Y+')]).toEqual([15, 15]);
    expect(both.stock!.max[1]).toBeCloseTo(spaced.stock!.max[1] - 15, 5);
    expect(both.collisions).toEqual([]);
    // Not the jaw (export goes on), but the spacer: fine, it is there to be cut into (green).
    expect(spaced.collisions.map((c) => c.what)).toEqual(['spacer']);
    // A thin spacer is not enough: the D10 reaches 13 mm past the part, into the jaw too.
    const thin = analyseSetups(parseToolpath(toFront.replace('M0 (38 MM UNTERLAGE)', 'M0 (38 MM UNTERLAGE)\nM0 (5 MM ZWISCHENLAGE IN Y-)'), S), { jawHeight: 60 })[0];
    expect(thin.collisions.filter((c) => c.what !== 'spacer')).toHaveLength(1);
  });
});

describe('cales and the jaw tops', () => {
  const programs = import.meta.glob('./programs/*.txt', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

  it('reads "3 MM SUR L\'ETAU": on the jaw tops, 3 mm above them, no cales', () => {
    expect(readInstructions(['TEIL 180 GRAD UM Y DREHEN/18 IN X UND 8 IN Y', 'EPESSEUR DE 3 MMSUR L\'ETEAU']).onJaw).toBe(3);
    expect(readInstructions(['EPAISSEUR DE 8 MM SUR L\'ETAU']).onJaw).toBe(8);
    expect(readInstructions(['40 MM UNTERLAGE']).onJaw).toBeNull();
    // O0999898, side 2: G52 Z-9 puts the floor at Z-48, the jaw tops at Z-3, the finished top 3 mm above.
    const { setups } = analyseProgram(parseToolpath(programs['./programs/O0999898.X20.txt'], S), { jawHeight: 45 });
    expect(setups[1].onJaw).toBe(3);
    expect(setups[1].floorZ).toBeCloseTo(-48, 5);
    expect(setups[1].jawTopZ).toBeCloseTo(-3, 5);
    expect(setups[1].collisions).toEqual([]);
    // Nothing under it: no parallels drawn, none checked against the tools, none for a through-cut to stop on.
    expect(setups[1].cales).toBeNull();
  });

  it('a feed may go up to 1 mm into a parallel (shop rule); deeper, or any rapid below its top, is a hit', () => {
    // One clamping on 38 mm parallels: their tops at Z-30, the front one over Y -21.7 to -15.7.
    const one = program(-10).split('\n');
    const at = one.indexOf('G1 X30.') + 1;
    const into = (move: string, z: number) =>
      analyseProgram(parseToolpath([...one.slice(0, at), `${move} X0. Y-18.`, `${move} Z${z}`, 'G0 Z50.', ...one.slice(at)].join('\n'), S), { jawHeight: 45 }).setups[0].collisions.filter((c) => c.what === 'cale');
    expect(into('G1', -30.9)).toEqual([]);
    expect(into('G1', -31.1).map((c) => Math.round(c.depth * 100) / 100)).toEqual([1.1]);
    expect(into('G0', -31).map((c) => Math.round(c.depth * 100) / 100)).toEqual([1]);
    expect(into('G0', -30.2)).toHaveLength(1);
    expect(into('G0', -29.5)).toEqual([]);
  });

  it('rejects a cale height the cales box does not have, with its line', () => {
    const code = program(-10);
    expect(analyseProgram(parseToolpath(code, S), { jawHeight: 45 }).setups[0].rejects).toEqual([]);
    const bad = analyseProgram(parseToolpath(code.replace('M0 (38 MM UNTERLAGE)', 'M0 (37 MM UNTERLAGE)'), S), { jawHeight: 45 }).setups[0].rejects;
    expect(bad).toEqual([{ kind: 'cale', mm: 37, line: code.split('\n').indexOf('M0 (38 MM UNTERLAGE)') }]);
    // 36 mm is in the box.
    expect(analyseProgram(parseToolpath(code.replace('M0 (38 MM UNTERLAGE)', 'M0 (36 MM UNTERLAGE)'), S), { jawHeight: 45 }).setups[0].rejects).toEqual([]);
  });

  it('rejects a flip whose written clamping size the part does not have', () => {
    const code = programs['./programs/O0999898.X20.txt'];
    // As written: the part is 8 mm wide in Y where the jaws grip it.
    expect(analyseProgram(parseToolpath(code, S), { jawHeight: 45 }).setups[1].rejects).toEqual([]);
    const wrong = code.replace('18 IN X UND 8 IN Y', '18 IN X UND 3 IN Y');
    const r = analyseProgram(parseToolpath(wrong, S), { jawHeight: 45 }).setups[1].rejects;
    expect(r).toMatchObject([{ kind: 'size', axis: 'Y', want: 3, line: wrong.split('\n').findIndex((l) => l.includes('3 IN Y')) }]);
    // "D4.8 IN X-" is a hole and the side it is on, not a size.
    expect(readInstructions(['TEIL 180 GRAD UM X DREHEN/D4.8 IN X-']).sizes).toBeNull();
  });

  // A bar L x 40 x 20 against the stop: a cut along it, then the tool goes down behind it at X195 (Y+10).
  const bar = (length: number, note = '') =>
    ['%', `O1 (BAR ALU / ${length}X40X20)`, `M0 (TEIL MIT ${length} IN X UND 40 IN Y EINSPANNEN${note})`, 'M0 (10 MM UNTERLAGE)', 'G52 X-50. Y50. Z0.',
      'T2 M6 (FRAESER D10)', '(DIAMETER 10.00 MM/LENGTH 30.00 MM)', 'G0 G90 G54 X10. Y-20. S6000 M3', 'G43 H2 Z20.', 'G1 Z-5. F300', 'G1 X190.', 'G0 Z20.',
      'G0 X195. Y10.', 'G1 Z-5.', 'G0 Z50.', 'M30', '%'].join('\n');

  it('holds the part in the 125 mm vise, or in both vises when it is too long or the program says so', () => {
    // 170 mm: 45 mm out of the one vise (up to 50 allowed).
    const one = analyseSetups(parseToolpath(bar(170), S), { jawHeight: 45 })[0];
    expect(one.twoVises).toBe(false);
    // The 125 mm jaws.
    expect(one.jawX[1] - one.jawX[0]).toBe(125);
    // Nothing at X195: the part sticks out of the one vise there.
    expect(one.collisions).toEqual([]);
    const written = analyseSetups(parseToolpath(bar(200, '/MIT 2 SCHRAUBSTOECKEN 50 MM ABSTAND'), S), { jawHeight: 45 })[0];
    expect(written.twoVises).toBe(true);
    expect(viseSpans(written)[1]).toEqual([written.jawX[0] + 175, written.jawX[0] + 300]);
    // The second vise's fixed jaw is there now.
    expect(written.collisions).toHaveLength(1);
    expect(written.stock!.max[0] - written.stock!.min[0]).toBe(200);
    expect(analyseSetups(parseToolpath(bar(240), S), { jawHeight: 45 })[0].twoVises).toBe(true);
  });

  it("checks the shop's jaws from the stop's face to 125 mm past it, nothing more (the owner's picture of the vise)", () => {
    const base = analyseSetups(parseToolpath(bar(120), S), { jawHeight: 45 })[0];
    const stop = base.clampBox!.min[0];
    expect(base.jawX).toEqual([stop, stop + 125]);
    expect(base.jawX).toEqual(jawsFrom(stop));
    // A Ø10 tool 2 mm past the back jaw's face: in the jaw at the stop + 120, clear of it before the stop (- 6) and
    // past its end (+ 131).
    const jawY: [number, number] = [base.clampBox!.min[1], base.clampBox!.max[1]];
    const past = (x: number) => overJaws(viseSpans(base), jawY, [x, jawY[1] + 2, 0], 5);
    expect(past(stop + 120)).toBe(true);
    expect(past(stop - 6)).toBe(false);
    expect(past(stop + 131)).toBe(false);
  });

});


// Wordings of the reference library the app read wrong (Phase 2), each as the library writes it.
describe("the shop's other ways of writing a setup", () => {
  it('TEIL n GRAD IN X is the turn TEIL n GRAD UM X DREHEN', () => {
    expect(readInstructions(['TEIL 180 GRAD IN X']).turns).toEqual([{ axis: 'X', deg: 180 }]);
    expect(readInstructions(['TEIL MIT  180 GRAD IN X']).turns).toEqual([{ axis: 'X', deg: 180 }]);
    expect(readInstructions(['TEIL 180 GRAD IN Y']).turns).toEqual([{ axis: 'Y', deg: 180 }]);
    expect(readInstructions(['TEIL 90 GRAD IN X / Z+ IN Y+']).turns).toEqual([{ axis: 'X', deg: -90 }]);
    expect(readInstructions(['TEIL 90 GRAD IN Y// Z+ IN X+']).turns).toEqual([{ axis: 'Y', deg: 90 }]);
  });

  it('Z+ WIRD TO X-, Z+ WIRD IN Y+ and Z+ ZU Y+ name the direction like Z+ WIRD', () => {
    expect(readInstructions(['TEIL 90 GRAD UM Y DREHEN/Z+ WIRD TO X-']).turns).toEqual([{ axis: 'Y', deg: -90 }]);
    expect(readInstructions(['TEIL 90 GRAD UM X DREHEN/Z+ WIRD IN Y+']).turns).toEqual([{ axis: 'X', deg: -90 }]);
    expect(readInstructions(['TEIL 90 GRAD UM Y DREHEN/Z+ WIRD IN X+']).turns).toEqual([{ axis: 'Y', deg: 90 }]);
    expect(readInstructions(['TEIL 90 GRAD UM X DREHEN /Z+ ZU Y+']).turns).toEqual([{ axis: 'X', deg: -90 }]);
  });

  it('reads the rest depth written / IN n MM and IN MASS n MM like IN EP n MM', () => {
    expect(readInstructions(['38 MM UNTERLAGE / IN 8 MM'])).toMatchObject({ support: 38, restDepth: 8 });
    expect(readInstructions(['41 MM UNTERLAGE // IN  8 MM'])).toMatchObject({ support: 41, restDepth: 8 });
    expect(readInstructions(['40 MM UNTERLAGE/ IN 6MM'])).toMatchObject({ support: 40, restDepth: 6 });
    expect(readInstructions(['40 MM UNTERLAGEIN MASS 7 MM'])).toMatchObject({ support: 40, restDepth: 7 });
    expect(readInstructions(['28 MM UNTERLAGEIN MASS 19.5 MM'])).toMatchObject({ support: 28, restDepth: 19.5 });
    expect(readInstructions(['41 MM UNTERLAGE MASS 5 MM '])).toMatchObject({ support: 41, restDepth: 5 });
    // A side ("IN Y-") is a spacer, not a rest depth.
    expect(readInstructions(['15 MM UNTERLAGE/ IN Y-', '38 MM UNTERLAGE'])).toMatchObject({ support: 38, restDepth: null, spacers: [{ mm: 15, side: 'Y-' }] });
  });

  it('reads UNTER MASS n as the rest depth below Z0, as the library writes it', () => {
    expect(readInstructions(['36 MM UNTERLAGE /UNTER MASS  32 MM'])).toMatchObject({ support: 36, restDepth: 32 });
    expect(readInstructions(['38 MM UNTERLAGE/UNTER MASS 13 MM LEGEN'])).toMatchObject({ support: 38, restDepth: 13 });
    expect(readInstructions(['41 MM UNTERLAGE UNTER MASS 6.5'])).toMatchObject({ support: 41, restDepth: 6.5 });
    expect(readInstructions(['TEIL 180 GRAD UM Y DREHEN / 64 IN X UND 65.5 IN Y / UNTER MASS 5', '41 MM UNTERLAGE IN EP 5 MM'])).toMatchObject({ support: 41, restDepth: 5 });
  });

  it('CALCO (Portuguese) and CALE (French) are the parallels; NA BASE DE n is the rest depth', () => {
    expect(readInstructions(['TEIL 180 GRAD IN X', 'CALCO 40 MM NA BASE DE 6 MM'])).toMatchObject({ support: 40, restDepth: 6 });
    expect(readInstructions(['CALCO 41 MM NA BASE DE 5 MM'])).toMatchObject({ support: 41, restDepth: 5 });
    expect(readInstructions(['40 MM CALE'])).toMatchObject({ support: 40, restDepth: null });
    expect(readInstructions(['CALES DE 38 MM'])).toMatchObject({ support: 38 });
    // UNTERCALE / INTERCALE stay spacers beside the part (shop answers D1, D15).
    expect(readInstructions(['UNTERCALE 15 MM IN Y-', '38 MM UNTERLAGE'])).toMatchObject({ support: 38, spacers: [{ mm: 15, side: 'Y-' }] });
  });

  it('reads the clamping sizes written 30 IN X 13 UND Y, 64 IN X /40 IN Y and 100 IN X Y', () => {
    expect(readInstructions(['TEIL 90 GRAD UM X DREHEN/Z+ WIRD Y-/30 IN X 13 UND Y']).sizes).toEqual({ x: 30, y: 13 });
    expect(readInstructions(['TEIL 90 GRAD UM Y DREHEN/Z+ WIRD X+/21 IN X 34.5 UND Y']).sizes).toEqual({ x: 21, y: 34.5 });
    expect(readInstructions(['TEIL MIT 64 IN X /40 IN Y SPANNEN']).sizes).toEqual({ x: 64, y: 40 });
    expect(readInstructions(['MOD. SPANNEN F. RUECKS./100 IN X Y']).sizes).toEqual({ x: 100, y: 100 });
    // Unchanged: a size in X only, and a direction after X is not a Y size.
    expect(readInstructions(['MOD. HOCHKANT/PERS. Y+/150 IN X/RAFI X- Z+']).sizes).toEqual({ x: 150, y: NaN });
    expect(readInstructions(['TEIL MIT 32 IN X UND Y EINSPANNEN']).sizes).toEqual({ x: 32, y: 32 });
  });

  it('two turn notes, each with its own size: the last size is the clamping (shop answer D5)', () => {
    const r = readInstructions(['TEIL 90 GRAD UM Y DREHEN/Z+ WIRD X+/53 IN X 36 IN Y', 'TEIL 90 GRAD UM X DREHEN/Z+ WIRD Y-/53 IN X 50 IN Y']);
    expect(r.sizes).toEqual({ x: 53, y: 50 });
    expect(r.turns).toEqual([{ axis: 'Y', deg: 90 }, { axis: 'X', deg: 90 }]);
  });

  it('what stops the export: tools or holders into the jaws or the part, never for admins (D7, D8, D14)', () => {
    const hit = (what?: Collision['what']): Collision => ({ move: 0, line: 0, tool: 1, point: [0, 0, 0], depth: 1, what });
    expect(exportBlocked([hit()], false, false)).toBe(true);
    expect(exportBlocked([hit('holder'), hit('holderPart')], false, false)).toBe(true);
    expect(exportBlocked([], true, false)).toBe(true); // still checking
    // A tool into a cale or a spacer is a warning; unknown cale heights and wrong sizes are not hits at all.
    expect(exportBlocked([hit('cale'), hit('spacer')], false, false)).toBe(false);
    expect(exportBlocked([], false, false)).toBe(false);
    // Admins can always export once the check has shown them its hits (D14), never before it ends.
    expect(exportBlocked([hit(), hit('holderPart')], false, true)).toBe(false);
    expect(exportBlocked([], true, true)).toBe(true);
  });

  it("a turn's own hint wins over a written axis it cannot fit (shop answer D6)", () => {
    // A quarter turn about Y never sends Z+ to Y-: about X it does.
    const r = readInstructions(['TEIL 90 GRAD UM Y DREHEN/Z+ WIRD Y-']);
    expect(r.turns).toEqual([{ axis: 'X', deg: 90 }]);
    expect(r.rotation).toEqual({ axis: 'X', deg: 90 });
    // A hint that fits the written axis only sets the direction, as before.
    expect(readInstructions(['TEIL 90 GRAD UM Y DREHEN/Z+ WIRD X-']).turns).toEqual([{ axis: 'Y', deg: -90 }]);
  });

  it('n GRAD IN X+ (a chamfer or countersink side) is not a turn', () => {
    expect(readInstructions(['FASE 45 GRAD IN X+']).turns).toEqual([]);
    expect(readInstructions(['SENKUNG 90 GRAD IN Z-', 'TEIL 180 GRAD UM Y DREHEN']).turns).toEqual([{ axis: 'Y', deg: 180 }]);
  });

  it('a turn written GRAD IN X is replaced, not doubled, when a 3D model corrects it', () => {
    const code = program(10).replace('M0 (TEIL 180 GRAD UM Y DREHEN/49 IN X UND 40 IN Y)', 'M0 (TEIL 180 GRAD IN X/49 IN X UND 40 IN Y)');
    const tp = parseToolpath(code, S);
    const y180 = [-1, 0, 0, 0, 1, 0, 0, 0, -1] as const;
    const fix = rewriteTurns(code, tp, [[1, 0, 0, 0, 1, 0, 0, 0, 1], [...y180]], { jawHeight: 42 });
    expect(fix.unresolved).toEqual([]);
    expect(fix.code).not.toMatch(/GRAD IN X/);
    expect(analyseProgram(parseToolpath(fix.code, S), { jawHeight: 42 }).setups[1].orient).toEqual([...y180]);
  });

  it('15 MM UNTERLAGE // IN Y- is a 15 mm spacer in the jaw at Y-, not the parallels (shop answer)', () => {
    expect(readInstructions(['15 MM UNTERLAGE // IN Y-', '38 MM UNTERLAGE'])).toMatchObject({ support: 38, restDepth: null, spacers: [{ mm: 15, side: 'Y-' }] });
  });

  it('50 IN X/Y is 50 mm in X and 50 mm in Y (a standard top plate size; shop answer)', () => {
    expect(readInstructions(['MOD. SPANNEN F. FRONTSEITE/50 IN X/Y']).sizes).toEqual({ x: 50, y: 50 });
    expect(readInstructions(['TEIL MIT 64 IN X /40 IN Y SPANNEN']).sizes).toEqual({ x: 64, y: 40 });
  });

  it('sizes, parallels and rest depths are read inside one note, never across two', () => {
    // "180 IN Y" in its own note is a turn, not the Y size of "49 IN X".
    expect(readInstructions(['MOD. SPANNEN F. RUECKS./49 IN X', '180 IN Y'])).toMatchObject({ sizes: { x: 49, y: NaN }, turns: [{ axis: 'Y', deg: 180 }] });
    // "IN 2 SCHRAUBSTOECKEN" after "38 MM UNTERLAGE" is not a rest depth of 2 mm.
    expect(readInstructions(['38 MM UNTERLAGE', 'IN 2 SCHRAUBSTOECKEN SPANNEN'])).toMatchObject({ support: 38, restDepth: null });
    // A hole's diameter is not a clamping size ("BOHRUNG D6 IN X Y").
    expect(readInstructions(['TEIL MIT 98 IN X UND 78 IN Y EINSPANNEN', 'BOHRUNG D6 IN X Y']).sizes).toEqual({ x: 98, y: 78 });
    // Within one note, as the shop writes them, nothing changes.
    expect(readInstructions(['38 MM UNTERLAGE / IN 8 MM'])).toMatchObject({ support: 38, restDepth: 8 });
    expect(readInstructions(['TEIL MIT 64 IN X /40 IN Y SPANNEN']).sizes).toEqual({ x: 64, y: 40 });
  });

  it("only a single turn's hint in its own note can change the turn's axis (D6)", () => {
    // A direction phrase in another note does not re-axis the turn.
    expect(readInstructions(['TEIL 90 GRAD UM X DREHEN', 'RAFI X+ IN Y-']).turns).toEqual([{ axis: 'X', deg: 90 }]);
    expect(readInstructions(['TEIL 90 GRAD UM Y DREHEN', '15 MM ZWISCHENLAGE Y- IN X+']).turns).toEqual([{ axis: 'Y', deg: 90 }]);
    // With two turns, a hint the second cannot fit is not taken as its axis.
    expect(readInstructions(['TEIL 90 GRAD UM X DREHEN', 'TEIL 90 GRAD UM Z DREHEN / Z+ WIRD Y-']).turns).toEqual([{ axis: 'X', deg: 90 }, { axis: 'Z', deg: 90 }]);
    // The library's case still turns about X.
    expect(readInstructions(['TEIL 90 GRAD UM Y DREHEN/Z+ WIRD Y-']).turns).toEqual([{ axis: 'X', deg: 90 }]);
  });

  it('CALE is the parallels only on its own: not SANS CALE, not INTER CALE or DÉCALE; with a side it is a spacer', () => {
    expect(readInstructions(['40 MM CALE'])).toMatchObject({ support: 40 });
    expect(readInstructions(["SANS CALE 3 MM SUR L'ETAU"])).toMatchObject({ support: null, onJaw: 3 });
    expect(readInstructions(['INTER CALE 10 MM EN Y+'])).toMatchObject({ support: null, spacers: [{ mm: 10, side: 'Y+' }] });
    expect(readInstructions(['UNTER CALE 15 MM IN Y-'])).toMatchObject({ support: null, spacers: [{ mm: 15, side: 'Y-' }] });
    expect(readInstructions(['PIÈCE DÉCALE DE 5 MM EN Y']).support).toBeNull();
    expect(readInstructions(['CALE 15 MM EN Y-', '38 MM UNTERLAGE'])).toMatchObject({ support: 38, spacers: [{ mm: 15, side: 'Y-' }] });
  });

  it('a part on the table (CAM AI, you: "every parallel rests on the table"): no parallels, the table its floor', () => {
    expect(readInstructions(['OHNE UNTERLAGE / TEIL AUF DEM TISCH'])).toMatchObject({ support: 0, onJaw: null });
    expect(readInstructions(['SANS CALE / PIECE SUR LA TABLE'])).toMatchObject({ support: 0 });
    // Not a table by another name: a spacer, or the jaws.
    expect(readInstructions(["SANS CALE 3 MM SUR L'ETAU"])).toMatchObject({ support: null, onJaw: 3 });
  });

  it('a cale height the box does not have points at the note that asks for it', () => {
    const tp = parseToolpath(program(10).replace('M0 (38 MM UNTERLAGE / Z+ IN 15MM)', 'M0 (CALCO 39 MM NA BASE DE 5 MM)'), S);
    const s = analyseProgram(tp, { jawHeight: 42 }).setups[1];
    const reject = s.rejects.find((r) => r.kind === 'cale')!;
    expect(programLines(tp, reject.line)).toMatch(/CALCO 39 MM/);
  });

  it('a parallels note written as a plain comment is read for CALCO and CALE too, as for UNTERLAGE', () => {
    for (const note of ['(CALCO 40 MM NA BASE DE 5 MM)', '(40 MM CALE)']) {
      const tp = parseToolpath(program(10).replace('M0 (38 MM UNTERLAGE / Z+ IN 15MM)', note), S);
      expect(analyseProgram(tp, { jawHeight: 42 }).setups[1].support, note).toBe(40);
    }
  });

  it('an operation name or a tool description is never a clamping note, even when it says GRAD', () => {
    const turn = 'M0 (TEIL 180 GRAD UM Y DREHEN/49 IN X UND 40 IN Y)';
    for (const comment of ['(TOOLPATH FASE_45_GRAD_1)', '(90 GRAD STICHEL / ST_04.00_025_G45_FH)']) {
      const tp = parseToolpath(program(10).replace(turn, `${comment}\n${turn}`), S);
      expect(tp.setups[1].notes.map((n) => n.text), comment).toEqual(['TEIL 180 GRAD UM Y DREHEN/49 IN X UND 40 IN Y', '38 MM UNTERLAGE / Z+ IN 15MM']);
    }
  });
});


describe('changing the parallels', () => {
  it('slides the old pair out before the new pair slides in, and ends with the new pair in place', () => {
    expect(caleSlide(0)).toEqual({ out: 0, inn: 0 });
    const steps = Array.from({ length: 101 }, (_, i) => caleSlide(i / 100));
    // Never both moving: the new pair starts only once the old one is out.
    expect(steps.every(({ out, inn }) => inn === 0 || out === 1)).toBe(true);
    // Each only moves one way.
    expect(steps.every((x, i) => !i || (x.out >= steps[i - 1].out && x.inn >= steps[i - 1].inn))).toBe(true);
    expect(caleSlide(1)).toEqual({ out: 1, inn: 1 });
  });
});
