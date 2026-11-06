import { parseToolpath, speedsFor, type Toolpath, type Vec } from './toolpath';
import { analyseProgram, type SetupInfo, type SetupOptions } from './setups';
import { buildInput } from './stockSim';
import { ALL, IDENTITY, apply, direction, mul, rotation as turn, transpose, turnSize, type Axis, type Mat3 } from './orient';
import { differences, layModel, score } from './modelCompare';

/*
 * When the simulated part is not the real one (the model from the part's 3D PDF or STL), the turns
 * the app read from the M0 comments may be wrong. The search simulates the whole program again and
 * again, each time with other turns, until the part is like the model (TARGET), in stages:
 *   written: every series that agrees with what is written: the written turns read every way
 *            (each quarter turn the other way round, in the other order, around the part's own
 *            axes) and, where a position is written (RAFI, TASTER, PERS., side), every way that
 *            agrees with it, also with the RAFI, TASTER and ID window taken as one same button.
 *            The program is usually right, the app read it wrong;
 *   one:     each setup turned every one of the 24 ways (the ones after it following);
 *   two:     each two setups turned every way together;
 *   all:     every combination, the cheapest MAX_STAGE of them (all of them up to three turned setups).
 * The best series is written back into the M0 comments, checked by reading the new program again.
 */

/** A part this alike the model (share of its volume) is right. */
export const TARGET = 0.99;
/** Times the one-setup stage is run again from the best series while that improves it. */
const MAX_PASSES = 3;
/** At most this many series per stage (the cheapest first). */
const MAX_STAGE = 15_000;

const eq = (a: Mat3, b: Mat3) => a.every((v, i) => v === b[i]);

export type SearchStage = 'written' | 'one' | 'two' | 'all';

export interface TurnSearch {
  /** Each setup's turn (part -> machine) in the best series found. */
  orients: Mat3[];
  /** How alike the simulated part and the model are with it (0..1). */
  match: number;
  /** The program's own turns gave this. */
  start: number;
  /** The program's own turns are the best. */
  same: boolean;
  /** Simulations run. */
  count: number;
  /** The stage that found it (null: the program's own turns). */
  stage: SearchStage | null;
}

export type SearchProgress = { count: number; total: number; best: number; stage: SearchStage };

/** Ways a setup's written turns can be read: each turn either way, in either order, around the machine's or the part's axes. */
export function readings(turns: SetupInfo['turns']): { apply: (prev: Mat3) => Mat3; changes: number }[] {
  if (!turns.length) return [];
  const quarter = turns.map((t, i) => (Math.abs(t.deg) % 180 === 90 ? i : -1)).filter((i) => i >= 0);
  const out: { apply: (prev: Mat3) => Mat3; changes: number }[] = [];
  for (let signs = 0; signs < 1 << quarter.length; signs++)
    for (const reversed of turns.length > 1 ? [false, true] : [false])
      for (const partAxes of [false, true]) {
        const ts = turns.map((t, i) => ({ ...t, deg: signs & (1 << quarter.indexOf(i)) && quarter.includes(i) ? -t.deg : t.deg }));
        if (reversed) ts.reverse();
        const flips = quarter.filter((_, b) => signs & (1 << b)).length;
        out.push({
          // Around the machine's axes each turn comes before the part; around the part's own axes, after.
          apply: (prev) => ts.reduce((m, t) => (partAxes ? mul(m, turn(t.axis, t.deg)) : mul(turn(t.axis, t.deg), m)), prev),
          changes: flips + (reversed ? 1 : 0) + (partAxes ? 1 : 0),
        });
      }
  return out;
}

const frontOf = (x: SetupInfo): Vec | null => (x.pers ? direction([x.pers]) : x.side === 'back' ? [0, 0, -1] : x.side === 'front' ? [0, 0, 1] : null);

/**
 * Every series of turns that agrees with the written instructions: a written turn read any way
 * (see readings), else every way that puts the front face and the markers where they are written,
 * learned where each is first written (nothing to go by: not turned). `oneButton`: RAFI, TASTER and
 * ID window are the same button.
 */
export function writtenSeries(setups: SetupInfo[], first: Mat3, oneButton: boolean, max = MAX_STAGE * 4): Mat3[][] {
  const out: Mat3[][] = [];
  const name = (n: string) => (oneButton ? 'BUTTON' : n);
  const walk = (k: number, s: Mat3[], known: Map<string, Vec>) => {
    if (out.length >= max) return;
    if (k === setups.length) return void out.push(s);
    const x = setups[k];
    const wants: [string, Vec][] = [];
    const f = frontOf(x);
    if (f) wants.push(['front', f]);
    if (x.marker) wants.push([name(x.marker.name), direction(x.marker.faces)]);
    const agrees = (m: Mat3) => wants.every(([n, v]) => !known.has(n) || sameVec(apply(m, known.get(n)!), v));
    let ways: Mat3[];
    if (k === 0) ways = [first];
    else if (x.turns.length) {
      const read = readings(x.turns).map((r) => r.apply(s[k - 1]));
      // A turn that puts something where it is not written is kept only when no reading agrees.
      ways = read.filter(agrees).length ? read.filter(agrees) : read;
    } else ways = wants.length ? ALL.filter(agrees) : [s[k - 1]];
    const seen = new Set<string>();
    for (const m of ways) {
      if (seen.has(m.join())) continue;
      seen.add(m.join());
      const next = new Map(known);
      for (const [n, v] of wants) if (!next.has(n)) next.set(n, apply(transpose(m), v));
      walk(k + 1, [...s, m], next);
    }
  };
  walk(0, [], new Map());
  return out;
}

/**
 * The series of turns that makes the part most like the model. `progress` is called after every
 * simulation. Stops once a series reaches TARGET, else gives the closest after every stage
 * (stopping it early: terminate the worker). Null when the model is not this part.
 */
export function searchTurns(
  tris: ArrayLike<number>,
  tp: Toolpath,
  opts: SetupOptions,
  progress: (p: SearchProgress) => void = () => {},
): TurnSearch | null {
  const base = analyseProgram(tp, opts);
  const input = buildInput(tp, base);
  if (!input) return null;
  const laid = layModel(tris, input, base.setups);
  if ('mismatch' in laid) return null;
  const own = base.setups.map((s) => s.orient);
  const start = differences(laid).match;
  let count = 1;
  if (start >= TARGET) return { orients: own, match: start, start, same: true, count, stage: null };

  const n = own.length;
  const rel = (k: number) => mul(own[k], transpose(own[k - 1]));
  // Setups after k written as a turn follow it; those written as a position stay where they are.
  const follow = (s: Mat3[], k: number) => {
    const out = [...s];
    for (let j = k + 1; j < n; j++) if (base.setups[j].turns.length) out[j] = mul(rel(j), out[j - 1]);
    return out;
  };
  const tried = new Map<string, number>([[own.join('|'), start]]);
  const simulate = (s: Mat3[]) => {
    const key = s.join('|');
    if (tried.has(key)) return tried.get(key)!;
    const r = analyseProgram(tp, opts, s);
    const inp = buildInput(tp, r);
    const l = inp && layModel(tris, inp, r.setups);
    const match = l && !('mismatch' in l) ? differences(l).match : 0;
    tried.set(key, match);
    count++;
    return match;
  };
  const movable = base.setups.filter((x) => x.index > 0 && x.stock && x.moves).map((x) => x.index);
  // The cheap guess: how well each setup's own cuts fit the model lying each way.
  const guess = new Map(movable.map((k) => [k, new Map(ALL.map((O) => [O.join(), score(laid.cutInto(base.setups[k], O))]))]));
  const guessOf = (s: Mat3[]) => movable.reduce((t, k) => t + guess.get(k)!.get(s[k].join())!, 0);

  let best = { s: own, match: start, cost: textCost(base.setups, own), stage: null as SearchStage | null };
  /** Simulate a stage's series (cheapest first); true once one is right. */
  const run = (stage: SearchStage, series: Mat3[][]) => {
    const list = series
      .map((s) => ({ s, cost: textCost(base.setups, s), g: guessOf(s) }))
      .sort((a, b) => a.cost - b.cost || b.g - a.g)
      .slice(0, MAX_STAGE);
    list.forEach(({ s, cost }, i) => {
      if (best.match >= TARGET) return;
      const match = simulate(s);
      if (match > best.match + 1e-4 || (match > best.match - 1e-4 && cost < best.cost)) best = { s, match, cost, stage };
      progress({ count, total: count + list.length - i - 1, best: best.match, stage });
    });
    return best.match >= TARGET;
  };

  // Written: every series that agrees with what is written, each turn read every way.
  if (run('written', writtenSeries(base.setups, own[0], false).concat(writtenSeries(base.setups, own[0], true)))) return result();

  // One setup at a time, every way, from the best series; again while that improves it.
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const from = best.match;
    const at = best.s;
    if (run('one', movable.flatMap((k) => ALL.map((O) => follow(at.map((m, j) => (j === k ? O : m)), k))))) return result();
    if (best.match <= from + 1e-4) break;
  }

  // Two setups at once, every way each.
  const at = best.s;
  const two = movable.flatMap((j, a) => movable.slice(a + 1).flatMap((k) => ALL.flatMap((A) => ALL.map((B) => follow(follow(at.map((m, i) => (i === j ? A : m)), j).map((m, i) => (i === k ? B : m)), k)))));
  if (run('two', two)) return result();

  // Every combination, when there are few enough setups to try them all.
  if (movable.length <= 4) {
    let all: Mat3[][] = [best.s];
    for (const k of movable) all = all.flatMap((s) => ALL.map((O) => s.map((m, i) => (i === k ? O : m))));
    run('all', all);
  }
  return result();

  function result(): TurnSearch {
    const r = analyseProgram(tp, opts, best.s);
    const same = best.s.every((m, k) => eq(m, own[k]));
    return { orients: r.setups.map((x) => x.orient), match: best.match, start, same, count, stage: best.stage };
  }
}

/**
 * How many setups' written instructions a series of turns goes against, read the way the app
 * reads them: a written turn from the setup before, else where the RAFI (TASTER, ID window) and
 * the front face point, learned where they are first written; nothing written: not turned. Ties:
 * the smaller turns.
 */
export function textCost(setups: SetupInfo[], s: Mat3[]): number {
  const known = new Map<string, Vec>();
  let cost = 0;
  setups.forEach((x, k) => {
    const wants: [string, Vec][] = [];
    const f = frontOf(x);
    if (f) wants.push(['front', f]);
    if (x.marker) wants.push([x.marker.name, direction(x.marker.faces)]);
    if (k > 0) {
      const written = x.turns.reduce((m, r) => mul(turn(r.axis, r.deg), m), s[k - 1]);
      let ok = x.turns.length || !wants.some(([n]) => known.has(n)) ? eq(written, s[k]) || (!x.turns.length && wants.length > 0) : true;
      for (const [n, v] of wants) if (known.has(n) && !sameVec(apply(s[k], known.get(n)!), v)) ok = false;
      if (!ok) cost += 100 + turnSize(s[k], written);
    }
    for (const [n, v] of wants) if (!known.has(n)) known.set(n, apply(transpose(s[k]), v));
  });
  return cost;
}
const sameVec = (a: Vec, b: Vec) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

const AXES = ['X', 'Y', 'Z'] as const;
const faceText = (v: Vec) => v.map((c, k) => (c ? `${AXES[k]}${c > 0 ? '+' : '-'}` : '')).filter(Boolean).join(' ');

/** The written turn from one clamping to the next ("TEIL 90 GRAD UM X DREHEN / Z+ WIRD Y-"), '' for none. */
export function turnPhrase(rel: Mat3): string {
  if (eq(rel, IDENTITY)) return '';
  const one = (axis: Axis, deg: number) => {
    // A quarter turn says which way: where Z+ (X+ for a turn round Z) goes.
    const from: Vec = axis === 'Z' ? [1, 0, 0] : [0, 0, 1];
    return `TEIL ${Math.abs(deg)} GRAD UM ${axis} DREHEN${Math.abs(deg) === 90 ? ` / ${faceText(from)} WIRD ${faceText(apply(turn(axis, deg), from))}` : ''}`;
  };
  const turns = AXES.flatMap((a) => [90, 180, -90].map((d) => ({ a, d, m: turn(a, d) })));
  for (const t of turns) if (eq(t.m, rel)) return one(t.a, t.d);
  for (const t1 of turns) for (const t2 of turns) if (eq(mul(t2.m, t1.m), rel)) return `${one(t1.a, t1.d)} / ${one(t2.a, t2.d)}`;
  return '';
}

// What readInstructions reads as a turn or a turn's direction (see setups.ts).
const TURN_WORDS = [
  /(?:TEIL\s*)?\d+\s*GRAD\s*UM\s*[XYZ](?:\s*DREHEN)?/gi,
  /ROTATE\s*(?:ON|AROUND|ABOUT|IN)?\s*[XYZ]\b(?:\s*,?\s*\d+\s*(?:DEG\w*|°|GRAD)?)?\s*,?/gi,
  new RegExp(`(?<![A-Z\\d.,Ø])(?:MIT\\s*\\/?\\s*)?(?:90|180|270)\\s*IN\\s*[XYZ]\\b(?!\\s*(?:UND|AND|ET|\\d|[+-]))`, 'gi'),
  /[XYZ]\s*[+-]\s*(?:WIRD|TO)\s*[XYZ]\s*[+-]/gi,
  /Z\s*\+\s*IN\s*[XY]\s*[+-]/gi,
];
const PERS = /(PERS\.?\s*(?:IN\s*)?)[XYZ]\s*[+-]/i;
const MARKER = /(RAFI?|TASTER|ID\s*WINDOW)(\s*(?:IN\s*)?)((?:[XYZ]\s*[+-]\s*)+)/i;

/** Put a phrase into a line's comment: inside its brackets, after what is there. */
function addToComment(line: string, phrase: string): string {
  const close = line.lastIndexOf(')');
  if (close < 0) return `${line.trimEnd()} (${phrase})`;
  const inner = line.slice(0, close).trimEnd();
  return `${inner}${inner.endsWith('(') ? '' : ' / '}${phrase}${line.slice(close)}`;
}

/** Tidy the separators left where phrases were taken out. */
const tidy = (line: string) =>
  line
    .replace(/(\s*\/\s*){2,}/g, ' / ')
    .replace(/\(\s*\/\s*/g, '(')
    .replace(/\s*\/\s*\)/g, ')')
    .replace(/\s{2,}/g, ' ');

export interface TurnFix {
  /** The program with the M0 comments rewritten. */
  code: string;
  /** Lines changed (0-based), as they were and as they are now. */
  changes: { line: number; from: string; to: string }[];
  /** Setups whose comments could not be written so the app reads the turn found (to check by hand). */
  unresolved: number[];
}

/**
 * Write the turns `to` (one per setup) into the program's M0 comments: the old turn phrases of a
 * setup whose turn changes are taken out and the new one written, and a RAFI (TASTER, ID window)
 * that would contradict it is moved to where it then points. The new program is read again: a
 * setup still read otherwise is `unresolved`.
 */
export function rewriteTurns(code: string, tp: Toolpath, to: Mat3[], opts: SetupOptions): TurnFix {
  const lines = code.split('\n');
  const before = [...lines];
  const read = () => analyseProgram(parseToolpath(lines.join('\n'), speedsFor(undefined)), opts).setups.map((s) => s.orient);
  // The operator's instructions: the M0 / M00 comments (not tool or operation comments).
  const stops = (k: number) => {
    const all = [...new Set(tp.setups[k].notes.map((n) => n.line))];
    const m0 = all.filter((i) => /(?<![A-Z\d])M0?0(?!\d)/i.test(lines[i] ?? ''));
    return m0.length ? m0 : all;
  };
  const markers = tp.setups.map((s) => s.notes.map((n) => ({ n, m: n.text.match(MARKER) })).find((x) => x.m));
  // The front face's direction on the part, from the first setup that says which side is up.
  let front: Vec | null = null;
  tp.setups.some((s, k) => {
    const t = s.notes.map((n) => n.text).join(' / ').toUpperCase();
    const p = t.match(/PERS\.?\s*(?:IN\s*)?([XYZ])\s*([+-])/);
    const dir: Vec | null = p ? direction([p[1] + p[2]]) : /RUECKS|RÜCKS/.test(t) ? [0, 0, -1] : /FRONT/.test(t) ? [0, 0, 1] : null;
    if (dir) front = apply(transpose(to[k]), dir);
    return !!dir;
  });

  // Where the RAFI (TASTER, ID window) and the front face (PERS.) point at setup k with turn O.
  const placeWords = (k: number) => {
    const m = markers[k];
    if (m) {
      const name = m.m![1].toUpperCase().slice(0, 3);
      const first = markers.findIndex((x) => x?.m?.[1].toUpperCase().startsWith(name));
      if (first >= 0 && first < k) {
        const v = apply(transpose(to[first]), direction(markers[first]!.m![3].toUpperCase().match(/[XYZ]\s*[+-]/g)!.map((f) => f.replace(/\s/g, ''))));
        lines[m.n.line] = tidy(lines[m.n.line].replace(MARKER, (_, w: string, sep: string) => `${w}${sep}${faceText(apply(to[k], v))} `));
      }
    }
    if (front) for (const j of stops(k)) lines[j] = lines[j].replace(PERS, (_, w: string) => `${w}${faceText(apply(to[k], front!))}`);
  };
  const writeTurn = (k: number) => {
    const own = stops(k);
    if (!own.length) return;
    let target: number | null = null;
    for (const i of own) {
      let l = lines[i];
      for (const re of TURN_WORDS) l = l.replace(re, () => ((target ??= i), ''));
      lines[i] = tidy(l);
    }
    const phrase = turnPhrase(mul(to[k], transpose(to[k - 1])));
    if (phrase) {
      const i = target ?? own[0];
      lines[i] = addToComment(lines[i], phrase);
    }
  };

  // In order: a setup is rewritten only when the program, as rewritten so far, is still read
  // otherwise there. One written as a position gets its position words first, a turn only if needed.
  let got = read();
  for (let k = 1; k < to.length; k++) {
    if (!got[k] || eq(got[k], to[k])) continue;
    const saved = [...lines];
    if (!tp.setups[k].notes.some((n) => TURN_WORDS.some((re) => new RegExp(re.source, 'i').test(n.text)))) {
      placeWords(k);
      got = read();
      if (eq(got[k], to[k])) continue;
      lines.splice(0, lines.length, ...saved);
    }
    writeTurn(k);
    got = read();
    if (eq(got[k], to[k])) continue;
    placeWords(k);
    got = read();
  }

  const changes = lines.map((l, i) => ({ line: i, from: before[i], to: l })).filter((c) => c.from !== c.to);
  const unresolved = to.map((O, k) => (got[k] && !eq(got[k], O) ? k : -1)).filter((k) => k >= 0);
  return { code: lines.join('\n'), changes, unresolved };
}
