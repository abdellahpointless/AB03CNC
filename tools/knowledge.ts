/**
 * How the shop's CAM engineers program, read from the reference library (Phase 3 of the library
 * work): workholding, strategy per feature, tools and cutting data, and G-code style.
 *
 * Counted over the library's distinct programs (a copy counts once), then over parts: the HAAS and
 * FANUC programs of one part, and its other versions, are one part (same creation and size lines in
 * the header, as the twin test reads them). A rule is
 * labelled by the parts it applies to that follow it everywhere it applies: "consistent across the
 * library" (all of them), "majority" (more than half), "minority" (half or less) or "seen once" (it
 * applies to one part). The places it applies to (lines, clampings, holes...) are counted too.
 *
 * What is read through the app's own simulation (how the part sits in the vise, what each clamping
 * removes, the turns) uses only programs whose simulated part matches their 3D model (match of 0.99
 * or more in tests/library/simulation.snap.json). Programs are cited by file and line with the
 * line's text, never by order, article or part name (the repository is public). Nothing here
 * changes CAM AI: src/lib/cam/shopKnowledge.json is not touched.
 *
 *   npm run knowledge -- <library folder>
 *
 * Writes docs/knowledge/knowledge.json (the data) and docs/knowledge/README.md (the readable form).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProgram, type OpKind, type PartRead, type Sample } from '../src/lib/cam/learn';
import { partTypeOf } from '../src/lib/cam/partType';
import { analyseProgram, DEFAULT_JAW_HEIGHT, readInstructions, TABLE_Z, type ProgramSetups } from '../src/lib/setups';
import { buildInput, carve, KEPT } from '../src/lib/stockSim';
import { parseToolpath, speedsFor, type Toolpath } from '../src/lib/toolpath';

const LIB = process.argv[2];
if (!LIB) throw new Error('usage: npm run knowledge -- <library folder>');

interface Program {
  file: string;
  lines: string[];
  fanuc: boolean;
  read: PartRead;
  type: string;
  /** The part it makes (internal key, never written). */
  part: string;
  /** How alike its simulated part and its 3D model are (library snapshot); null: not compared. */
  match: number | null;
  tp: Toolpath;
  an: ProgramSetups;
  /** For each move of tp.moves, its operation (index into read.samples; -1 before the first). */
  opOf: Int32Array;
  /** Volume (mm³) each clamping removes in the simulation. */
  removed: number[];
  /** Per line: the drilling cycle running there (G81...), and the line that started it. */
  cycle: { code: string; at: number }[];
}
interface Cite { file: string; line: number; text: string }
type Topic = 'workholding' | 'strategy' | 'tools' | 'gcode';
interface Unit { holds: boolean; at: number }
interface Count { parts: { applies: number; holds: number }; units: { applies: number; holds: number }; examples: Cite[]; exceptions: Cite[] }
interface Rule extends Count { id: string; topic: Topic; rule: string; unit: string; verifiedOnly: boolean; label: string }

function code(l: string) {
  return l.replace(/\([^)]*\)?/g, ' ').replace(/^\s*N\d+/i, '').trim();
}

// ---- The programs ------------------------------------------------------------------------------
const snap: Record<string, { match?: number }> = JSON.parse(readFileSync('tests/library/simulation.snap.json', 'utf8'));
const h8 = (b: Buffer) => createHash('sha1').update(b).digest('hex').slice(0, 8);
const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';
const programs: Program[] = [];
const seen = new Set<string>();
for (const folder of readdirSync(LIB).sort()) {
  const dir = join(LIB, folder);
  if (!/^\d+_/.test(folder) || !statSync(dir).isDirectory()) continue;
  const files = readdirSync(dir).filter((n) => n !== 'info.json' && statSync(join(dir, n)).isFile()).sort();
  const pdf = files.map((n) => readFileSync(join(dir, n))).find(isPdf) ?? null;
  for (const file of files) {
    const bytes = readFileSync(join(dir, file));
    const text = bytes.toString('latin1');
    if (isPdf(bytes) || !/[GMT]\d/.test(text)) continue;
    const hash = createHash('sha1').update(bytes).digest('hex');
    if (seen.has(hash)) continue;
    seen.add(hash);
    const lines = text.replace(/\r/g, '').split('\n');
    const head = lines.slice(0, 15).map((l) => l.replace(/^\s*N\d+\s*/, '').trim());
    // The family from the part's name on the header's size line (the name itself is not kept).
    const named = head.find((l) => /\d\s*X\s*\d+(?:[.,]\d+)?\s*X\s*\d/i.test(l))?.replace(/^\(/, '').split('/')[0] ?? '';
    const fanuc = /H#513|M254|G94\s+M95/.test(text);
    const tp = parseToolpath(text, speedsFor(fanuc ? 'FANUC' : 'HAAS'));
    const an = analyseProgram(tp, { jawHeight: DEFAULT_JAW_HEIGHT });
    const read = readProgram(text, file);
    const opOf = new Int32Array(tp.moves.length).fill(-1);
    let s = -1;
    tp.moves.forEach((m, i) => {
      while (s + 1 < read.samples.length && read.samples[s + 1].line <= m.line) s++;
      opOf[i] = s;
    });
    const removed = tp.setups.map(() => 0);
    const input = buildInput(tp, an);
    if (input) {
      const g = carve({ ...input, maxVoxels: 200_000, surfaceMoves: false });
      const cell = g.step[0] * g.step[1] * g.step[2];
      for (let v = 0; v < g.removed.length; v++) if (g.removed[v] !== KEPT) removed[input.moves[g.removed[v]].setup] += cell;
    }
    const cycle: { code: string; at: number }[] = [];
    let cur = { code: '', at: -1 };
    lines.forEach((l, i) => {
      const c = code(l);
      const g = c.match(/(?<![A-Z])G(73|8[1-9])(?![0-9])/i);
      if (g) cur = { code: `G${g[1]}`, at: i };
      else if (/(?<![A-Z])G80(?![0-9])/i.test(c)) cur = { code: '', at: -1 };
      cycle.push(cur);
    });
    const row = snap[`${file} ${h8(bytes)}${pdf ? `/${h8(pdf)}` : ''}`];
    programs.push({
      file,
      lines,
      fanuc,
      read,
      type: partTypeOf(named) ?? 'other',
      // Twins and versions of one part share its creation line and its size line (as the twin test reads them).
      part: ((created, sized) => (created && sized ? `${created}|${sized}` : file.replace(/_\d+(\.[^.]+)$/, '$1')))(head.find((l) => /DATUM DER ERSTELLUNG/i.test(l)), head.find((l) => /ZUSCHNITT|\d\s*X\s*\d+(?:[.,]\d+)?\s*X\s*\d/i.test(l))),
      match: row?.match ?? null,
      tp,
      an,
      opOf,
      removed,
      cycle,
    });
  }
}
const verified = (p: Program) => p.match !== null && p.match >= 0.99;
/** A header line names the part, the programmer and the article: only the sizes are cited (the repository is public). */
export const maskHeader = (t: string) =>
  (/ZUSCHNITT|BEARBEITER|\d\s*X\s*\d+(?:[.,]\d+)?\s*X\s*\d/i.test(t) ? t.replace(/\(([^/)]*)(\/|\))/, (_w, _n: string, end: string) => `(<part>${end === '/' ? ' /' : ')'}`).replace(/BEARBEITER\s*:?[^/)]*/gi, 'BEARBEITER: <name>') : t).replace(
    /F\.?\s*ART\.?\s*NR\.?\s*:?[^/)]*/gi,
    'F.ART.NR: <nr>',
  );
const cite = (p: Program, i: number): Cite => ({ file: p.file, line: i + 1, text: maskHeader(p.lines[i].trim().slice(0, 90)) });
const label = (applies: number, holds: number) =>
  applies === 1 ? 'seen once' : holds === applies ? 'consistent across the library' : holds * 2 > applies ? 'majority' : 'minority';
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const round = (v: number, k = 10) => Math.round(v * k) / k;
const hist = (v: number[], step = 1) => {
  const h = new Map<number, number>();
  for (const x of v) {
    const k = round(Math.round(x / step) * step, 100);
    h.set(k, (h.get(k) ?? 0) + 1);
  }
  return [...h].sort((a, b) => a[0] - b[0]);
};

// ---- Rules: counted per part, then per place ------------------------------------------------------
const rules: Rule[] = [];
const RULES = new Map<string, { units: (p: Program) => Unit[]; verifiedOnly: boolean }>();
function count(units: (p: Program) => Unit[], verifiedOnly: boolean, keep: (p: Program) => boolean): Count {
  const parts = new Map<string, boolean>();
  const u = { applies: 0, holds: 0 };
  const examples: Cite[] = [];
  const exceptions: Cite[] = [];
  const citedParts = [new Set<string>(), new Set<string>()];
  for (const p of programs) {
    if (!keep(p) || (verifiedOnly && !verified(p))) continue;
    const us = units(p);
    if (!us.length) continue;
    parts.set(p.part, (parts.get(p.part) ?? true) && us.every((x) => x.holds));
    for (const x of us) {
      u.applies++;
      if (x.holds) u.holds++;
      // One citation per part, three at most.
      const [list, cited] = x.holds ? [examples, citedParts[0]] : [exceptions, citedParts[1]];
      if (list.length < 3 && !cited.has(p.part)) {
        list.push(cite(p, x.at));
        cited.add(p.part);
      }
    }
  }
  return { parts: { applies: parts.size, holds: [...parts.values()].filter(Boolean).length }, units: u, examples, exceptions };
}
function rule(id: string, topic: Topic, text: string, unit: string, units: (p: Program) => Unit[], verifiedOnly = false) {
  RULES.set(id, { units, verifiedOnly });
  const c = count(units, verifiedOnly, () => true);
  if (c.units.applies) rules.push({ id, topic, rule: text, unit, verifiedOnly, ...c, label: label(c.parts.applies, c.parts.holds) });
}
const first = (p: Program, re: RegExp, from = 0, to = p.lines.length) => {
  for (let i = from; i < Math.min(to, p.lines.length); i++) if (re.test(code(p.lines[i]))) return i;
  return -1;
};
const toolChanges = (p: Program) => p.lines.flatMap((l, i) => (/(?<![A-Z])M0*6(?![0-9.])/i.test(code(l)) && /(?<![A-Z])T\d+/i.test(code(l)) ? [i] : []));
const g43Lines = (p: Program) => p.lines.flatMap((l, i) => (/(?<![A-Z])G0*43(?![0-9.])/i.test(code(l)) ? [i] : []));
const cycleLines = (p: Program) => p.lines.flatMap((l, i) => (/(?<![A-Z])G(?:73|8[1-9])(?![0-9])/i.test(code(l)) ? [i] : []));
const oLine = (p: Program) => p.lines.findIndex((l) => /^\s*O\d/i.test(l));
/** The moves of operation `k` of a program. */
const movesOf = (p: Program, k: number) => p.tp.moves.filter((_, i) => p.opOf[i] === k);

// ---- G-code style -------------------------------------------------------------------------------
rule('gcode.numbering', 'gcode', 'Every line but "%" and the O line carries an N number, N1, N2, N3... in steps of 1 (FANUC: N9999 repeated after line 9,999).', 'programs', (p) => {
  let n = 0;
  let ok = true;
  let at = 0;
  for (let i = oLine(p) + 1; i < p.lines.length; i++) {
    const t = p.lines[i].trim();
    if (!t || t === '%') continue;
    const m = t.match(/^N(\d+)/);
    n++;
    if (!m || (Number(m[1]) !== n && !(p.fanuc && n > 9999 && m[1] === '9999'))) {
      ok = false;
      at = i;
      break;
    }
    if (n === 1) at = i;
  }
  return [{ holds: ok, at }];
});
rule('gcode.safety.haas', 'gcode', 'HAAS programs start with the safety line "G40 G17 G53 G49 G80 G90".', 'HAAS programs', (p) =>
  p.fanuc ? [] : [{ holds: first(p, /^G40 G17 G53 G49 G80 G90$/, 0, 20) >= 0, at: Math.max(0, first(p, /G40|G90/, 0, 20)) }]);
rule('gcode.safety.fanuc', 'gcode', 'FANUC programs start with "G0 G53 G49 Z0 G94 M95" (retract, cancel the length offset, feed per minute).', 'FANUC programs', (p) =>
  p.fanuc ? [{ holds: first(p, /^G0 G53 G49 Z0 G94 M95$/, 0, 20) >= 0, at: Math.max(0, first(p, /G53/, 0, 20)) }] : []);
rule('gcode.operationName', 'gcode', 'Each tool change is announced by the operation name: a "(TOOLPATH NAME)" comment right before "T.. M6". An operation that goes on with the same tool is a comment "(NAME MIT WERKZEUG <tool code>)" instead.', 'tool changes', (p) =>
  toolChanges(p).map((i) => ({ holds: i > 0 && /\(TOOLPATH /i.test(p.lines[i - 1]), at: i - 1 >= 0 ? i - 1 : i })));
rule('gcode.toolComment', 'gcode', 'After "T.. M6" the tool is described: "(NAME / CODE)" with a code like SF_10.00_030_000_AL, then "(DIAMETER d MM/LENGTH l MM)".', 'tool changes', (p) =>
  toolChanges(p).map((i) => {
    const next = p.lines.slice(i + 1, i + 4).join(' ');
    return { holds: /[A-Z]{2}_\d+\.\d+_\d+/.test(next) && /\(DIAMETER\s+[\d.]+ MM\/LENGTH\s+[\d.]+ MM\)/i.test(next), at: i + 1 };
  }));
rule('gcode.g43.haas', 'gcode', 'HAAS: the length offset is "G00 G43 H<tool> Z.." with H the number of the tool in the spindle.', 'G43 lines (HAAS)', (p) => {
  if (p.fanuc) return [];
  let tool = '';
  const out: Unit[] = [];
  p.lines.forEach((l, i) => {
    const c = code(l);
    const t = c.match(/(?<![A-Z])T(\d+)/i);
    if (t && /(?<![A-Z])M0*6(?![0-9.])/i.test(c)) tool = t[1];
    if (/(?<![A-Z])G0*43(?![0-9.])/i.test(c)) out.push({ holds: /^G0*0 G43 H(\d+) Z-?[\d.]+/i.test(c) && Number(c.match(/H(\d+)/)?.[1]) === Number(tool), at: i });
  });
  return out;
});
rule('gcode.g43.fanuc', 'gcode', 'FANUC: the length offset is "G00 G43 Z.. H#513 D#513 M254": the offset number comes from #513.', 'G43 lines (FANUC)', (p) =>
  p.fanuc ? g43Lines(p).map((i) => ({ holds: /^G0*0 G43 Z-?[\d.]+ H#513 D#513 M254/i.test(code(p.lines[i])), at: i })) : []);
rule('gcode.g43z50', 'gcode', 'The length offset brings the tool to Z50. (50 mm above program zero) before anything else.', 'G43 lines', (p) =>
  g43Lines(p).map((i) => ({ holds: /(?<![A-Z])Z50\.?(?![0-9])/i.test(code(p.lines[i])), at: i })));
rule('gcode.coolantOnG43', 'gcode', 'The coolant comes on with the length offset: M08 on the G43 line.', 'G43 lines', (p) =>
  g43Lines(p).map((i) => ({ holds: /(?<![A-Z0-9])M0?8(?![0-9])/i.test(code(p.lines[i])), at: i })));
rule('gcode.spindleStart', 'gcode', 'The spindle starts on the positioning move right after the G43 line: "G00 G90 X.. Y.. S.. M03".', 'G43 lines', (p) =>
  g43Lines(p).map((i) => {
    const j = p.lines.findIndex((l, k) => k > i && code(l) !== '');
    return { holds: j > 0 && /^G0*0 G90 X-?[\d.]+ Y-?[\d.]+ S\d+ M0?3$/i.test(code(p.lines[j])), at: j > 0 ? j : i };
  }));
rule('gcode.cycleReturn', 'gcode', 'Drilling and tapping cycles return to the start height (G98), never to R (G99).', 'cycle starts', (p) =>
  cycleLines(p).filter((i) => /G98|G99/.test(code(p.lines[i]))).map((i) => ({ holds: /(?<![A-Z])G98(?![0-9])/i.test(code(p.lines[i])), at: i })));
rule('gcode.cycleR2', 'gcode', 'The R plane of a cycle is R2. (2 mm above Z0); lower R planes are written where the hole starts lower.', 'cycle lines with R', (p) =>
  cycleLines(p).filter((i) => /(?<![A-Z])R-?[\d.]/.test(code(p.lines[i]))).map((i) => ({ holds: /(?<![A-Z])R2\.?(?![0-9])/.test(code(p.lines[i])), at: i })));
rule('gcode.cycleKinds', 'gcode', 'The drilling cycles are G81, G83 (always with a peck Q) and G84 (tapping); G73 is never used.', 'cycle starts', (p) =>
  cycleLines(p).filter((i) => /G98|G99/.test(code(p.lines[i]))).map((i) => ({ holds: /G8[134](?![0-9])/.test(code(p.lines[i])) && !(/G83/.test(code(p.lines[i])) && !/(?<![A-Z])Q[\d.]/.test(code(p.lines[i]))), at: i })));
rule('gcode.cyclesForHoles', 'gcode', 'Holes are spot drilled, drilled and tapped with canned cycles, never long-hand with G01 moves.', 'spot drilling, drilling and tapping operations', (p) =>
  p.read.samples.flatMap((sm, k) => {
    if (!['centre', 'drill', 'tap'].includes(sm.kind)) return [];
    const ms = movesOf(p, k);
    if (!ms.some((m) => m.kind !== 'rapid')) return [];
    return [{ holds: !ms.some((m) => m.kind === 'feed' && m.points.some((q, j) => j > 0 && q[2] < m.points[j - 1][2] - 0.01)), at: sm.line }];
  }));
rule('gcode.arcsIJ', 'gcode', 'Arcs are written with I and J (centre), not with R.', 'arc lines', (p) =>
  p.lines.flatMap((l, i) => (/(?<![A-Z])G0*[23](?![0-9])/i.test(code(l)) && /(?<![A-Z])[IJR]-?[\d.]/i.test(code(l)) ? [{ holds: !/(?<![A-Z])R-?[\d.]/i.test(code(l)), at: i }] : [])));
rule('gcode.noSubprograms', 'gcode', 'No subprograms or macros: the only call is the FANUC table out "M98 P7999" (#513 in the FANUC G43 lines is a value the control holds, not a macro).', 'programs', (p) => {
  const i = first(p, /(?<![A-Z])(?:M97|G65)(?![0-9])|(?<![A-Z])M98\s*P(?!7999)|#\d+\s*=/);
  return [{ holds: i < 0, at: i < 0 ? Math.max(0, oLine(p)) : i }];
});
rule('gcode.motionCodeEveryLine', 'gcode', 'Every motion line carries its motion code (G00, G01, G02, G03), also when it does not change. Not the moves into a drilling cycle (the drop to the R height, the move to the next hole between two cycles): they go on from the G00 before them. Inside a cycle the lines are hole positions. Machine moves (G53, such as the table out G53 Y0) are not counted: they are written without one.', 'motion lines', (p) => {
  const out: Unit[] = [];
  let cyc = false;
  const isCycle = (c: string) => /(?<![A-Z])G(?:73|8[1-9])(?![0-9])/i.test(c);
  p.lines.forEach((l, i) => {
    const c = code(l);
    if (isCycle(c)) cyc = true;
    if (/(?<![A-Z])G80(?![0-9])/i.test(c)) cyc = false;
    if (cyc || !/(?<![A-Z])[XYZ]-?[\d.]/i.test(c) || /(?<![A-Z])G(?:53|52|43|28|92|10|8\d|73)(?![0-9])/i.test(c)) return;
    const next = p.lines.slice(i + 1, i + 4).map(code).find(Boolean) ?? '';
    if (isCycle(next)) return;
    out.push({ holds: /(?<![A-Z])G0*[0-3](?![0-9])/i.test(c), at: i });
  });
  return out;
});
/** Straight moves (G00/G01) outside cycles, with the position before them: for the modal-word rules. */
function straightMoves(p: Program) {
  const out: { i: number; words: [string, number][]; before: Record<string, number | null>; opStart: boolean }[] = [];
  const pos: Record<string, number | null> = { X: null, Y: null, Z: null };
  let motion = -1;
  let cyc = false;
  let sinceOp = 99;
  p.lines.forEach((l, i) => {
    const c = code(l);
    if (/\(TOOLPATH |MIT WERKZEUG/i.test(l) || /(?<![A-Z])M0*6(?![0-9.])/i.test(c)) sinceOp = 0;
    if (/(?<![A-Z])G52(?![0-9])/i.test(c)) {
      pos.X = pos.Y = pos.Z = null;
      return;
    }
    const words = [...c.matchAll(/(?<![A-Z])([XYZ])(-?\d*\.?\d+)/gi)].map((m) => [m[1].toUpperCase(), Number(m[2])] as [string, number]);
    if (/(?<![A-Z])G(?:53|28)(?![0-9])/i.test(c)) {
      for (const [a] of words) pos[a] = null;
      return;
    }
    const g = [...c.matchAll(/(?<![A-Z])G0*(\d+)(?![0-9])/gi)].map((m) => Number(m[1]));
    if (g.some((v) => v === 73 || (v >= 81 && v <= 89))) cyc = true;
    if (g.includes(80)) cyc = false;
    for (const v of g) if (v <= 3) motion = v;
    if (cyc) {
      for (const [a, v] of words) if (a !== 'Z') pos[a] = v;
      return;
    }
    if (!words.length) return;
    if ((motion === 0 || motion === 1) && !g.includes(43)) out.push({ i, words, before: { ...pos }, opStart: ++sinceOp <= 2 || /(?<![A-Z])M0?3(?![0-9])/i.test(c) });
    for (const [a, v] of words) pos[a] = v;
  });
  return out;
}
rule('gcode.onlyChangedAxes', 'gcode', 'A straight move writes only the axes that change: a word repeating the current position is left out. Not the first moves of an operation (the spindle-start line, the first Z move), which state the position in full; arcs write their end point in full.', 'straight move lines', (p) =>
  straightMoves(p).filter((m) => !m.opStart).map((m) => ({ holds: !m.words.some(([a, v]) => m.before[a] !== null && Math.abs((m.before[a] as number) - v) < 1e-6), at: m.i })));
rule('gcode.feedOnlyWhenChanged', 'gcode', 'The feed is written only when it changes (after a tool change or a cycle it is written again).', 'lines with a feed', (p) => {
  const out: Unit[] = [];
  let f: number | null = null;
  p.lines.forEach((l, i) => {
    const c = code(l);
    if (/(?<![A-Z])M0*6(?![0-9.])/i.test(c) || /(?<![A-Z])G(?:73|8\d)(?![0-9])/i.test(c)) {
      f = null;
      return;
    }
    const m = c.match(/(?<![A-Z])F(\d*\.?\d+)/i);
    if (!m) return;
    out.push({ holds: f === null || Number(m[1]) !== f, at: i });
    f = Number(m[1]);
  });
  return out;
});
rule('gcode.shortNumbers', 'gcode', 'Coordinates (X Y Z I J R) are written short: no trailing zeros after the point (X10.5, X10.), no leading zero before it (Z-.6), except the G52 lines (three decimals). Tool numbers after H are zero-padded on HAAS (H03).', 'lines with coordinates', (p) =>
  p.lines.flatMap((l, i) => {
    const c = code(l);
    if (!/(?<![A-Z])[XYZIJR]-?\.?\d/i.test(c) || /(?<![A-Z])G52(?![0-9])/i.test(c)) return [];
    return [{ holds: !/(?<![A-Z])[XYZIJRQ]-?\d*\.\d*0(?![\d])/i.test(c) && !/(?<![A-Z])[XYZIJRQ]-?0\.\d/i.test(c), at: i }];
  }));
rule('gcode.feedDots', 'gcode', 'Whole-number feeds: HAAS writes them with a dot (F3000.), FANUC without (F3000).', 'programs', (p) => {
  const i = first(p, /(?<![A-Z])F\d+\.?(?![\d.])/);
  if (i < 0) return [];
  const dotted = /(?<![A-Z])F\d+\.(?![\d])/.test(code(p.lines[i]));
  return [{ holds: p.fanuc ? !dotted : dotted, at: i }];
});
rule('gcode.end.haas', 'gcode', 'HAAS programs end with "G0 G53 G49 Y0 Z0 M89" (table out, length offset cancelled, through-spindle coolant off), the machining time comment and M30.', 'HAAS programs', (p) => {
  if (p.fanuc) return [];
  const m30 = p.lines.findIndex((l) => /(?<![A-Z])M30(?![0-9])/.test(code(l)));
  const i = first(p, /^G0 G53 G49 Y0 Z0 M(?:89|9)$/, Math.max(0, m30 - 4), m30);
  return [{ holds: i >= 0, at: i >= 0 ? i : Math.max(0, m30) }];
});
rule('gcode.end.fanuc', 'gcode', 'FANUC programs end with the table out "M98 P7999" and M30.', 'FANUC programs', (p) => {
  if (!p.fanuc) return [];
  const m30 = p.lines.findIndex((l) => /(?<![A-Z])M30(?![0-9])/.test(code(l)));
  const i = first(p, /^M98 P7999$/, Math.max(0, m30 - 4), m30);
  return [{ holds: i >= 0, at: i >= 0 ? i : Math.max(0, m30) }];
});
rule('gcode.header', 'gcode', 'The header names the part, its material and finished size, and the saw-cut blank: "(NAME MATERIAL / AxBxC / ZUSCHNITT:DxExF)".', 'programs', (p) => {
  const i = p.lines.slice(0, 15).findIndex((l) => /ZUSCHNITT/i.test(l));
  return [{ holds: i >= 0, at: i >= 0 ? i : Math.max(0, oLine(p)) }];
});
// Arcs against straight lines, per kind of operation (feed lines only).
const arcShare = new Map<string, { arcs: number; lines: number }>();
for (const p of programs)
  p.read.samples.forEach((sm, k) => {
    const a = arcShare.get(sm.kind) ?? { arcs: 0, lines: 0 };
    const counted = new Set<number>();
    for (const m of movesOf(p, k)) {
      if (m.kind !== 'feed' || counted.has(m.line)) continue;
      counted.add(m.line);
      if (/(?<![A-Z])G0*[23](?![0-9])/i.test(code(p.lines[m.line]))) a.arcs++;
      else a.lines++;
    }
    arcShare.set(sm.kind, a);
  });

// ---- Workholding ------------------------------------------------------------------------------------
const notesBefore = (p: Program, g52: number) => {
  const out: string[] = [];
  for (let k = g52 - 1; k >= 0 && k > g52 - 8; k--) {
    const m = p.lines[k].match(/M0*0\s*\(([^)]*)\)/i);
    if (m) out.unshift(m[1].toUpperCase());
    else if (code(p.lines[k])) break;
  }
  return out;
};
// A G52 that puts every shift back to 0 (G52 X0 Y0 Z0) is a reset, not a clamping.
const g52s = (p: Program) => p.lines.flatMap((l, i) => (/(?<![A-Z_])G52(?![0-9]).*[XYZ]-?\d/i.test(code(l)) && !/^G52(\s+[XYZ]-?0+(\.0*)?)+$/i.test(code(l)) ? [i] : []));
rule('workholding.noteBeforeEachClamping', 'workholding', 'Every clamping is announced to the operator: M0 stops with the clamping notes right before its G52.', 'clampings (G52)', (p) =>
  g52s(p).map((i) => ({ holds: notesBefore(p, i).length > 0, at: i })));
rule('workholding.firstZero', 'workholding', 'In the first clamping program zero is either 2 mm inside the X-/Y+ corner of the raw block ("G52 X-48. Y48.") or the centre of the block as clamped.', 'programs', (p) => {
  const i = g52s(p)[0];
  if (i === undefined) return [];
  const c = code(p.lines[i]);
  const x = Number(c.match(/X(-?[\d.]+)/)?.[1]);
  const y = Number(c.match(/Y(-?[\d.]+)/)?.[1]);
  const size = readInstructions(notesBefore(p, i)).sizes;
  if (!size || !Number.isFinite(size.x) || !Number.isFinite(size.y)) return [];
  const centre = Math.abs(x - (-50 + size.x / 2)) <= 0.6 && Math.abs(y - (50 - size.y / 2)) <= 0.6;
  return [{ holds: (x === -48 && y === 48) || centre, at: i }];
});
rule('workholding.firstZeroCorner2mm', 'workholding', 'When the first zero is on a corner, it is 2 mm inside the raw faces: "G52 X-48. Y48.".', 'programs with a corner zero', (p) => {
  const i = g52s(p)[0];
  if (i === undefined) return [];
  const c = code(p.lines[i]);
  const x = Number(c.match(/X(-?[\d.]+)/)?.[1]);
  const y = Number(c.match(/Y(-?[\d.]+)/)?.[1]);
  // A corner zero leaves the stop and the fixed jaw within a few mm: X in -50..-45, Y in 45..50.
  if (!(x <= -45 && x >= -50 && y >= 45 && y <= 50)) return [];
  return [{ holds: x === -48 && y === 48, at: i }];
});
rule('workholding.z0AboveFloor', 'workholding', 'Program Z0 is at least 46 mm above the vise floor (G52 Z of -11 or higher): with 45 mm jaws, at least 1 mm of the part stands above them.', 'clampings (G52)', (p) =>
  g52s(p).flatMap((i) => {
    const z = code(p.lines[i]).match(/Z(-?[\d.]+)/);
    return z ? [{ holds: Number(z[1]) - TABLE_Z >= 46 - 0.01, at: i }] : [];
  }));

/** How a part sits in the vise in one clamping, read by the app (verified programs only). */
interface Held { grip: number; above: number; clearance: number | null; sides: Record<string, number>; spacers: string[]; at: number; deepAt: number }
function held(p: Program): (Held | null)[] {
  return p.an.setups.map((s, k) => {
    if (s.clamp !== 'vise' || !s.stock || s.restZ === null || s.jawTopZ === null || s.support === null) return null;
    const st = s.stock;
    const jawTop = s.jawTopZ;
    // The deepest cut beyond each face of the part (the tool reaching past it).
    const sides: Record<string, number> = {};
    let deepAt = s.line;
    let deepest = Infinity;
    p.tp.moves.forEach((m, i) => {
      if (m.setup !== k || m.kind !== 'feed') return;
      const r = (m.dia ?? p.tp.tools.find((t) => t.tool === m.tool)?.diameter ?? 0) / 2;
      const sm = p.read.samples[p.opOf[i]];
      if (!r || (sm && ['drill', 'centre', 'tap'].includes(sm.kind))) return;
      for (const q of m.points) {
        const past: [string, boolean][] = [
          ['Y-', q[1] - r < st.min[1] - 0.05],
          ['Y+', q[1] + r > st.max[1] + 0.05],
          ['X-', q[0] - r < st.min[0] - 0.05],
          ['X+', q[0] + r > st.max[0] + 0.05],
        ];
        for (const [side, out] of past) {
          if (!out || q[2] >= (sides[side] ?? Infinity)) continue;
          sides[side] = q[2];
          if (side[0] === 'Y' && q[2] < deepest) {
            deepest = q[2];
            deepAt = m.line;
          }
        }
      }
    });
    const y = ['Y-', 'Y+'].filter((f) => f in sides).map((f) => sides[f]);
    return {
      // The jaws hold what is between the parallels and their top (the header's blank size can be off by a mm).
      grip: DEFAULT_JAW_HEIGHT - s.support,
      above: st.max[2] - jawTop,
      clearance: y.length ? Math.min(...y) - jawTop : null,
      sides: Object.fromEntries(Object.entries(sides).map(([f, z]) => [f, z - jawTop])),
      spacers: s.spacers.map((x) => x.side),
      at: s.line,
      deepAt,
    };
  });
}
const helds = new Map(programs.map((p) => [p, verified(p) ? held(p) : []]));
rule('workholding.grip', 'workholding', 'In the vise the part is gripped at least 3 mm deep: it stands on parallels of 42 mm or less in the 45 mm jaws.', 'vise clampings on parallels', (p) =>
  helds.get(p)!.flatMap((h) => (h ? [{ holds: h.grip >= 2.95, at: h.at }] : [])), true);
rule('workholding.outsideCutsAboveJaws', 'workholding', 'Without a spacer, a cut beside the clamped faces (Y) stops above the jaw top, mostly 1 to 2 mm above it: the part is set high enough for its outside contour.', 'vise clampings with such a cut and no spacer', (p) =>
  helds.get(p)!.flatMap((h) => (h && h.clearance !== null && !h.spacers.length ? [{ holds: h.clearance >= -0.05, at: h.deepAt }] : [])), true);
rule('workholding.spacerFreesSide', 'workholding', 'A spacer between the part and a jaw ("15 MM ZWISCHENLAGE IN Y-", "15 MM UNTERLAGE // IN Y-") frees that side: cuts beside that face go below the jaw top.', 'vise clampings with a spacer at Y- or Y+', (p) =>
  helds.get(p)!.flatMap((h) => {
    const ys = h?.spacers.filter((f) => f[0] === 'Y') ?? [];
    return h && ys.length ? [{ holds: ys.some((f) => (h.sides[f] ?? Infinity) < -0.05), at: h.at }] : [];
  }), true);
rule('workholding.firstClampingMostWork', 'workholding', 'The first clamping removes the most material (in the simulation).', 'programs with two clampings or more', (p) =>
  p.removed.length > 1 && p.removed.some((v) => v > 0) ? [{ holds: p.removed[0] >= Math.max(...p.removed) - 1e-6, at: p.an.setups[0]?.line ?? 0 }] : [], true);
rule('workholding.secondTurnedOver', 'workholding', 'The second clamping turns the part over: 180° about X or about Y.', 'programs with two clampings or more', (p) => {
  const s = p.an.setups[1];
  if (!s) return [];
  const o = s.orient.join(',');
  return [{ holds: o === '1,0,0,0,-1,0,0,0,-1' || o === '-1,0,0,0,1,0,0,0,-1', at: s.line }];
}, true);
rule('workholding.longSideAlongX', 'workholding', 'The part lies with its longer side along X, along the jaws.', 'vise clampings', (p) =>
  p.an.setups.flatMap((s) => (s.clamp === 'vise' && s.stock ? [{ holds: s.stock.max[0] - s.stock.min[0] >= s.stock.max[1] - s.stock.min[1] - 0.01, at: s.line }] : [])), true);

// Facts about the clampings (notes as the app reads them; geometry from verified programs only).
const parallels = new Map<number, { n: number; at: Cite }>();
const spacerNotes = new Map<string, { n: number; at: Cite }>();
const rests: Cite[] = [];
let clampingCount = 0;
for (const p of programs) {
  for (const s of p.tp.setups) {
    if (!s.notes.length) continue;
    clampingCount++;
    const ins = readInstructions(s.notes.map((n) => n.text));
    const noteAt = (re: RegExp) => s.notes.find((n) => re.test(n.text.toUpperCase()))?.line ?? s.line;
    // Each cited with the note that says it: its number and, for a spacer, its side.
    const sayingIt = (mm: number, kind: RegExp, side = '') =>
      s.notes.find((n) => kind.test(n.text.toUpperCase()) && new RegExp(`(?<![\\d.])${mm}(?![\\d])`).test(n.text) && n.text.replace(/\s+/g, '').includes(side))?.line ?? s.line;
    if (ins.support !== null) parallels.set(ins.support, { n: (parallels.get(ins.support)?.n ?? 0) + 1, at: parallels.get(ins.support)?.at ?? cite(p, sayingIt(ins.support, /UNTERLAGE|CALE|CALCO/)) });
    for (const sp of ins.spacers) {
      const k = `${sp.mm} mm at ${sp.side}`;
      spacerNotes.set(k, { n: (spacerNotes.get(k)?.n ?? 0) + 1, at: spacerNotes.get(k)?.at ?? cite(p, sayingIt(sp.mm, /ZWISCHENLAGE|UNTERLAGE|CAL/, sp.side)) });
    }
    if (ins.restDepth !== null && rests.length < 3) rests.push(cite(p, noteAt(/EP|MASS|BASE|\/\s*IN\s*\d/)));
  }
}
const heldAll = programs.flatMap((p) => helds.get(p)!.filter((h): h is Held => !!h));
const turnPatterns = new Map<string, number>();
const sideNotes = { firstBack: 0, firstFront: 0, laterBack: 0, laterFront: 0 };
for (const p of programs.filter(verified)) {
  if (p.an.setups.length < 2) continue;
  const k = p.an.setups.slice(1).map((s) => s.turns.map((t) => `${t.axis}${t.deg}`).join(' ') || '-').join(' > ');
  turnPatterns.set(k, (turnPatterns.get(k) ?? 0) + 1);
  p.an.setups.forEach((s, j) => {
    if (s.side === 'back') sideNotes[j ? 'laterBack' : 'firstBack']++;
    if (s.side === 'front') sideNotes[j ? 'laterFront' : 'firstFront']++;
  });
}
const multi = programs.filter((p) => verified(p) && p.removed.length > 1 && p.removed.some((v) => v > 0));
const firstSide = {
  programs: multi.length,
  firstRemovesMost: multi.filter((p) => p.removed[0] >= Math.max(...p.removed) - 1e-6).length,
  firstHasMostOperations: multi.filter((p) => {
    const n = p.an.setups.map((_, k) => p.read.samples.filter((s) => s.setup === k).length);
    return n[0] >= Math.max(...n);
  }).length,
  firstDrillsMostHoles: multi.filter((p) => {
    const n = p.an.setups.map((_, k) => p.tp.moves.filter((m) => m.setup === k && m.kind === 'drill').length);
    return n[0] >= Math.max(...n) && n[0] > 0;
  }).length,
  lastStartsByFacing: multi.filter((p) => p.read.order.at(-1)?.[0] === 'face').length,
};

// ---- Strategy -----------------------------------------------------------------------------------------
/** The operations of each clamping, in order, with their lines. */
const clampOps = (p: Program) => {
  const by: Sample[][] = p.read.order.map(() => []);
  for (const s of p.read.samples) by[s.setup]?.push(s);
  return by.filter((o) => o.length);
};
rule('strategy.faceFirst', 'strategy', 'Each program starts by facing the top (PLAN / MESSERKOPF) in its first clamping.', 'programs', (p) => {
  const o = clampOps(p)[0];
  return o ? [{ holds: o[0].kind === 'face', at: o[0].line }] : [];
});
/** The operations of each clamping as the app cuts the program (its setups), in order. */
const opsInSetup = (p: Program) => {
  const by: Sample[][] = p.tp.setups.map(() => []);
  const at = new Map<number, number>();
  p.tp.moves.forEach((m, i) => {
    if (p.opOf[i] >= 0 && m.kind !== 'rapid' && !at.has(p.opOf[i])) at.set(p.opOf[i], m.setup);
  });
  p.read.samples.forEach((s, k) => {
    if (at.has(k)) by[at.get(k)!]?.push(s);
  });
  return by;
};
/** How clamping k is turned from the one before: over (the top goes down), on an edge (a quarter turn), or not. */
const turnOf = (p: Program, k: number) => {
  const [a, b] = [p.an.setups[k - 1].orient, p.an.setups[k].orient];
  // The part's direction that points up is the orientation's third row.
  const d = a[6] * b[6] + a[7] * b[7] + a[8] * b[8];
  return d < -0.5 ? 'over' : Math.abs(d) < 0.5 ? 'edge' : 'same';
};
rule('strategy.faceAfterTurnOver', 'strategy', 'A clamping that turns the part over starts by facing its new top (the part is brought to thickness).', 'clampings turned over', (p) => {
  const ops = opsInSetup(p);
  return p.an.setups.flatMap((_, k) => (k > 0 && ops[k]?.length && turnOf(p, k) === 'over' ? [{ holds: ops[k][0].kind === 'face', at: ops[k][0].line }] : []));
}, true);
rule('strategy.noFaceOnEdge', 'strategy', 'A clamping that stands the part on an edge (a quarter turn) does not face.', 'clampings on an edge', (p) => {
  const ops = opsInSetup(p);
  return p.an.setups.flatMap((_, k) => (k > 0 && ops[k]?.length && turnOf(p, k) === 'edge' ? [{ holds: !ops[k].some((o) => o.kind === 'face'), at: ops[k][0].line }] : []));
}, true);
rule('strategy.chamferLast', 'strategy', 'Chamfering and deburring (FASE / ENTGRATEN) come last in their clamping.', 'clampings that chamfer', (p) =>
  clampOps(p).filter((o) => o.some((s) => s.kind === 'chamfer')).map((o) => {
    // Operations of no known kind (T_NUT, TASTER...) do not count.
    const after = o.findIndex((s, k) => s.kind !== 'chamfer' && s.kind !== 'other' && o.slice(0, k).some((x) => x.kind === 'chamfer'));
    return { holds: after < 0, at: after < 0 ? o.find((s) => s.kind === 'chamfer')!.line : o[after].line };
  }));
// The order the library shows: holes before milling (face, spot, drill, tap, then pockets/contours/finishing/counterbores, chamfers last).
const RANK: Partial<Record<OpKind, number>> = { face: 0, centre: 1, drill: 2, tap: 3, pocket: 4, contour: 4, finish: 4, counterbore: 4, chamfer: 5 };
// Holes against milling in the clampings that have both (counterbores with the milling, as in the rule).
const holesFirst = (() => {
  const c = { both: 0, holesFirst: 0, millingFirst: 0 };
  for (const p of programs)
    for (const o of clampOps(p)) {
      const h = o.flatMap((s, k) => (['centre', 'drill', 'tap'].includes(s.kind) ? [k] : []));
      const m = o.flatMap((s, k) => (['pocket', 'contour', 'finish', 'counterbore'].includes(s.kind) ? [k] : []));
      if (!h.length || !m.length) continue;
      c.both++;
      if (Math.max(...h) < Math.min(...m)) c.holesFirst++;
      if (Math.max(...m) < Math.min(...h)) c.millingFirst++;
    }
  return c;
})();
rule('strategy.order', 'strategy', `Within a clamping: face, spot drill, drill, tap; then pockets, contours, finishing and counterbores (in any order among them); chamfers and deburring last. Holes come before milling: of the ${holesFirst.both} clampings with both, ${holesFirst.holesFirst} make all their holes first, ${holesFirst.millingFirst} all their milling first.`, 'clampings', (p) =>
  clampOps(p).filter((o) => o.length > 1).map((o) => {
    const rank = o.map((s) => RANK[s.kind] ?? -1);
    const bad = rank.findIndex((v, k) => v >= 0 && rank.slice(0, k).some((w) => w > v));
    return { holds: bad < 0, at: bad < 0 ? o[0].line : o[bad].line };
  }));
rule('strategy.roughThenFinish', 'strategy', 'In a clamping that roughs (pockets, contours) and finishes (SCHLICHT), its last finishing pass comes after its first roughing one. (Which roughing each finishing pass belongs to is not read.)', 'clampings with both', (p) =>
  clampOps(p).filter((o) => o.some((s) => s.kind === 'finish') && o.some((s) => s.kind === 'pocket' || s.kind === 'contour')).map((o) => {
    const lastFinish = o.map((s) => s.kind).lastIndexOf('finish');
    const firstRough = o.findIndex((s) => s.kind === 'pocket' || s.kind === 'contour');
    return { holds: lastFinish > firstRough, at: o[lastFinish].line };
  }));
rule('strategy.preFaceThenFinal', 'strategy', 'A pre-facing pass (VORPLAN) is followed by a final facing pass (FERTIGPLAN) in the same clamping.', 'pre-facing passes', (p) =>
  p.read.samples.flatMap((s, k) => (/^VORPLAN/.test(s.op) ? [{ holds: p.read.samples.some((x, j) => j > k && x.setup === s.setup && /^FERTIGPLAN/.test(x.op)), at: s.line }] : [])));

/** Holes made by cycles, with what was done at them in order (same clamping, same X/Y). */
interface HoleStep { kind: OpKind; type: string; d: number; cycle: string; depth: number; /** The hole's line, and the line of the cycle it is in (cited). */ line: number; start: number }
interface Hole { steps: HoleStep[]; /** A later milling pass of the clamping runs over it (the hole lies in a pocket or contour milled after it). */ milled: boolean }
/** Whether a milling pass (pocket, contour, finish) after line `after` covers X/Y below `top`, in that clamping. */
function millingAt(p: Program) {
  const grids = new Map<number, Map<string, [number, number, number, number, number][]>>();
  p.tp.moves.forEach((m, i) => {
    const sm = p.read.samples[p.opOf[i]];
    if (m.kind !== 'feed' || !sm || !['pocket', 'contour', 'finish'].includes(sm.kind)) return;
    const r = (m.dia ?? sm.d) / 2;
    const g = grids.get(m.setup) ?? grids.set(m.setup, new Map()).get(m.setup)!;
    for (let j = 1; j < m.points.length; j++) {
      const [a, b] = [m.points[j - 1], m.points[j]];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.5));
      for (let t = 0; t <= n; t++) {
        const q: [number, number, number, number, number] = [a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n, a[2] + ((b[2] - a[2]) * t) / n, r, m.line];
        const key = `${Math.floor(q[0] / 2)}|${Math.floor(q[1] / 2)}`;
        (g.get(key) ?? g.set(key, []).get(key)!).push(q);
      }
    }
  });
  return (setup: number, x: number, y: number, top: number, after: number) => {
    const g = grids.get(setup);
    if (!g) return false;
    for (let gx = Math.floor(x / 2) - 6; gx <= Math.floor(x / 2) + 6; gx++)
      for (let gy = Math.floor(y / 2) - 6; gy <= Math.floor(y / 2) + 6; gy++)
        for (const q of g.get(`${gx}|${gy}`) ?? []) if (q[4] > after && q[2] < top - 0.5 && Math.hypot(q[0] - x, q[1] - y) <= q[3] - 0.1) return true;
    return false;
  };
}
function holes(p: Program): Hole[] {
  const milledAt = millingAt(p);
  const where = new Map<string, { setup: number; x: number; y: number; top: number }>();
  const by = new Map<string, HoleStep[]>();
  p.tp.moves.forEach((m, i) => {
    if (m.kind !== 'drill') return;
    const sm = p.read.samples[p.opOf[i]];
    if (!sm) return;
    const [x, y, r] = m.points[0];
    const key = `${m.setup}|${x.toFixed(2)}|${y.toFixed(2)}`;
    // From the hole's top (2 mm under the R plane) to its bottom.
    const c = p.cycle[m.line];
    const step: HoleStep = { kind: sm.kind, type: sm.type, d: sm.d, cycle: c.code, depth: round(r - 2 - (m.depth ?? r), 100), line: m.line, start: c.at >= 0 ? c.at : m.line };
    (by.get(key) ?? by.set(key, []).get(key)!).push(step);
    if (!where.has(key)) where.set(key, { setup: m.setup, x, y, top: r - 2 });
  });
  return [...by].map(([key, steps]) => {
    const w = where.get(key)!;
    const last = steps.filter((s) => s.kind === 'drill').at(-1) ?? steps[0];
    return { steps, milled: milledAt(w.setup, w.x, w.y, w.top, last.line) };
  });
}
const holeList = new Map(programs.map((p) => [p, holes(p)]));
const spotted = (h: HoleStep[]) => {
  const d = h.findIndex((s) => s.kind === 'drill');
  return d >= 0 && h.slice(0, d).some((s) => s.kind === 'centre');
};
rule('strategy.spotSmallDrills', 'strategy', 'A hole drilled under 4 mm is spot drilled first (ZENTRIER / NC-ANBOHREN, same clamping); from 4 mm up it is drilled without spot drilling. 4 mm is the size that best separates the library\'s holes.', 'drilled holes', (p) =>
  holeList.get(p)!.flatMap(({ steps: h }) => {
    const d = h.findIndex((s) => s.kind === 'drill');
    return d < 0 ? [] : [{ holds: spotted(h) === h[d].d < 4, at: h[d].start }];
  }));
rule('strategy.drillBeforeTap', 'strategy', 'A tapped hole is drilled first (the core hole), in the same clamping.', 'tapped holes', (p) =>
  holeList.get(p)!.flatMap(({ steps: h }) => {
    const t = h.findIndex((s) => s.kind === 'tap');
    return t < 0 ? [] : [{ holds: h.slice(0, t).some((s) => s.kind === 'drill'), at: h[t].start }];
  }));
rule('strategy.drillG83', 'strategy', 'Holes are drilled with G83 and a peck, whatever their depth; G81 is for spot drilling only.', 'drilling steps', (p) =>
  holeList.get(p)!.flatMap(({ steps }) => steps.flatMap((s) => (s.kind === 'drill' ? [{ holds: s.cycle === 'G83', at: s.start }] : s.kind === 'centre' ? [{ holds: s.cycle === 'G81', at: s.start }] : []))));
// The cycle each drilled hole gets, by depth over diameter.
const drillCycles: { cycle: string; ratio: number }[] = [];
for (const p of programs) for (const h of holeList.get(p)!) for (const s of h.steps) if (s.kind === 'drill' && s.d > 0 && s.depth > 0) drillCycles.push({ cycle: s.cycle, ratio: s.depth / s.d });
const ratioBands = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 7], [7, 10], [10, 100]].map(([lo, hi]) => {
  const sub = drillCycles.filter((c) => c.ratio > lo && c.ratio <= hi);
  return { depthOverDiameter: `${lo}–${hi}`, holes: sub.length, G81: sub.filter((c) => c.cycle === 'G81').length, G83: sub.filter((c) => c.cycle === 'G83').length };
});
// The recipes of holes: what is done at one hole, in order.
const recipes = new Map<string, { holes: number; parts: Set<string>; at: Cite }>();
const stepName = (s: HoleStep) => (s.kind === 'centre' ? `spot ${s.cycle}` : s.kind === 'drill' ? `drill ${s.cycle}` : s.kind === 'tap' ? `tap ${s.cycle}` : `${s.kind} ${s.cycle}`);
for (const p of programs)
  for (const { steps: h, milled } of holeList.get(p)!) {
    const k = `${h.map(stepName).join(' > ')}${milled ? ' (then milled over)' : ''}`;
    const r = recipes.get(k) ?? { holes: 0, parts: new Set<string>(), at: cite(p, h[0].start) };
    r.holes++;
    r.parts.add(p.part);
    recipes.set(k, r);
  }
// Core drill for each tap, and the spot drill for each drill size.
const tapCores = new Map<string, { n: number; at: Cite }>();
const spots = new Map<string, number>();
const band = (d: number) => (d < 3 ? 'under 3' : d < 6 ? '3 to 6' : d < 10 ? '6 to 10' : '10 and over');
for (const p of programs)
  for (const { steps: h } of holeList.get(p)!) {
    const t = h.find((s) => s.kind === 'tap');
    const d = [...h].reverse().find((s) => s.kind === 'drill');
    const c = h.find((s) => s.kind === 'centre');
    if (t) {
      const k = `tap Ø${t.d}: core drill ${d ? `Ø${d.d}` : 'none'}`;
      tapCores.set(k, { n: (tapCores.get(k)?.n ?? 0) + 1, at: tapCores.get(k)?.at ?? cite(p, t.start) });
    }
    if (d && c) {
      const k = `${c.type} Ø${c.d} for drills of Ø ${band(d.d)} mm`;
      spots.set(k, (spots.get(k) ?? 0) + 1);
    }
  }

/** The value most of `v` give (0.01 apart, its neighbours counted with it), and their share. */
function mostOf(v: number[]): { value: number; share: number } {
  const c = new Map<number, number>();
  for (const x of v) c.set(Math.round(x * 100), (c.get(Math.round(x * 100)) ?? 0) + 1);
  let best = { value: 0, share: 0 };
  for (const k of c.keys()) {
    const n = (c.get(k - 1) ?? 0) + c.get(k)! + (c.get(k + 1) ?? 0);
    if (n / v.length > best.share) best = { value: k / 100, share: n / v.length };
  }
  return best;
}

/**
 * What a finishing pass leaves to the roughing before it (same clamping). On the walls: the distance
 * between the two tool centres less the difference of their radii (the roughing tool stays that much
 * further from the wall), where the finishing tool cuts (one height, below the part's top) within
 * reach of the roughing; the pass's value is the one most of its points give. On the floor: at the
 * pass's lowest level, how much higher the roughing over the same spot stopped. "rest": no value for
 * most points (corners and notches the roughing tool could not reach); "out of reach": the roughing
 * never ran near it. Corner-rounding cutters (a description without a diameter) finish no wall.
 */
interface Allowance { kind: 'allowance' | 'rest' | 'out of reach' | 'edge or 3D' | 'not a wall'; wall: number | null; floor: number | null; d: number; points: number; at: number }
function allowances(p: Program): Allowance[] {
  const out: Allowance[] = [];
  const samples = p.read.samples;
  samples.forEach((f, fi) => {
    if (f.kind !== 'finish' || !(f.d > 0)) return;
    const fm = movesOf(p, fi).filter((m) => m.kind === 'feed');
    if (!fm.length) return;
    // Edge rounding (radius cutters) and 3D finishing (ball mills, Z-level, cavity) follow no wall of the roughing.
    if (f.type === 'UDM' || f.type === 'KF' || /RADIUS|ZLEVEL|FIXED_CONTOUR|CAVITY/.test(f.op)) {
      out.push({ kind: 'edge or 3D', wall: null, floor: null, d: f.d, points: 0, at: f.line });
      return;
    }
    const setup = fm[0].setup;
    const rough = samples.flatMap((s, i) => (i < fi && s.setup === f.setup && (s.kind === 'pocket' || s.kind === 'contour') ? [i] : []));
    const cell = 2;
    const grid = new Map<string, [number, number, number, number][]>();
    for (const i of rough)
      for (const m of movesOf(p, i)) {
        if (m.kind !== 'feed' || m.setup !== setup) continue;
        const rr = (m.dia ?? samples[i].d) / 2;
        for (let j = 1; j < m.points.length; j++) {
          const [a, b] = [m.points[j - 1], m.points[j]];
          const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25));
          for (let t = 0; t <= n; t++) {
            const q: [number, number, number, number] = [a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n, a[2] + ((b[2] - a[2]) * t) / n, rr];
            const key = `${Math.floor(q[0] / cell)}|${Math.floor(q[1] / cell)}`;
            (grid.get(key) ?? grid.set(key, []).get(key)!).push(q);
          }
        }
      }
    const rf = f.d / 2;
    const walls: number[] = [];
    const floors: { z: number; low: number }[] = [];
    let zLow = Infinity;
    for (const m of fm)
      for (let j = 1; j < m.points.length; j++) {
        const [a, b] = [m.points[j - 1], m.points[j]];
        // Cutting at one height, below the part's top (not the links over it).
        if (Math.abs(a[2] - b[2]) > 0.01 || a[2] > -0.01) continue;
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.5));
        for (let t = 0; t <= n; t++) {
          const x = a[0] + ((b[0] - a[0]) * t) / n;
          const y = a[1] + ((b[1] - a[1]) * t) / n;
          let best = Infinity;
          let rr = 0;
          let low = Infinity;
          const reach = Math.ceil((rf + 10) / cell);
          for (let gx = Math.floor(x / cell) - reach; gx <= Math.floor(x / cell) + reach; gx++)
            for (let gy = Math.floor(y / cell) - reach; gy <= Math.floor(y / cell) + reach; gy++)
              for (const q of grid.get(`${gx}|${gy}`) ?? []) {
                const d = Math.hypot(q[0] - x, q[1] - y);
                if (d < best) {
                  best = d;
                  rr = q[3];
                }
                if (d < q[3]) low = Math.min(low, q[2]);
              }
          if (best > rr + rf + 1.5) continue;
          walls.push(best - (rr - rf));
          zLow = Math.min(zLow, a[2]);
          if (low < Infinity) floors.push({ z: a[2], low });
        }
      }
    if (walls.length < 20) {
      out.push({ kind: 'out of reach', wall: null, floor: null, d: f.d, points: walls.length, at: f.line });
      return;
    }
    const wall = mostOf(walls);
    const atFloor = floors.filter((x) => Math.abs(x.z - zLow) < 0.011).map((x) => x.low - x.z);
    const floor = atFloor.length ? mostOf(atFloor) : null;
    const held = wall.share >= 0.5;
    // More than a millimetre off the roughing is no finishing allowance: the pass skims a floor or a step away from the wall.
    const kind = !held ? 'rest' : wall.value > 1 ? 'not a wall' : 'allowance';
    // A floor below the pass's lowest level (the roughing went deeper there): the pass ends above the floor.
    const onFloor = kind === 'allowance' && floor && floor.share >= 0.5 && floor.value >= -0.05 ? floor.value : null;
    out.push({ kind, wall: kind === 'allowance' ? wall.value : null, floor: onFloor, d: f.d, points: walls.length, at: f.line });
  });
  return out;
}
// Each part once (its first program: a twin finishes the same way).
const allowanceList = programs.filter((p, k) => programs.findIndex((q) => q.part === p.part) === k).flatMap((p) => allowances(p).map((a) => ({ p, a })));

// ---- Tools and cutting data ---------------------------------------------------------------------------
rule('tools.codeFormat', 'tools', 'Tools are named by a code TYPE_D.DD_LLL_GGG_MAT (a copy carries a number after it, "_1"): type (MK face mill, SF end mill, SB drill, ZB or AB spot drill, GB tap, ST chamfer/graver...), diameter, length, and the material its data is for.', 'tool changes', (p) =>
  toolChanges(p).map((i) => ({ holds: /[A-Z]{2,3}_\d+\.\d{2}_\d{3}_[A-Z0-9]+_[A-Z]+(?:_\d+)?\s*\)/.test(p.lines.slice(i, i + 3).join(' ')), at: i + 1 })));
rule('tools.dataForPartMaterial', 'tools', "The tool's cutting data is for the part's material: the code's material is the header's.", 'operations', (p) =>
  p.read.material ? p.read.samples.map((s) => ({ holds: s.material === p.read.material, at: s.line })) : []);
// How much longer than its deepest cut a tool is, per type.
const reachByType = new Map<string, number[]>();
for (const p of programs) for (const s of p.read.samples) if (s.length > 0 && s.depth > 0) (reachByType.get(s.type) ?? reachByType.set(s.type, []).get(s.type)!).push(round(s.length - s.depth));

interface Stat { median: number; min: number; max: number; n: number; mode: number; modeShare: number }
const stat = (v: number[]): Stat | null => {
  if (!v.length) return null;
  const c = new Map<number, number>();
  for (const x of v) c.set(x, (c.get(x) ?? 0) + 1);
  const [mode, n] = [...c].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return { median: median(v), min: Math.min(...v), max: Math.max(...v), n: v.length, mode, modeShare: round(n / v.length, 100) };
};
// Only the values an operation of that kind has: no peck for milling, no step-over for drills.
const MILLING = new Set<OpKind>(['face', 'pocket', 'contour', 'finish', 'counterbore', 'chamfer']);
const cutting = new Map<string, { s: number[]; f: number[]; fz: number[]; ap: number[]; ae: number[]; q: number[]; parts: Set<string>; files: Set<string>; codeMaterials: Set<string> }>();
for (const p of programs) {
  for (const sm of p.read.samples) {
    const material = p.read.material ?? sm.material;
    const key = `${material}|${sm.type}|${sm.d}|${sm.kind}`;
    const c = cutting.get(key) ?? { s: [], f: [], fz: [], ap: [], ae: [], q: [], parts: new Set<string>(), files: new Set<string>(), codeMaterials: new Set<string>() };
    if (sm.s) c.s.push(sm.s);
    if (sm.f) c.f.push(sm.f);
    if (sm.fz) c.fz.push(sm.fz);
    if (sm.ap && MILLING.has(sm.kind)) c.ap.push(sm.ap);
    if (sm.ae && MILLING.has(sm.kind)) c.ae.push(sm.ae);
    if (sm.q && sm.kind === 'drill') c.q.push(sm.q);
    c.parts.add(p.part);
    c.files.add(p.file);
    c.codeMaterials.add(sm.material);
    cutting.set(key, c);
  }
}
/** Label of one value of the table: one part (seen once), or how many operations share its most common value. */
const valueLabel = (s: Stat | null, parts: number) => (!s ? '' : parts === 1 ? 'seen once' : s.modeShare === 1 ? 'consistent across the library' : s.modeShare > 0.5 ? 'majority' : 'varies');
const cuttingData = [...cutting.entries()]
  .map(([k, c]) => {
    const [material, type, d, kind] = k.split('|');
    const rpm = stat(c.s);
    const feed = stat(c.f);
    return {
      material,
      type,
      d: Number(d),
      kind,
      operations: Math.max(c.s.length, c.f.length, c.q.length),
      parts: c.parts.size,
      rpm,
      rpmLabel: valueLabel(rpm, c.parts.size),
      feed,
      feedLabel: valueLabel(feed, c.parts.size),
      plunge: stat(c.fz),
      depthPerPass: stat(c.ap),
      stepOver: stat(c.ae),
      peck: stat(c.q),
      toolCodeMaterials: [...c.codeMaterials].sort(),
      sources: [...c.files].sort().slice(0, 5),
    };
  })
  .sort((a, b) => a.material.localeCompare(b.material) || a.type.localeCompare(b.type) || a.d - b.d || a.kind.localeCompare(b.kind));

// ---- The shop's words (told by the shop) ----------------------------------------------------------------
const told = [
  {
    words: 'N MM UNTERLAGE // IN Y- (or X-, Y+...)',
    meaning: 'A spacer N mm thick in the jaw on that side, pushing the part N mm away from that jaw. Not the parallels under the part.',
    source: 'Told by the shop, 21.11.2026',
    re: /UNTERLAGE\s*\/\/\s*(?:IN\s*)?[XY]\s*[+-]/i,
  },
  {
    words: 'N IN X/Y',
    meaning: 'The part is N mm in X and N mm in Y. 50 IN X/Y, 50 x 50 mm, is one of the standard sizes of the top plates.',
    source: 'Told by the shop, 21.11.2026',
    re: /\d+(?:[.,]\d+)?\s*IN\s*X\s*\/\s*Y(?!\s*[+-])/i,
  },
].map(({ re, ...t }) => {
  const at: Cite[] = [];
  for (const p of programs) {
    const i = p.lines.findIndex((l) => re.test(l));
    if (i >= 0 && at.length < 3) at.push(cite(p, i));
  }
  return { ...t, programs: programs.filter((p) => p.lines.some((l) => re.test(l))).length, examples: at };
});

// ---- Output --------------------------------------------------------------------------------------------
const partsOf = (ps: Program[]) => new Set(ps.map((p) => p.part)).size;
const facts = {
  programs: programs.length,
  parts: partsOf(programs),
  haas: programs.filter((p) => !p.fanuc).length,
  fanuc: programs.filter((p) => p.fanuc).length,
  verifiedPrograms: programs.filter(verified).length,
  clampings: clampingCount,
  setupsPerProgram: Object.fromEntries([...programs.reduce((m, p) => m.set(p.read.setups, (m.get(p.read.setups) ?? 0) + 1), new Map<number, number>())].sort((a, b) => a[0] - b[0])),
  parallels: [...parallels].sort((a, b) => a[0] - b[0]).map(([mm, v]) => ({ mm, clampings: v.n, example: v.at })),
  spacers: [...spacerNotes].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => ({ spacer: k, clampings: v.n, example: v.at })),
  restNotes: rests,
  vise: {
    clampings: heldAll.length,
    gripMm: hist(heldAll.map((h) => h.grip)),
    aboveJawsMm: hist(heldAll.map((h) => h.above), 5),
    outsideCutAboveJawsMm: hist(heldAll.filter((h) => h.clearance !== null && !h.spacers.length).map((h) => h.clearance!), 0.5),
  },
  turns: [...turnPatterns].sort((a, b) => b[1] - a[1]).map(([turns, n]) => ({ turns, programs: n })),
  sideNotes,
  firstSide,
  rawAllowance: (() => {
    const a = programs.flatMap((p) => (p.read.raw && p.read.size ? [[...p.read.raw].sort((x, y) => x - y).map((r, k) => round(r - [...p.read.size!].sort((x, y) => x - y)[k]))] : []));
    return a.length ? { programs: a.length, medianPerAxisSmallestFirst: [0, 1, 2].map((k) => median(a.map((x) => x[k]))) } : null;
  })(),
  holeRecipes: [...recipes].sort((a, b) => b[1].holes - a[1].holes).map(([recipe, r]) => ({ recipe, holes: r.holes, parts: r.parts.size, example: r.at })),
  drillCycleByDepth: ratioBands,
  tapCores: [...tapCores].sort((a, b) => b[1].n - a[1].n).map(([pair, v]) => ({ pair, holes: v.n, example: v.at })),
  spotDrills: [...spots].sort((a, b) => b[1] - a[1]).map(([spot, n]) => ({ spot, holes: n })),
  finishingAllowance: (() => {
    const held = allowanceList.filter((x) => x.a.kind === 'allowance');
    const byTool = new Map<number, number[]>();
    for (const x of held) (byTool.get(x.a.d) ?? byTool.set(x.a.d, []).get(x.a.d)!).push(x.a.wall!);
    return {
      passes: allowanceList.length,
      parts: new Set(allowanceList.map((x) => x.p.part)).size,
      allowance: held.length,
      rest: allowanceList.filter((x) => x.a.kind === 'rest').length,
      outOfReach: allowanceList.filter((x) => x.a.kind === 'out of reach').length,
      edgeOr3D: allowanceList.filter((x) => x.a.kind === 'edge or 3D').length,
      notAWall: allowanceList.filter((x) => x.a.kind === 'not a wall').length,
      wallMm: hist(held.map((x) => x.a.wall!), 0.05),
      floorMm: hist(held.filter((x) => x.a.floor !== null).map((x) => x.a.floor!), 0.05),
      floorVaries: held.filter((x) => x.a.floor === null).length,
      wallByTool: [...byTool].sort((p, q) => p[0] - q[0]).map(([d, v]) => ({ d, passes: v.length, wallMm: hist(v, 0.05) })),
      passesList: allowanceList.map((x) => ({ ...cite(x.p, x.a.at), kind: x.a.kind, d: x.a.d, wall: x.a.wall, floor: x.a.floor, points: x.a.points })),
    };
  })(),
  g43Heights: [...programs.reduce((m, p) => {
    for (const i of g43Lines(p)) {
      const z = code(p.lines[i]).match(/(?<![A-Z])Z(-?\d*\.?\d+)/i)?.[1];
      if (z) m.set(Number(z), (m.get(Number(z)) ?? 0) + 1);
    }
    return m;
  }, new Map<number, number>())].sort((a, b) => b[1] - a[1]),
  toolLongerThanCutMm: Object.fromEntries([...reachByType].sort().map(([t, v]) => [t, stat(v)])),
  arcsPerKind: Object.fromEntries([...arcShare].map(([k, v]) => [k, { arcLines: v.arcs, straightLines: v.lines }])),
};
const parts = programs.map((p) => ({
  file: p.file,
  dialect: p.fanuc ? 'FANUC' : 'HAAS',
  type: p.type,
  material: p.read.material,
  finished: p.read.size,
  raw: p.read.raw,
  match: p.match,
  setups: p.read.setups,
  clampings: p.an.setups.map((s, k) => {
    const h = helds.get(p)![k];
    return { parallels: readInstructions(s.notes).support, turns: s.turns.map((t) => `${t.axis}${t.deg}`).join(' ') || null, spacers: s.spacers.map((x) => `${x.mm} mm ${x.side}`), grip: h ? round(h.grip) : null, aboveJaws: h ? round(h.above) : null, removedCm3: round((p.removed[k] ?? 0) / 1000) };
  }),
  operations: p.read.order.map((o) => o.join(' > ')),
  toolChanges: toolChanges(p).length,
  cycles: cycleLines(p).length,
  lines: p.lines.length,
}));
const types = [...new Set(programs.map((p) => p.type))].sort();
const byType = rules
  .filter((r) => r.topic !== 'gcode')
  .map((r) => ({
    id: r.id,
    rule: r.rule,
    perType: Object.fromEntries(
      types.map((t) => {
        const one = RULES.get(r.id)!;
        return [t, count(one.units, one.verifiedOnly, (p) => p.type === t).parts];
      }),
    ),
  }));
const top = <K>(m: Map<K, number>, n = 3) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
const families = types.map((t) => {
  const ps = programs.filter((p) => p.type === t);
  const sup = new Map<number, number>();
  const mats = new Map<string, number>();
  const setups = new Map<number, number>();
  const rec = new Map<string, number>();
  for (const p of ps) {
    for (const s of p.an.setups) {
      const v = readInstructions(s.notes).support;
      if (v !== null) sup.set(v, (sup.get(v) ?? 0) + 1);
    }
    mats.set(p.read.material ?? '?', (mats.get(p.read.material ?? '?') ?? 0) + 1);
    setups.set(p.read.setups, (setups.get(p.read.setups) ?? 0) + 1);
    for (const { steps: h } of holeList.get(p)!) {
      const k = h.map(stepName).join(' > ');
      rec.set(k, (rec.get(k) ?? 0) + 1);
    }
  }
  return { family: t, programs: ps.length, parts: partsOf(ps), materials: top(mats, 4), setups: top(setups, 4), parallels: top(sup, 4), holeRecipes: top(rec, 3) };
});
mkdirSync('docs/knowledge', { recursive: true });
writeFileSync(
  'docs/knowledge/knowledge.json',
  `${JSON.stringify({ source: 'reference library, each distinct program once, rules labelled per part; cited as <program file>:<line>', told, facts, rules, byType, families, cuttingData, parts }, null, 1)}\n`,
);

// ---- The readable document ---------------------------------------------------------------------------
const c2 = (c: Cite) => `\`${c.file}:${c.line}\` \`${c.text}\``;
const md: string[] = [
  '# How the shop programs: the reference library, counted',
  '',
  `Generated by \`npm run knowledge -- <library folder>\` from ${facts.programs} distinct programs (${facts.haas} HAAS, ${facts.fanuc} FANUC dialect) of ${facts.parts} parts. The library stays outside the repository; programs are cited as \`<file>:<line>\` with the line's text, header lines with the part's name masked.`,
  '',
  `**Labels**, per part (a part's HAAS and FANUC programs and its other versions are one part): **consistent across the library** (every part the rule applies to follows it everywhere), **majority** (more than half of the parts), **minority** (half or fewer), **seen once** (it applies to one part). Each rule also counts the places it applies to (lines, clampings, holes...). Rules marked *(verified programs)* are read through the app's simulation and use only the ${facts.verifiedPrograms} programs whose simulated part matches their 3D model. The data is in \`knowledge.json\`.`,
  '',
  "## The shop's words",
  '',
];
for (const t of told) md.push(`- **${t.words}**: ${t.meaning} *${t.source}*; ${t.programs ? `written in ${t.programs} programs, e.g. ${t.examples.map(c2).join('; ')}` : "not written in the library's programs, the app reads it so"}.`);
md.push('');
const topics: [Topic, string][] = [['workholding', 'Workholding'], ['strategy', 'Strategy'], ['tools', 'Tools and cutting data'], ['gcode', 'G-code style']];
const ruleLine = (r: Rule) => `- **${r.rule}**${r.verifiedOnly ? ' *(verified programs)*' : ''} (${r.label}: ${r.parts.holds} of ${r.parts.applies} parts; ${r.units.holds} of ${r.units.applies} ${r.unit})`;
for (const [topic, title] of topics) {
  md.push(`## ${title}`, '');
  if (topic === 'workholding') {
    const v = facts.vise;
    md.push(
      `- Clampings with notes: ${facts.clampings}. Setups per program: ${Object.entries(facts.setupsPerProgram).map(([k, n]) => `${k} setups ${n}`).join(', ')}.`,
      `- Parallels (UNTERLAGE, CALE, CALCO), per clamping, as the app reads the notes: ${facts.parallels.map((x) => `${x.mm} mm ×${x.clampings}`).join(', ')}.`,
      `- Spacers between the part and a jaw or the stop: ${facts.spacers.map((x) => `${x.spacer} ×${x.clampings} (${c2(x.example)})`).join('; ') || 'none'}.`,
      `- In the vise (${v.clampings} clampings of verified programs): gripped ${v.gripMm.map(([mm, n]) => `${mm} mm ×${n}`).join(', ')}; the part's top above the jaws (5 mm steps) ${v.aboveJawsMm.map(([mm, n]) => `${mm} ×${n}`).join(', ')}.`,
      `- Without a spacer, how far above the jaw top the deepest cut beside the clamped faces stops (0.5 mm steps): ${v.outsideCutAboveJawsMm.map(([mm, n]) => `${mm} ×${n}`).join(', ')}.`,
      `- Turns of the later clampings (verified programs with two or more): ${facts.turns.slice(0, 8).map((t) => `${t.turns} ×${t.programs}`).join('; ')}.`,
      `- Which side first (${facts.firstSide.programs} verified programs with two clampings or more): the first clamping removes the most material in ${facts.firstSide.firstRemovesMost}, has the most operations in ${facts.firstSide.firstHasMostOperations}, drills the most holes in ${facts.firstSide.firstDrillsMostHoles}; the last clamping starts by facing in ${facts.firstSide.lastStartsByFacing}. Notes name the side in few programs: first clamping RUECKS. (back) ${facts.sideNotes.firstBack}, FRONTSEITE ${facts.sideNotes.firstFront}; later clampings back ${facts.sideNotes.laterBack}, front ${facts.sideNotes.laterFront}. These are counts, not a reason: why a side goes first is an open question for the shop.`,
    );
    if (facts.rawAllowance) md.push(`- Raw blank minus finished part, per axis (smallest first), median over ${facts.rawAllowance.programs} programs: ${facts.rawAllowance.medianPerAxisSmallestFirst.join(' / ')} mm.`);
    md.push('');
  }
  for (const r of rules.filter((x) => x.topic === topic)) {
    md.push(ruleLine(r));
    for (const c of r.examples) md.push(`  - ${c2(c)}`);
    if (r.exceptions.length) md.push(`  - Exceptions: ${r.exceptions.map(c2).join('; ')}`);
  }
  if (topic === 'strategy') {
    md.push('', '### Holes', '', 'What is done at one hole position of a clamping, in order (cycles only), over the whole library. "Then milled over": a pocket or contour of the clamping is milled over the hole afterwards (holes come first, see the order rule).', '', '| Recipe | Holes | Parts | Example |', '|---|---|---|---|');
    for (const r of facts.holeRecipes.slice(0, 15)) md.push(`| ${r.recipe} | ${r.holes} | ${r.parts} | ${c2(r.example)} |`);
    md.push('', 'Drilling cycle by depth over diameter (depth from 2 mm under the R plane):', '', '| Depth / Ø | Holes | G81 | G83 |', '|---|---|---|---|');
    for (const b of facts.drillCycleByDepth) if (b.holes) md.push(`| ${b.depthOverDiameter} | ${b.holes} | ${b.G81} | ${b.G83} |`);
    md.push('', `Tapped holes, tap and core drill: ${facts.tapCores.map((t) => `${t.pair} ×${t.holes} (${c2(t.example)})`).join('; ') || 'none'}.`, '', `Spot drills used: ${facts.spotDrills.slice(0, 8).map((s) => `${s.spot} ×${s.holes}`).join('; ')}.`);
    const fa = facts.finishingAllowance;
    md.push(
      '',
      '### Roughing and finishing',
      '',
      `What a finishing pass (SCHLICHT...) leaves to the roughing before it in its clamping, measured on the tool centres (cutter compensation applied) where it cuts within reach of the roughing: ${fa.passes} finishing passes of ${fa.parts} parts (twins once). ${fa.allowance} follow a roughing along their wall; ${fa.rest} mostly clear corners and notches the roughing tool could not reach (rest machining); ${fa.outOfReach} work where no roughing ran (cut from solid); ${fa.notAWall} run more than 1 mm off the roughing (a floor or a step, no wall); ${fa.edgeOr3D} round edges or finish 3D surfaces (radius cutters, ball mills, Z-level, cavity) and follow no wall.`,
      '',
      `- On the walls (the value most of a pass's points give, 0.05 mm steps): ${fa.wallMm.map(([mm, n]) => `${mm} ×${n}`).join(', ')}.`,
      `- By finishing tool: ${fa.wallByTool.map((t) => `Ø${t.d}: ${t.wallMm.map(([mm, n]) => `${mm} ×${n}`).join(', ')}`).join('; ')}.`,
      `- On the floor (at the pass's lowest level, how much higher the roughing stopped): ${fa.floorMm.map(([mm, n]) => `${mm} ×${n}`).join(', ')}; ${fa.floorVaries} passes end above the roughing's floor (they finish only the top of a wall).`,
      `- Examples: ${fa.passesList.filter((e) => e.kind === 'allowance').slice(0, 5).map((e) => `\`${e.file}:${e.line}\` Ø${e.d} wall ${e.wall}, floor ${e.floor ?? '–'}`).join('; ')}.`,
      '- A measurement of the paths, not a value the programs write.',
    );
  }
  if (topic === 'tools') {
    md.push(
      '',
      `How much longer the tool is than its deepest cut (mm), per type: ${Object.entries(facts.toolLongerThanCutMm).map(([t, s]) => (s ? `${t} median ${s.median} (${s.min}–${s.max}, ${s.n} operations)` : '')).filter(Boolean).join('; ')}.`,
      '',
      "Cutting data per part material (the header's), tool type, Ø and kind of operation, as the app's learning reader (`src/lib/cam/learn.ts`) reads each operation: the most common value with its share of the operations, then median and range. The label is the rpm's and the feed's: **consistent** (one value), **majority** (one value for more than half of the operations), **varies**, **seen once** (one part). Depth per pass and step-over are given for milling only, the peck for drilling only. Where the tool's code is for another material, it is named.",
      '',
      '| Material | Type | Ø | Kind | Ops | Parts | rpm | Feed mm/min | Plunge | Depth per pass | Step-over | Peck | Label (rpm / feed) |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    );
    const f = (s: Stat | null) => (s ? `${s.mode} (${Math.round(s.modeShare * 100)}%; ${s.median}, ${s.min}–${s.max})` : '–');
    const g = (s: Stat | null) => (s ? `${s.median} (${s.min}–${s.max})` : '–');
    for (const c of cuttingData)
      md.push(`| ${c.material}${c.toolCodeMaterials.some((m) => m !== c.material) ? ` (code ${c.toolCodeMaterials.join('/')})` : ''} | ${c.type} | ${c.d} | ${c.kind} | ${c.operations} | ${c.parts} | ${f(c.rpm)} | ${f(c.feed)} | ${g(c.plunge)} | ${g(c.depthPerPass)} | ${g(c.stepOver)} | ${g(c.peck)} | ${c.rpmLabel} / ${c.feedLabel} |`);
  }
  if (topic === 'gcode') md.push('', `Heights the length offset line goes to (G43 ... Z): ${facts.g43Heights.slice(0, 10).map(([z, n]) => `Z${z} ×${n}`).join(', ')}. Why some operations start higher than Z50 is not clear from the programs: an open question.`);
  if (topic === 'gcode') md.push('', `Arcs against straight lines among feed lines, per kind of operation: ${Object.entries(facts.arcsPerKind).map(([k, v]) => `${k} ${v.arcLines} arcs / ${v.straightLines} lines`).join('; ')}.`);
  md.push('');
}
md.push('## By part family', '', "Families from the part's name (src/lib/cam/partType.ts). Per family: programs, parts, materials, setups per program, parallels per clamping and the hole recipes most used.", '');
for (const f of families)
  md.push(
    `- **${f.family}**: ${f.programs} programs, ${f.parts} parts. Materials ${f.materials.map(([k, n]) => `${k} ${n}`).join(', ')}. Setups ${f.setups.map(([k, n]) => `${k}: ${n}`).join(', ')}. Parallels ${f.parallels.map(([k, n]) => `${k} mm ×${n}`).join(', ') || '–'}. Holes ${f.holeRecipes.map(([k, n]) => `${k} ×${n}`).join('; ') || '–'}.`,
  );
md.push('', 'Each rule recounted per family (parts that follow it / parts it applies to):', '', `| Rule | ${types.join(' | ')} |`, `|---|${types.map(() => '---').join('|')}|`);
for (const b of byType) md.push(`| ${b.id} | ${types.map((t) => (b.perType[t].applies ? `${b.perType[t].holds}/${b.perType[t].applies}` : '–')).join(' | ')} |`);
md.push(
  '',
  '## Per program',
  '',
  'Match: how alike the simulated part and the 3D model are (library snapshot). Per clamping: parallels, turn, spacers, grip in the jaws and top above the jaws (mm, verified programs), material removed (cm³). Operations per clamping, in order (consecutive same kinds once).',
  '',
  '| Program | Dialect | Family | Material | Finished | Blank | Match | Clampings | Operations | Tool changes | Cycle lines | Lines |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
);
for (const q of parts)
  md.push(
    `| ${q.file} | ${q.dialect} | ${q.type} | ${q.material ?? '–'} | ${q.finished?.join('x') ?? '–'} | ${q.raw?.join('x') ?? '–'} | ${q.match ?? '–'} | ${q.clampings.map((c, k) => `${k + 1}: ${c.parallels ?? '–'} mm${c.turns ? `, ${c.turns}` : ''}${c.spacers.length ? `, spacer ${c.spacers.join(' ')}` : ''}${c.grip !== null ? `, grip ${c.grip}, top +${c.aboveJaws}` : ''}, ${c.removedCm3} cm³`).join('<br>')} | ${q.operations.map((o, k) => `${k + 1}: ${o}`).join('<br>')} | ${q.toolChanges} | ${q.cycles} | ${q.lines} |`,
  );
md.push('');
writeFileSync('docs/knowledge/README.md', md.join('\n'));
console.log(`${programs.length} programs, ${facts.parts} parts (${facts.verifiedPrograms} verified), ${rules.length} rules, ${cuttingData.length} cutting data rows`);
for (const r of rules) console.log(`${r.label.padEnd(30)} parts ${String(r.parts.holds).padStart(3)}/${String(r.parts.applies).padEnd(3)} units ${String(r.units.holds).padStart(6)}/${String(r.units.applies).padEnd(6)} ${r.id}`);
