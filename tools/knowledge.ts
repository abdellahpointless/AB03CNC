/**
 * How the shop's CAM engineers program, read from the reference library (Phase 3 of the library
 * work): workholding, strategy, tools and cutting data, and G-code style.
 *
 * Every rule is counted over the library's distinct programs (a copy of a program counts once) and
 * labelled by how many of the programs it applies to follow it: "consistent across the library"
 * (all of them), "majority" (more than half), "minority", or "seen once" (it applies to one
 * program). Each cites programs by file and line, with the line's text, never by order (the
 * repository is public). Nothing here changes CAM AI: shopKnowledge.json is not touched.
 *
 *   npm run knowledge -- <library folder>
 *
 * Writes docs/knowledge/knowledge.json (the data) and docs/knowledge/README.md (the readable form).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProgram, type PartRead } from '../src/lib/cam/learn';
import { partTypeOf } from '../src/lib/cam/partType';

const LIB = process.argv[2];
if (!LIB) throw new Error('usage: npm run knowledge -- <library folder>');

interface Program { file: string; lines: string[]; fanuc: boolean; read: PartRead; type: string }
interface Cite { file: string; line: number; text: string }
type Topic = 'workholding' | 'strategy' | 'tools' | 'gcode';
interface Rule { id: string; topic: Topic; rule: string; unit: string; applies: number; holds: number; label: string; examples: Cite[]; exceptions: Cite[] }

// ---- The programs ------------------------------------------------------------------------------
const programs: Program[] = [];
const seen = new Set<string>();
for (const folder of readdirSync(LIB).sort()) {
  const dir = join(LIB, folder);
  if (!/^\d+_/.test(folder) || !statSync(dir).isDirectory()) continue;
  for (const file of readdirSync(dir).sort()) {
    const path = join(dir, file);
    if (file === 'info.json' || !statSync(path).isFile()) continue;
    const bytes = readFileSync(path);
    const text = bytes.toString('latin1');
    if (text.startsWith('%PDF-') || !/[GMT]\d/.test(text)) continue;
    const hash = createHash('sha1').update(bytes).digest('hex');
    if (seen.has(hash)) continue;
    seen.add(hash);
    const lines = text.replace(/\r/g, '').split('\n');
    // The family from the part's name on the header's size line (the name itself is not kept).
    const named = lines.slice(0, 15).find((l) => /\d\s*X\s*\d+(?:[.,]\d+)?\s*X\s*\d/i.test(l))?.replace(/^\s*N\d+\s*/, '').replace(/^\(/, '').split('/')[0] ?? '';
    programs.push({ file, lines, fanuc: /H#513|M254|G94\s+M95/.test(text), read: readProgram(text, file), type: partTypeOf(named) ?? 'other' });
  }
}

const code = (l: string) => l.replace(/\([^)]*\)?/g, ' ').replace(/^\s*N\d+/i, '').trim();
const cite = (p: Program, i: number): Cite => ({ file: p.file, line: i + 1, text: p.lines[i].trim().slice(0, 90) });
const label = (applies: number, holds: number) =>
  applies === 1 ? 'seen once' : holds === applies ? 'consistent across the library' : holds * 2 > applies ? 'majority' : 'minority';

const rules: Rule[] = [];
/**
 * A rule checked unit by unit: `units` gives, per program, each unit it applies to (a program, a
 * tool change, a cycle line...) with whether it holds and the line to cite.
 */
const RULES = new Map<string, (p: Program) => { holds: boolean; at: number }[]>();
function rule(id: string, topic: Topic, text: string, unit: string, units: (p: Program) => { holds: boolean; at: number }[]) {
  RULES.set(id, units);
  const r: Rule = { id, topic, rule: text, unit, applies: 0, holds: 0, label: '', examples: [], exceptions: [] };
  for (const p of programs) {
    for (const u of units(p)) {
      r.applies++;
      if (u.holds) r.holds++;
      const list = u.holds ? r.examples : r.exceptions;
      // One citation per program, three at most.
      if (list.length < 3 && !list.some((c) => c.file === p.file)) list.push(cite(p, u.at));
    }
  }
  r.label = label(r.applies, r.holds);
  if (r.applies) rules.push(r);
}
const first = (p: Program, re: RegExp, from = 0, to = p.lines.length) => {
  for (let i = from; i < Math.min(to, p.lines.length); i++) if (re.test(code(p.lines[i]))) return i;
  return -1;
};
const toolChanges = (p: Program) => p.lines.flatMap((l, i) => (/(?<![A-Z])M0*6(?![0-9.])/i.test(code(l)) && /(?<![A-Z])T\d+/i.test(code(l)) ? [i] : []));
const g43Lines = (p: Program) => p.lines.flatMap((l, i) => (/(?<![A-Z])G0*43(?![0-9.])/i.test(code(l)) ? [i] : []));
const cycleLines = (p: Program) => p.lines.flatMap((l, i) => (/(?<![A-Z])G(?:73|8[1-9])(?![0-9])/i.test(code(l)) ? [i] : []));
const oLine = (p: Program) => p.lines.findIndex((l) => /^\s*O\d/i.test(l));

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
rule('gcode.operationName', 'gcode', 'Each tool change is announced by the operation name: a "(TOOLPATH NAME)" comment right before "T.. M6".', 'tool changes', (p) =>
  toolChanges(p).map((i) => ({ holds: i > 0 && /\(TOOLPATH /i.test(p.lines[i - 1]), at: i - 1 >= 0 ? i - 1 : i })));
rule('gcode.toolComment', 'gcode', 'After "T.. M6" the tool is described: "(NAME / CODE)" with a code like SF_10.00_030_000_AL, then "(DIAMETER d MM/LENGTH l MM)".', 'tool changes', (p) =>
  toolChanges(p).map((i) => {
    const next = p.lines.slice(i + 1, i + 4).join(' ');
    return { holds: /[A-Z]{2}_\d+\.\d+_\d+/.test(next) && /\(DIAMETER\s+[\d.]+ MM\/LENGTH\s+[\d.]+ MM\)/i.test(next), at: i + 1 };
  }));
rule('gcode.g43.haas', 'gcode', 'HAAS: the length offset is "G00 G43 H<tool> Z.." with H the number of the tool in the spindle.', 'G43 lines (HAAS)', (p) => {
  if (p.fanuc) return [];
  let tool = '';
  const out: { holds: boolean; at: number }[] = [];
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
rule('gcode.cycleKinds', 'gcode', 'Spot drilling uses G81, drilling G83 (pecking with Q), tapping G84; G73 is not used.', 'cycle starts', (p) =>
  cycleLines(p).filter((i) => /G98|G99/.test(code(p.lines[i]))).map((i) => ({ holds: /G8[134](?![0-9])/.test(code(p.lines[i])) && !(/G83/.test(code(p.lines[i])) && !/(?<![A-Z])Q[\d.]/.test(code(p.lines[i]))), at: i })));
rule('gcode.arcsIJ', 'gcode', 'Arcs are written with I and J (centre), not with R.', 'arc lines', (p) =>
  p.lines.flatMap((l, i) => (/(?<![A-Z])G0*[23](?![0-9])/i.test(code(l)) && /(?<![A-Z])[IJR]-?[\d.]/i.test(code(l)) ? [{ holds: !/(?<![A-Z])R-?[\d.]/i.test(code(l)), at: i }] : [])));
rule('gcode.noSubprograms', 'gcode', 'No subprograms or macros: the only call is the FANUC table out "M98 P7999".', 'programs', (p) => {
  const i = first(p, /(?<![A-Z])(?:M97|G65)(?![0-9])|(?<![A-Z])M98\s*P(?!7999)/);
  return [{ holds: i < 0, at: i < 0 ? Math.max(0, oLine(p)) : i }];
});
rule('gcode.motionCodeEveryLine', 'gcode', 'Every motion line carries its motion code (G00, G01, G02, G03), also when it does not change (outside drilling cycles, whose lines are hole positions).', 'motion lines', (p) => {
  const out: { holds: boolean; at: number }[] = [];
  let cycle = false;
  p.lines.forEach((l, i) => {
    const c = code(l);
    if (/(?<![A-Z])G(?:73|8[1-9])(?![0-9])/i.test(c)) cycle = true;
    if (/(?<![A-Z])G80(?![0-9])/i.test(c)) cycle = false;
    if (cycle || !/(?<![A-Z])[XYZ]-?[\d.]/i.test(c) || /(?<![A-Z])G(?:53|52|43|28|92|10|8\d|73)(?![0-9])/i.test(c)) return;
    out.push({ holds: /(?<![A-Z])G0*[0-3](?![0-9])/i.test(c), at: i });
  });
  return out;
});
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
const g52s = (p: Program) => p.lines.flatMap((l, i) => (/(?<![A-Z_])G52(?![0-9]).*[XYZ]-?\d/i.test(code(l)) ? [i] : []));
rule('workholding.noteBeforeEachClamping', 'workholding', 'Every clamping is announced to the operator: M0 stops with the clamping notes right before its G52.', 'clampings (G52)', (p) =>
  g52s(p).map((i) => ({ holds: notesBefore(p, i).length > 0, at: i })));
rule('workholding.firstZero', 'workholding', 'In the first clamping program zero is either 2 mm inside the X-/Y+ corner of the raw block ("G52 X-48. Y48.") or the centre of the block as clamped.', 'programs', (p) => {
  const i = g52s(p)[0];
  if (i === undefined) return [];
  const c = code(p.lines[i]);
  const x = Number(c.match(/X(-?[\d.]+)/)?.[1]);
  const y = Number(c.match(/Y(-?[\d.]+)/)?.[1]);
  const size = notesBefore(p, i).join(' ').match(/(\d+(?:\.\d+)?)\s*(?:IN|UM)\s*X\s*(?:UND|AND)?\s*(\d+(?:\.\d+)?)\s*(?:IN|UM)\s*Y/);
  if (!size) return [];
  const centre = Math.abs(x - (-50 + Number(size[1]) / 2)) <= 0.6 && Math.abs(y - (50 - Number(size[2]) / 2)) <= 0.6;
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
    return z ? [{ holds: Number(z[1]) + 57 >= 46 - 0.01, at: i }] : [];
  }));
const parallels = new Map<number, { n: number; at: Cite }>();
const rests: Cite[] = [];
const spacers = new Map<string, { n: number; at: Cite }>();
let clampings = 0;
for (const p of programs) {
  for (const i of g52s(p)) {
    clampings++;
    const t = notesBefore(p, i).join(' / ');
    const u = t.match(/(\d+(?:[.,]\d+)?)\s*MM\s*UNTERLAGE(?!\s*\/?\s*(?:IN|EN|SUR|AUF)\s*[XY]\s*[+-])/);
    if (u) {
      const h = Number(u[1].replace(',', '.'));
      parallels.set(h, { n: (parallels.get(h)?.n ?? 0) + 1, at: parallels.get(h)?.at ?? cite(p, i - 1) });
    }
    if (/IN\s*EP|SUR\s*EP|UNTER\s*MASS|IN\s*MASS|UNTERLAGE\s*MASS|\/\s*IN\s*\d|NA\s*BASE/.test(t) && rests.length < 3) rests.push(cite(p, i - 1));
    for (const m of t.matchAll(/(\d+)\s*MM\s*ZWISCHENLAGE\s*(?:IN\s*)?([XY][+-])/g)) {
      const k = `${m[1]} mm ${m[2]}`;
      spacers.set(k, { n: (spacers.get(k)?.n ?? 0) + 1, at: spacers.get(k)?.at ?? cite(p, i - 1) });
    }
  }
}
const setupsPerProgram = new Map<number, number>();
for (const p of programs) setupsPerProgram.set(p.read.setups, (setupsPerProgram.get(p.read.setups) ?? 0) + 1);
const allowance: number[][] = [];
for (const p of programs) {
  if (!p.read.raw || !p.read.size) continue;
  const raw = [...p.read.raw].sort((a, b) => a - b);
  const fin = [...p.read.size].sort((a, b) => a - b);
  allowance.push(raw.map((r, k) => Math.round((r - fin[k]) * 10) / 10));
}
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

// ---- Strategy -----------------------------------------------------------------------------------------
const ORDER = ['face', 'pocket', 'contour', 'finish', 'centre', 'drill', 'counterbore', 'tap', 'chamfer'];
rule('strategy.faceFirst', 'strategy', 'Each program starts by facing the top (PLAN / MESSERKOPF) in its first clamping.', 'programs', (p) => {
  const first0 = p.read.order[0]?.[0] ?? p.read.order.find((o) => o.length)?.[0];
  const i = p.lines.findIndex((l) => /\(TOOLPATH /i.test(l));
  return first0 ? [{ holds: first0 === 'face', at: Math.max(0, i) }] : [];
});
rule('strategy.faceEachSide', 'strategy', 'Each later clamping also starts by facing (the new top is brought to size first).', 'later clampings', (p) =>
  p.read.order.slice(1).filter((o) => o.length).map((o, k) => ({ holds: o[0] === 'face', at: g52s(p)[k + 1] ?? 0 })));
rule('strategy.centreBeforeDrill', 'strategy', 'Holes are spot drilled (ZENTRIER) before they are drilled, in the same clamping.', 'clampings that drill', (p) =>
  p.read.order.filter((o) => o.includes('drill')).map((o) => ({ holds: o.includes('centre') && o.indexOf('centre') < o.indexOf('drill'), at: Math.max(0, p.lines.findIndex((l) => /\(TOOLPATH BOHREN/i.test(l))) })));
rule('strategy.chamferLast', 'strategy', 'Chamfering and deburring (FASE / ENTGRATEN) come last in their clamping.', 'clampings that chamfer', (p) =>
  p.read.order.filter((o) => o.includes('chamfer')).map((o) => ({ holds: o[o.length - 1] === 'chamfer', at: Math.max(0, p.lines.findIndex((l) => /\(TOOLPATH (FASE|ENTGRATEN)/i.test(l))) })));
rule('strategy.order', 'strategy', 'Within a clamping the operations follow: face, pocket/contour, finish, spot drill, drill, counterbore, tap, chamfer.', 'clampings', (p) =>
  p.read.order.filter((o) => o.length > 1).map((o) => {
    const ix = o.map((k) => ORDER.indexOf(k)).filter((v) => v >= 0);
    // Pockets and contours are one rank.
    const rank = ix.map((v) => (v === 2 ? 1 : v));
    return { holds: rank.every((v, k) => k === 0 || v >= rank[k - 1]), at: Math.max(0, p.lines.findIndex((l) => /\(TOOLPATH /i.test(l))) };
  }));

rule('strategy.roughThenFinish', 'strategy', 'Pockets and contours are roughed first and finished (SCHLICHT) after, in the same clamping.', 'clampings with both', (p) =>
  p.read.order.filter((o) => o.includes('finish') && (o.includes('pocket') || o.includes('contour'))).map((o) => ({ holds: o.lastIndexOf('finish') > Math.max(o.indexOf('pocket'), o.indexOf('contour')), at: Math.max(0, p.lines.findIndex((l) => /\(TOOLPATH SCHL/i.test(l))) })));
rule('strategy.preFaceThenFinal', 'strategy', 'A pre-facing pass (VORPLAN) is followed by a final facing pass (FERTIGPLAN) in the same clamping.', 'pre-facing passes', (p) =>
  p.lines.flatMap((l, i) => {
    if (!/\(TOOLPATH VORPLAN/i.test(l)) return [];
    // An operation named right before a clamping's notes and G52 belongs to that clamping.
    const gs = g52s(p);
    const own = gs.find((g) => g > i && g - i <= 12) ?? i;
    const next = gs.find((g) => g > own) ?? p.lines.length;
    return [{ holds: p.lines.slice(i + 1, next).some((x) => /\(TOOLPATH FERTIGPLAN/i.test(x)), at: i }];
  }));

// ---- Tools and cutting data ---------------------------------------------------------------------------
rule('tools.codeFormat', 'tools', 'Tools are named by a code TYPE_D.DD_LLL_GGG_MAT: type (MK face mill, SF end mill, SB drill, ZB spot drill, GB tap, ST chamfer...), diameter, length, and the material its data is for.', 'tool changes', (p) =>
  toolChanges(p).map((i) => ({ holds: /[A-Z]{2}_\d+\.\d{2}_\d{3}_[A-Z0-9]+_[A-Z]+/.test(p.lines.slice(i, i + 3).join(' ')), at: i + 1 })));
const cutting = new Map<string, { s: number[]; f: number[]; ap: number[]; ae: number[]; q: number[]; files: Set<string> }>();
for (const p of programs) {
  for (const sm of p.read.samples) {
    const key = `${sm.material}|${sm.type}|${sm.d}`;
    const c = cutting.get(key) ?? { s: [], f: [], ap: [], ae: [], q: [], files: new Set<string>() };
    if (sm.s) c.s.push(sm.s);
    if (sm.f) c.f.push(sm.f);
    if (sm.ap) c.ap.push(sm.ap);
    if (sm.ae) c.ae.push(sm.ae);
    if (sm.q) c.q.push(sm.q);
    c.files.add(p.file);
    cutting.set(key, c);
  }
}
const stat = (v: number[]) => (v.length ? { median: median(v), min: Math.min(...v), max: Math.max(...v), n: v.length } : null);
const cuttingData = [...cutting.entries()]
  .map(([k, c]) => {
    const [material, type, d] = k.split('|');
    return { material, type, d: Number(d), programs: c.files.size, label: c.files.size === 1 ? 'seen once' : c.files.size * 2 > programs.length ? 'majority' : `${c.files.size} programs`, rpm: stat(c.s), feed: stat(c.f), depthPerPass: stat(c.ap), stepOver: stat(c.ae), peck: stat(c.q), sources: [...c.files].sort().slice(0, 5) };
  })
  .sort((a, b) => a.material.localeCompare(b.material) || a.type.localeCompare(b.type) || a.d - b.d);

// ---- Output --------------------------------------------------------------------------------------------
const facts = {
  programs: programs.length,
  haas: programs.filter((p) => !p.fanuc).length,
  fanuc: programs.filter((p) => p.fanuc).length,
  clampings,
  setupsPerProgram: Object.fromEntries([...setupsPerProgram].sort((a, b) => a[0] - b[0])),
  parallels: [...parallels].sort((a, b) => a[0] - b[0]).map(([mm, v]) => ({ mm, clampings: v.n, example: v.at })),
  restNotes: rests,
  spacers: [...spacers].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => ({ spacer: k, clampings: v.n, example: v.at })),
  rawAllowance: allowance.length ? { programs: allowance.length, medianPerAxisSmallestFirst: [0, 1, 2].map((k) => median(allowance.map((a) => a[k]))) } : null,
};
const parts = programs.map((p) => ({
  file: p.file,
  dialect: p.fanuc ? 'FANUC' : 'HAAS',
  type: p.type,
  material: p.read.material,
  finished: p.read.size,
  raw: p.read.raw,
  setups: p.read.setups,
  parallels: g52s(p).map((i) => Number(notesBefore(p, i).join(' ').match(/(\d+(?:[.,]\d+)?)\s*MM\s*UNTERLAGE/)?.[1].replace(',', '.') ?? NaN)).map((v) => (Number.isFinite(v) ? v : null)),
  operations: p.read.order.map((o) => o.join(' > ')),
  toolChanges: toolChanges(p).length,
  cycles: cycleLines(p).length,
  lines: p.lines.length,
}));
const types = [...new Set(programs.map((p) => p.type))].sort();
const byType = rules
  .filter((r) => r.topic !== 'gcode')
  .map((r) => ({ id: r.id, rule: r.rule, perType: Object.fromEntries(types.map((t) => {
    // Recount the rule over this family's programs only.
    const sub = { holds: 0, applies: 0 };
    const keep = programs.filter((p) => p.type === t);
    const one = RULES.get(r.id)!;
    for (const p of keep) for (const u of one(p)) { sub.applies++; if (u.holds) sub.holds++; }
    return [t, sub];
  })) }));
mkdirSync('docs/knowledge', { recursive: true });
writeFileSync('docs/knowledge/knowledge.json', `${JSON.stringify({ source: 'reference library, each distinct program once; cited as <program file>:<line>', facts, rules, byType, cuttingData, parts }, null, 1)}\n`);

const md: string[] = [
  '# How the shop programs: the reference library, counted',
  '',
  `Generated by \`npm run knowledge -- <library folder>\` from ${facts.programs} distinct programs (${facts.haas} HAAS, ${facts.fanuc} FANUC dialect). The library itself stays outside the repository; programs are cited as \`<file>:<line>\` with the line's text. Labels: **consistent** (every program or line the rule applies to), **majority** (more than half), **minority**, **seen once**. The data is in \`knowledge.json\`.`,
  '',
];
const topics: [Topic, string][] = [['workholding', 'Workholding'], ['strategy', 'Strategy'], ['tools', 'Tools and cutting data'], ['gcode', 'G-code style']];
for (const [topic, title] of topics) {
  md.push(`## ${title}`, '');
  if (topic === 'workholding') {
    md.push(`- Clampings: ${facts.clampings}. Setups per program: ${Object.entries(facts.setupsPerProgram).map(([k, v]) => `${k} setups ${v}`).join(', ')}.`);
    md.push(`- Parallels (UNTERLAGE) used, per clamping: ${facts.parallels.map((x) => `${x.mm} mm ×${x.clampings}`).join(', ')}.`);
    md.push(`- Spacers (ZWISCHENLAGE): ${facts.spacers.map((x) => `${x.spacer} ×${x.clampings} (\`${x.example.file}:${x.example.line}\`)`).join(', ') || 'none'}.`);
    if (facts.rawAllowance) md.push(`- Raw blank minus finished part, per axis (smallest first), median over ${facts.rawAllowance.programs} programs: ${facts.rawAllowance.medianPerAxisSmallestFirst.join(' / ')} mm.`);
    md.push('');
  }
  for (const r of rules.filter((x) => x.topic === topic)) {
    md.push(`- **${r.rule}** (${r.label}: ${r.holds} of ${r.applies} ${r.unit})`);
    for (const c of r.examples) md.push(`  - \`${c.file}:${c.line}\` \`${c.text}\``);
    if (r.exceptions.length) md.push(`  - Exceptions: ${r.exceptions.map((c) => `\`${c.file}:${c.line}\` \`${c.text}\``).join('; ')}`);
  }
  if (topic === 'tools') {
    md.push('', 'Cutting data per material (from the tool code), tool type and Ø, as the app\'s learning reader (`src/lib/cam/learn.ts`) reads each operation: median and range over the operations.', '', '| Material | Type | Ø | Programs | rpm (median, range) | Feed mm/min (median, range) | Depth per pass | Step-over | Peck |', '|---|---|---|---|---|---|---|---|---|');
    const f = (s: ReturnType<typeof stat>) => (s ? `${s.median} (${s.min}–${s.max})` : '–');
    for (const c of cuttingData) md.push(`| ${c.material} | ${c.type} | ${c.d} | ${c.programs} | ${f(c.rpm)} | ${f(c.feed)} | ${f(c.depthPerPass)} | ${f(c.stepOver)} | ${f(c.peck)} |`);
  }
  md.push('');
}
md.push('## By part family', '', `Families from the part's name (src/lib/cam/partType.ts): ${types.map((t) => `${t} ${programs.filter((p) => p.type === t).length}`).join(', ')}. Each cell: holds / applies.`, '', `| Rule | ${types.join(' | ')} |`, `|---|${types.map(() => '---').join('|')}|`);
for (const b of byType) md.push(`| ${b.id} | ${types.map((t) => (b.perType[t].applies ? `${b.perType[t].holds}/${b.perType[t].applies}` : '–')).join(' | ')} |`);
md.push('', '## Per program', '', 'Operations per clamping, in order (consecutive same kinds once).', '', '| Program | Dialect | Family | Material | Finished | Blank | Setups | Parallels per clamping | Operations | Tool changes | Cycle lines | Lines |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const q of parts) md.push(`| ${q.file} | ${q.dialect} | ${q.type} | ${q.material ?? '–'} | ${q.finished?.join('x') ?? '–'} | ${q.raw?.join('x') ?? '–'} | ${q.setups} | ${q.parallels.map((v) => v ?? '–').join(', ')} | ${q.operations.map((o, k) => `${k + 1}: ${o}`).join('<br>')} | ${q.toolChanges} | ${q.cycles} | ${q.lines} |`);
md.push('');
writeFileSync('docs/knowledge/README.md', md.join('\n'));
console.log(`${programs.length} programs, ${rules.length} rules, ${cuttingData.length} cutting data rows`);
for (const r of rules) console.log(`${r.label.padEnd(30)} ${String(r.holds).padStart(5)}/${String(r.applies).padEnd(5)} ${r.id}`);
