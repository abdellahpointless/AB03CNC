/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertFanucToHaas } from '../../src/lib/fanucToHaasConverter';
import { convertHaasToFanuc } from '../../src/lib/haasToFanucConverter';
import { isFanucDialect } from '../../src/lib/gcodeProcessor';

/*
 * The shop's reference library: real orders with their programs. An order holding the same job
 * posted for both controls (a HAAS and a FANUC file with the same header lines) is a twin: the
 * converters must turn one into the other, apart from the differences listed below, each with
 * its reason. The library is confidential and stays out of git; run with
 *   CNC_LIBRARY=<folder of the order folders> npx vitest run tests/library
 */
const LIB = process.env.CNC_LIBRARY;

interface Twin {
  folder: string;
  /** The program's own name (the library adds _2 to the second file of an order). */
  name: string;
  haas: string;
  fanuc: string;
}

const lines = (text: string) => {
  const l = text.replace(/\r/g, '').split('\n').map((s) => s.trimEnd());
  while (l.length && !l[l.length - 1]) l.pop();
  return l;
};
/** Creation, last change, part line, F.ART.NR. and index: equal in both files of a twin. */
const header = (text: string) =>
  lines(text)
    .slice(0, 12)
    .filter((l) => /DATUM DER|ZUSCHNITT|F\.ART\.NR|PROGRAMM INDEX/.test(l))
    .map((l) => l.replace(/^N\d+\s*/, ''));

function twins(root: string): Twin[] {
  const out: Twin[] = [];
  const seen = new Set<string>();
  for (const folder of readdirSync(root).sort()) {
    const dir = join(root, folder);
    if (!statSync(dir).isDirectory()) continue;
    const programs = readdirSync(dir)
      .filter((f) => f !== 'info.json' && statSync(join(dir, f)).isFile())
      .map((f) => ({ f, text: readFileSync(join(dir, f)).toString('latin1') }))
      .filter((p) => !p.text.startsWith('%PDF-') && /[GMT]\d/.test(p.text));
    const fanuc = programs.filter((p) => isFanucDialect(p.text));
    const haas = programs.filter((p) => !isFanucDialect(p.text));
    if (fanuc.length !== 1 || haas.length !== 1) continue;
    if (JSON.stringify(header(haas[0].text)) !== JSON.stringify(header(fanuc[0].text))) continue;
    const key = haas[0].text + fanuc[0].text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ folder, name: fanuc[0].f.replace(/_\d+(\.[^.]+)$/, '$1'), haas: haas[0].text, fanuc: fanuc[0].text });
  }
  return out;
}

const strip = (l = '') => l.replace(/^N\d+\s*/, '');
type Direction = 'toFanuc' | 'toHaas';

/** Lines the app writes on purpose in place of the shop's line (ours, theirs), with the reason. */
const INSTEAD: Record<Direction, { ours: RegExp; theirs: RegExp; why: string }[]> = {
  toFanuc: [
    // The shop's machines have no O7999: the app brings the table out with G53 Y0 right where the
    // FANUC post calls it (part flips), and ends with the HAAS end line's moves (shop rule).
    { ours: /^G53 Y0$/, theirs: /^M98 P7999$/, why: 'no O7999 on the machines: G53 Y0 at the flip' },
    { ours: /^G0 G53 G49 Y0 Z0( M9)?$/, theirs: /^M98 P7999$/, why: 'no O7999 on the machines: the HAAS end moves' },
  ],
  toHaas: [
    // The CHIRON and AXA HAAS templates end with M9, the others with M89: not in the FANUC file.
    { ours: /^G0 G53 G49 Y0 Z0 M89$/, theirs: /^G0 G53 G49 Y0 Z0 M9$/, why: 'end line of the CHIRON/AXA HAAS templates' },
  ],
};
/** Lines only one side has. */
const ONLY_OURS: Record<Direction, RegExp[]> = {
  // Coolant off before a tool change, written by the CHIRON/AXA HAAS templates only (never by the
  // FANUC post): kept, harmless on a FANUC.
  toFanuc: [/^M09$/],
  toHaas: [],
};
const ONLY_THEIRS: Record<Direction, RegExp[]> = { toFanuc: [], toHaas: [/^M09$/] };

/** The differences no rule explains, at most 20, as "line n: ours | shop". */
function unexplained(ours: string[], theirs: string[], dir: Direction): string[] {
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while ((i < ours.length || j < theirs.length) && out.length < 20) {
    const a = strip(ours[i]);
    const b = strip(theirs[j]);
    if (i < ours.length && j < theirs.length && (a === b || INSTEAD[dir].some((x) => x.ours.test(a) && x.theirs.test(b)))) {
      i++;
      j++;
    } else if (i < ours.length && ONLY_OURS[dir].some((r) => r.test(a))) i++;
    else if (j < theirs.length && ONLY_THEIRS[dir].some((r) => r.test(b))) j++;
    else {
      out.push(`line ${j + 1}: ${JSON.stringify(ours[i])} | shop ${JSON.stringify(theirs[j])}`);
      i++;
      j++;
    }
  }
  return out;
}

/** N1, N2, N3... on every line but % and the O line; FANUC: N9999 from there on. */
function numbering(out: string[], cap: number): string[] {
  const bad: string[] = [];
  let n = 0;
  out.forEach((l, k) => {
    if (l === '%' || /^O\d/.test(l)) return;
    n++;
    if (!l.startsWith(`N${Math.min(n, cap)} `) && bad.length < 5) bad.push(`line ${k + 1}: ${l}`);
  });
  return bad;
}

describe.skipIf(!LIB)('reference library: HAAS and FANUC twins', () => {
  const all = LIB ? twins(LIB) : [];

  it('finds the twins (the same job posted for both controls)', () => {
    expect(all.length).toBeGreaterThanOrEqual(14);
  });

  for (const t of all) {
    it(`${t.folder}: HAAS -> FANUC gives the shop's FANUC file`, () => {
      const out = lines(convertHaasToFanuc(t.haas, t.name).fanucCode);
      expect(unexplained(out, lines(t.fanuc), 'toFanuc')).toEqual([]);
      expect(numbering(out, 9999)).toEqual([]);
    });

    it(`${t.folder}: FANUC -> HAAS gives the shop's HAAS file`, () => {
      const out = lines(convertFanucToHaas(t.fanuc, t.name).haasCode);
      expect(unexplained(out, lines(t.haas), 'toHaas')).toEqual([]);
      expect(numbering(out, Infinity)).toEqual([]);
    });
  }
});
