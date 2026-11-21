/*
 * CAM AI's program written the way the shop's programs are (docs/knowledge: gcode.onlyChangedAxes,
 * gcode.feedOnlyWhenChanged, gcode.shortNumbers and the drilling layout): the same moves in fewer
 * words. A straight move leaves out the axes that do not change and the feed when it is the same;
 * holes of one depth are one cycle, each further hole only its new X or Y; numbers drop a leading
 * zero (Z-.5). Taken only when the app's reader finds exactly the same moves in it as in the program
 * it shortens (shopStyle proves it for each program).
 */
import { parseToolpath, speedsFor, type Move } from '../toolpath';

const NUM = '-?(?:\\d+\\.?\\d*|\\.\\d+)';
const words = (s: string) => [...s.matchAll(new RegExp(`([A-Z])(${NUM})`, 'g'))].map((m) => [m[1], m[2]] as [string, string]);
const num = (v: string) => Number(v);
const short = (v: string) => v.replace(/^(-?)0\.(?=\d)/, '$1.');

/** A drilling cycle line as CAM AI writes it: "G98 G83 X.. Y.. Z.. R.. Q.. F..". */
interface Hole { cycle: string; x: string | null; y: string | null; rest: [string, string][] }

/** The holes of one drilling block (from its cycle line to G80), or null when it is written some other way. */
function holesOf(block: string[]): Hole[] | null {
  const out: Hole[] = [];
  let cycle = '';
  let rest: [string, string][] = [];
  for (const l of block) {
    const g = l.match(/^G98 (G8[13]) /);
    if (g) cycle = g[1];
    else if (!cycle || !/^[XYZRQF]/.test(l)) return null;
    const w = words(g ? l.slice(8) : l);
    if (w.some(([k]) => !'XYZRQF'.includes(k))) return null;
    const x = w.find(([k]) => k === 'X')?.[1] ?? null;
    const y = w.find(([k]) => k === 'Y')?.[1] ?? null;
    // Z R Q F of the line, or the last ones written (a spot drilling line gives only what changes).
    const own = w.filter(([k]) => 'ZRQF'.includes(k));
    rest = g ? own : [...rest.filter(([k]) => !own.some(([o]) => o === k)), ...own].sort((a, b) => 'ZRQF'.indexOf(a[0]) - 'ZRQF'.indexOf(b[0]));
    out.push({ cycle, x, y, rest });
  }
  return out;
}

/** One cycle per depth (Z, R, Q and F alike), the further holes with only their new X or Y. */
function shopDrilling(block: string[], at: { x: string | null; y: string | null }): string[] | null {
  const holes = holesOf(block);
  if (!holes?.length) return null;
  const out: string[] = [];
  let open = '';
  let [x, y] = [at.x, at.y];
  for (const h of holes) {
    const key = `${h.cycle} ${h.rest.map(([k, v]) => `${k}${v}`).join(' ')}`;
    const move = [h.x !== null && h.x !== x ? `X${h.x}` : '', h.y !== null && h.y !== y ? `Y${h.y}` : ''].filter(Boolean).join(' ');
    if (key !== open) {
      if (open) out.push('G80');
      // To the hole at the cycle's start height, then the cycle there.
      if (move) out.push(`G00 ${move}`);
      out.push(`G98 ${key}`);
      open = key;
    } else if (move) out.push(move);
    [x, y] = [h.x ?? x, h.y ?? y];
  }
  out.push('G80');
  return out;
}

/**
 * The program, shortened line by line (no proof yet). `still`: also leave out a move to where the tool
 * already is (beyond what the engineers do: improvement O1 in docs/knowledge/cam-gaps.md, off until approved).
 */
export function shorten(code: string, still = false): string {
  const src = code.split('\n');
  const out: string[] = [];
  const pos: Record<string, string | null> = { X: null, Y: null, Z: null };
  let feed: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const raw = src[i];
    const n = raw.match(/^N\d+ /);
    if (!n) {
      out.push(raw);
      continue;
    }
    let l = raw.slice(n[0].length);
    const comment = l.startsWith('(') || l.startsWith('M0 (') || l.startsWith('M01');
    if (comment) {
      out.push(l);
      continue;
    }
    // Where the machine is is not known after these: nothing is left out from what follows.
    if (/(?<![A-Z])(G52|G53|G28|M6)(?![0-9])/.test(l)) {
      pos.X = pos.Y = pos.Z = null;
      feed = null;
    }
    // A drilling block: from its first cycle line to G80.
    if (/^G98 G8[13] /.test(l)) {
      const end = src.findIndex((s, k) => k > i && /^N\d+ G80$/.test(s));
      const block = end > 0 ? src.slice(i, end).map((s) => s.replace(/^N\d+ /, '')) : null;
      const shop = block && shopDrilling(block, { x: pos.X, y: pos.Y });
      if (block && shop) {
        out.push(...shop);
        const last = holesOf(block)!.reduce((a, h) => ({ x: h.x ?? a.x, y: h.y ?? a.y }), { x: pos.X, y: pos.Y });
        pos.X = last.x;
        pos.Y = last.y;
        pos.Z = null;
        feed = null;
        i = end;
        continue;
      }
    }
    if (new RegExp(`^G0?[01]( [XYZF]${NUM})+$`).test(l)) {
      const g = l.split(' ')[0];
      const kept = words(l.slice(g.length)).filter(([k, v]) => (k === 'F' ? g === 'G00' || feed === null || num(v) !== num(feed) : pos[k] === null || num(v) !== num(pos[k]!)));
      for (const [k, v] of words(l.slice(g.length))) if (k === 'F') feed = v;
      else pos[k] = v;
      // A move to where the tool is: kept as written, unless O1 is on (then no line).
      if (!kept.some(([k]) => k !== 'F')) {
        if (!still) out.push(l);
        else if (kept.length && g !== 'G00') out.push(`${g} ${kept.map(([k, v]) => `${k}${v}`).join(' ')}`);
        continue;
      }
      l = `${g} ${kept.map(([k, v]) => `${k}${v}`).join(' ')}`;
    } else {
      for (const [k, v] of words(l)) if ('XYZ'.includes(k)) pos[k] = v;
      if (/(?<![A-Z])G8\d|G80/.test(l)) {
        pos.Z = null;
        feed = null;
      }
      const f = l.match(new RegExp(`(?<![A-Z])F(${NUM})`));
      if (f) feed = f[1];
    }
    out.push(l);
  }
  let k = 0;
  return out
    .map((l) => (l === '%' || /^O\d/.test(l) || !l ? l : `N${++k} ${l.startsWith('G52') ? l : l.replace(new RegExp(`([XYZIJRQ])(${NUM})`, 'g'), (_w, a: string, v: string) => `${a}${short(v)}`)}`))
    .join('\n');
}

/** A move that goes nowhere (a line repeating where the tool is) is no move. */
const moving = (ms: Move[]) => ms.filter((m) => m.kind === 'drill' || m.points.some((p) => p.some((v, c) => Math.abs(v - m.points[0][c]) > 1e-9)));
const sameMoves = (a: Move[], b: Move[]) =>
  a.length === b.length &&
  a.every((m, i) => {
    const o = b[i];
    return (
      m.kind === o.kind &&
      m.tool === o.tool &&
      m.setup === o.setup &&
      m.depth === o.depth &&
      Math.abs(m.seconds - o.seconds) < 1e-9 &&
      m.points.length === o.points.length &&
      m.points.every((p, j) => p.every((v, c) => Math.abs(v - o.points[j][c]) < 1e-9))
    );
  });

/**
 * The program in the shop's words, when the app's reader finds the very same moves in it (points,
 * depths, times, tools and setups); else the program as it was.
 */
export function shopStyle(code: string, brand?: string, shortener: (code: string) => string = shorten): { code: string; shortened: boolean } {
  const short = shortener(code);
  const speeds = speedsFor(brand);
  const [a, b] = [parseToolpath(code, speeds), parseToolpath(short, speeds)];
  const same = sameMoves(moving(a.moves), moving(b.moves)) && a.setups.length === b.setups.length && a.setups.every((s, i) => JSON.stringify(s.notes.map((x) => x.text)) === JSON.stringify(b.setups[i].notes.map((x) => x.text)));
  return same ? { code: short, shortened: true } : { code, shortened: false };
}
