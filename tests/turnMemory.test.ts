import { afterEach, describe, expect, it } from 'vitest';
import pdfUrl from './models/O2999411.pdf?inline';
import program from './models/O2999411.000.txt?raw';
import plateUrl from './models/O1998013.pdf?inline';
import plate from './models/O1998013.C60.txt?raw';
import { readModel } from '../src/lib/model';
import { searchTurns } from '../src/lib/fixTurns';
import { parseToolpath, speedsFor, type Toolpath } from '../src/lib/toolpath';
import { analyseProgram, DEFAULT_JAW_HEIGHT, relTurn, setTurnMemory, turnKey } from '../src/lib/setups';
import type { Mat3 } from '../src/lib/orient';

// Learning from mistakes: once a 3D model showed how a program's setups really turn, a program
// worded the same way is read right without the model.

const bytes = (url: string) => Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));
const opts = { jawHeight: DEFAULT_JAW_HEIGHT };
const read = (tp: Toolpath) => analyseProgram(tp, opts).setups.map((s) => s.orient.join());
/** What the app records after a 3D check (lib/turnMemory). */
const records = (tp: Toolpath, right: Mat3[]) =>
  right.slice(1).map((m, i) => ({ key: turnKey(tp.setups[i + 1].notes.map((n) => n.text)), rel: relTurn(m, right[i]).join(), n: 1 })).filter((r) => r.key);

afterEach(() => setTurnMemory([]));

describe('turns learned from 3D models', () => {
  it('keeps a program read right from its notes right once its turns are learned (O1998013)', async () => {
    const tp = parseToolpath(plate, speedsFor('HAAS'));
    const right = searchTurns(await readModel(bytes(plateUrl)), tp, opts)!;
    expect(read(tp)).toEqual(right.orients.map((o) => o.join()));
    setTurnMemory(records(tp, right.orients));
    expect(read(tp)).toEqual(right.orients.map((o) => o.join()));
    expect(analyseProgram(tp, opts).setups.slice(1).every((s) => s.learned)).toBe(true);
  }, 300_000);

  it('a wrong note corrected once is read right the next time (O2999411 with "Z+ WIRD Y-")', async () => {
    const broken = program.replace('TEIL 90 GRAD UM X DREHEN/78 IN X UND 9 IN Y/Z+ WIRD Y+', 'TEIL 90 GRAD UM X DREHEN/78 IN X UND 9 IN Y/Z+ WIRD Y-');
    const tp = parseToolpath(broken, speedsFor('HAAS'));
    const right = searchTurns(await readModel(bytes(pdfUrl)), tp, opts)!;
    setTurnMemory(records(tp, right.orients));
    expect(read(tp)).toEqual(right.orients.map((o) => o.join()));
  }, 300_000);

  it('the key keeps the wording and the turn angles, not the sizes, tools or parallels', () => {
    expect(turnKey(['90 GRAD STICHEL/D4', 'ST_04.00_025_G45_ALHS', 'TEIL 90 GRAD UM X DREHEN/78 IN X UND 9 IN Y/Z+ WIRD Y+', '41 MM UNTERLAGE'])).toBe('TEIL 90 GRAD UM X DREHEN/N IN X UND N IN Y/Z+ WIRD Y+');
    expect(turnKey(['TEIL 180 GRAD UM Y DREHEN/100 IN X UND 54 IN Y'])).toBe(turnKey(['TEIL 180 GRAD UM Y DREHEN/80 IN X UND 30.5 IN Y']));
    expect(turnKey(['TEIL 180 GRAD UM Y DREHEN'])).not.toBe(turnKey(['TEIL 90 GRAD UM Y DREHEN']));
    expect(turnKey([])).toBe('');
  });

  it('a wording the models disagree on is not trusted; nothing learned changes nothing', async () => {
    const tp = parseToolpath(program, speedsFor('HAAS'));
    const own = read(tp);
    const key = turnKey(tp.setups[2].notes.map((n) => n.text));
    setTurnMemory([
      { key, rel: '1,0,0,0,1,0,0,0,1', n: 2 },
      { key, rel: '1,0,0,0,-1,0,0,0,-1', n: 2 },
    ]);
    expect(read(tp)).toEqual(own);
    setTurnMemory([]);
    expect(read(tp)).toEqual(own);
  });
});
