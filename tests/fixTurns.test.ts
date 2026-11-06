import { describe, expect, it } from 'vitest';
import pdfUrl from './models/O2504411.pdf?inline';
import program from './models/O2504411.000.txt?raw';
import plateUrl from './models/O1042013.pdf?inline';
import plate from './models/O1042013.C60.txt?raw';
import { readModel } from '../src/lib/model';
import { rewriteTurns, searchTurns, turnPhrase } from '../src/lib/fixTurns';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';
import { analyseProgram, DEFAULT_JAW_HEIGHT } from '../src/lib/setups';
import { ALL, IDENTITY } from '../src/lib/orient';

const bytes = (url: string) => Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));
const opts = { jawHeight: DEFAULT_JAW_HEIGHT };
const orients = (code: string) => analyseProgram(parseToolpath(code, speedsFor('HAAS')), opts).setups.map((s) => s.orient.join());

describe('finding the right turns with the real part', async () => {
  const tris = await readModel(bytes(pdfUrl));

  it('leaves a right program alone', () => {
    const r = searchTurns(tris, parseToolpath(program, speedsFor('HAAS')), opts)!;
    expect(r.same).toBe(true);
    expect(r.match).toBeGreaterThan(0.99);
  }, 60_000);

  it('finds a wrong turn, writes it back and reads it again (O2504411 with the second flip written wrong)', () => {
    const broken = program.replace('TEIL 90 GRAD UM X DREHEN/78 IN X UND 9 IN Y/Z+ WIRD Y+', 'TEIL 90 GRAD UM X DREHEN/78 IN X UND 9 IN Y/Z+ WIRD Y-');
    const tp = parseToolpath(broken, speedsFor('HAAS'));
    const counts: number[] = [];
    const r = searchTurns(tris, tp, opts, (p) => counts.push(p.count))!;
    expect(r.start).toBeLessThan(0.99);
    expect(r.match).toBeGreaterThan(0.99);
    expect(counts.length).toBeGreaterThan(0);
    const fix = rewriteTurns(broken, tp, r.orients, opts);
    expect(fix.unresolved).toEqual([]);
    expect(fix.changes.length).toBe(1);
    expect(orients(fix.code)).toEqual(r.orients.map((o) => o.join()));
  }, 300_000);
});

describe('a program read wrong (O1042013: the RAFI of the setups on edge is the TASTER of setup 2)', () => {
  it('is found among the turns that agree with what is written, and written back', async () => {
    const tris = await readModel(bytes(plateUrl));
    const tp = parseToolpath(plate, speedsFor('HAAS'));
    const r = searchTurns(tris, tp, opts)!;
    expect(r.start).toBeLessThan(0.8);
    expect(r.match).toBeGreaterThan(0.99);
    expect(r.stage).toBe('written');
    const fix = rewriteTurns(plate, tp, r.orients, opts);
    expect(fix.unresolved).toEqual([]);
    expect(orients(fix.code)).toEqual(r.orients.map((o) => o.join()));
  }, 300_000);
});

describe('a written turn', () => {
  it('reads back as the same turn, for every way the part can be turned', { timeout: 120_000 }, () => {
    // O2504411's first flip written each way: setup 2 lies as written (setup 1 is the part frame).
    for (const m of ALL) {
      const text = program.replace('TEIL 180 GRAD UM Y DREHEN/78 IN X UND 5.5 IN Y', turnPhrase(m) || 'WEITER');
      expect(analyseProgram(parseToolpath(text, speedsFor('HAAS')), opts).setups[1].orient.join()).toBe(m.join());
    }
    expect(turnPhrase(IDENTITY)).toBe('');
  });
});

describe('clamping sizes', () => {
  it('a size of 90 written second is a size, not a 90° turn', () => {
    const text = program.replace('TEIL 180 GRAD UM Y DREHEN/78 IN X UND 5.5 IN Y', 'TEIL 180 GRAD UM Y DREHEN/44 IN X UND 90 IN Y');
    expect(analyseProgram(parseToolpath(text, speedsFor('HAAS')), opts).setups[1].orient.join()).toBe('-1,0,0,0,1,0,0,0,-1');
  });
});
