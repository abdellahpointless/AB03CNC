/*
 * Reading the shop's programs for what CAM AI needs to program like them: per operation the tool
 * (type, Ø, length, the material its data is for), the rpm, the feeds, the depth per pass, the
 * step-over and the peck; per part the material, sizes, setups and the order of operations.
 * Tool codes in the comments read like "SF_20.00_055_000_FH": type, Ø, length, -, material.
 */

/** What an operation does, from its name (TOOLPATH TASCHE_8MM -> pocket). */
export type OpKind = 'face' | 'pocket' | 'contour' | 'finish' | 'centre' | 'drill' | 'counterbore' | 'tap' | 'chamfer' | 'other';

export interface Sample {
  material: string;
  type: string;
  d: number;
  length: number;
  kind: OpKind;
  op: string;
  s: number | null;
  /** Cutting feed (moves in X/Y), plunge feed (moves in Z only), mm/min. */
  f: number | null;
  fz: number | null;
  /** Depth per pass (mm) and step-over (mm), when the operation shows them. */
  ap: number | null;
  ae: number | null;
  /** Peck depth of G83 (mm). */
  q: number | null;
  /** Deepest cut below the setup's top (mm). */
  depth: number;
}

export interface PartRead {
  name: string;
  material: string | null;
  size: number[] | null;
  raw: number[] | null;
  setups: number;
  /** The operations of each setup, in order (consecutive same kinds once). */
  order: OpKind[][];
  /** The clamping instructions as written (M0 comments). */
  m0: string[];
  samples: Sample[];
}

const KINDS: [RegExp, OpKind][] = [
  [/^(PLAN|VORPLAN|MESSERKOPF)/, 'face'],
  [/^(ZENTRIER|ZENTR)/, 'centre'],
  [/^GEWINDE/, 'tap'],
  [/^ABSENKUNG/, 'counterbore'],
  [/^BOHREN/, 'drill'],
  [/^(SCHLICHT|SCHL)/, 'finish'],
  [/^(TASCHE|TASTER|EINSATZ)/, 'pocket'],
  [/^(PROFIL|KONTUR|HALTEZYL|RUECKS)/, 'contour'],
  [/^(FASE|ENTGRATEN)/, 'chamfer'],
];
export const kindOf = (op: string, type: string): OpKind => (type === 'GB' ? 'tap' : (KINDS.find(([re]) => re.test(op))?.[1] ?? 'other'));

/** The tool suffix names the material the data is for; the header names the part's. */
const MATERIAL: Record<string, string> = { FH: 'FH', KS: 'POM', KSHS: 'POM', POM: 'POM', ALHS: 'ALU', AL: 'ALU', ALU: 'ALU', FRHS: 'FR', 'PC GF': 'PC GF' };

const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const round = (v: number | null, k = 100) => (v === null ? null : Math.round(v * k) / k);

const word = (line: string, letter: string) => {
  const m = line.match(new RegExp(`(?<![A-Z])${letter}\\s*(-?\\d*\\.?\\d+)`));
  return m ? Number(m[1]) : null;
};

export function readProgram(text: string, name = ''): PartRead {
  const lines = text.split(/\r?\n/);
  const header = lines.slice(0, 15).join(' ').toUpperCase();
  const mat = header.match(/\b(FH|POM|ALU|PC GF|RESOPAL|EPOXYDE)\b/);
  const dims = [...header.matchAll(/(\d+(?:[.,]\d+)?)\s*X\s*(\d+(?:[.,]\d+)?)\s*X\s*(\d+(?:[.,]\d+)?)/g)].map((m) => [1, 2, 3].map((k) => Number(m[k].replace(',', '.'))));
  const raw = header.match(/ZUSCHNITT\s*:?\s*(\d+(?:[.,]\d+)?)\s*X\s*(\d+(?:[.,]\d+)?)\s*X\s*(\d+(?:[.,]\d+)?)/);

  const samples: Sample[] = [];
  const order: OpKind[][] = [[]];
  const m0: string[] = [];
  let op = '';
  let tool: { type: string; d: number; length: number; material: string } | null = null;
  let s: number | null = null;
  let f: number | null = null;
  let motion = 0;
  let x = 0;
  let y = 0;
  let z = 50;
  let newClamp = false;
  type Open = { sample: Sample; cut: number[]; plunge: number[]; levels: Set<number>; lines: Map<string, number[]>; top: number };
  // Set by open() and close(): typed so the compiler does not narrow it to null.
  let cur = null as Open | null;

  const close = () => {
    if (!cur) return;
    const { sample, cut, plunge, levels, lines: ln } = cur;
    sample.f = median(cut);
    sample.fz = median(plunge);
    const lv = [...levels].sort((a, b) => b - a);
    // Depth per pass: only for milling (drills and taps go to several holes' depths).
    if (lv.length > 1 && !['drill', 'centre', 'tap', 'counterbore'].includes(sample.kind)) sample.ap = round(median(lv.slice(1).map((v, i) => lv[i] - v)));
    const gaps: number[] = [];
    for (const vals of ln.values()) {
      const u = [...new Set(vals.map((v) => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
      for (let i = 1; i < u.length; i++) {
        const g = u[i] - u[i - 1];
        if (g > sample.d * 0.05 && g <= sample.d * 1.01) gaps.push(g);
      }
    }
    sample.ae = round(median(gaps));
    sample.depth = round(Math.max(0, cur.top - Math.min(...lv, cur.top)))!;
    if (sample.f !== null || sample.q !== null || sample.kind === 'drill' || sample.kind === 'centre' || sample.kind === 'tap') samples.push(sample);
    const o = order[order.length - 1];
    if (o[o.length - 1] !== sample.kind) o.push(sample.kind);
    cur = null;
  };
  const open = () => {
    if (cur || !tool) return;
    cur = {
      sample: { material: tool.material, type: tool.type, d: tool.d, length: tool.length, kind: kindOf(op, tool.type), op, s, f: null, fz: null, ap: null, ae: null, q: null, depth: 0 },
      cut: [],
      plunge: [],
      levels: new Set(),
      lines: new Map(),
      top: 0,
    };
  };

  for (const raw0 of lines) {
    const line = raw0.toUpperCase();
    const comment = line.match(/\(([^)]*)\)/)?.[1] ?? '';
    const code = line.replace(/\([^)]*\)/g, '');
    if (/\bM0?0\b/.test(code) && comment) {
      m0.push(comment.trim());
      newClamp = true;
    }
    const tp = comment.match(/^TOOLPATH\s+(.+)/);
    if (tp) {
      close();
      op = tp[1].trim();
      continue;
    }
    const tc = comment.match(/([A-Z]{2,3})_(\d+\.\d+)_(\d{3})_[A-Z0-9]+_([A-Z]+)\s*$/);
    if (tc) {
      close();
      tool = { type: tc[1], d: Number(tc[2]), length: Number(tc[3]), material: MATERIAL[tc[4]] ?? tc[4] };
      continue;
    }
    // A new clamping: a G52 after operator instructions (some programs shift with G52 within one clamping).
    if (/\bG52\b/.test(code) && newClamp) {
      newClamp = false;
      close();
      if (order[order.length - 1].length) order.push([]);
    }
    if (/\bM0?6\b/.test(code)) close();
    const S = word(code, 'S');
    if (S !== null && S > 0) {
      s = S;
      if (cur) cur.sample.s ??= S;
    }
    const F = word(code, 'F');
    if (F !== null) f = F;
    const g = [...code.matchAll(/G(\d+)/g)].map((m) => Number(m[1]));
    for (const v of g) if ([0, 1, 2, 3, 73, 74, 76, 81, 82, 83, 84, 85, 86, 89].includes(v)) motion = v;
    if (g.includes(80)) motion = 0;
    const X = word(code, 'X');
    const Y = word(code, 'Y');
    const Z = word(code, 'Z');
    if (X === null && Y === null && Z === null) continue;
    const nx = X ?? x;
    const ny = Y ?? y;
    const nz = Z ?? z;
    if (motion >= 73) {
      open();
      if (cur) {
        cur.sample.q ??= word(code, 'Q');
        if (F !== null) cur.plunge.push(F);
        if (Z !== null) cur.levels.add(Z);
        cur.sample.s ??= s;
      }
    } else if (motion >= 1) {
      open();
      if (cur && f !== null) {
        const xy = nx !== x || ny !== y;
        if (xy) {
          cur.cut.push(f);
          cur.levels.add(Math.round(nz * 1000) / 1000);
          if (motion === 1) {
            const len = Math.hypot(nx - x, ny - y);
            if (len > cur.sample.d) {
              const key = `${Math.round(nz * 100)}:${Math.abs(nx - x) < 1e-3 ? 'x' : Math.abs(ny - y) < 1e-3 ? 'y' : ''}`;
              if (!key.endsWith(':')) (cur.lines.get(key) ?? cur.lines.set(key, []).get(key)!).push(key.endsWith('x') ? nx : ny);
            }
          }
        } else if (nz < z) cur.plunge.push(f);
      }
    }
    x = nx;
    y = ny;
    z = nz;
  }
  close();
  return {
    name,
    material: mat ? (MATERIAL[mat[1]] ?? mat[1]) : (samples[0]?.material ?? null),
    size: dims[0] ?? null,
    raw: raw ? [1, 2, 3].map((k) => Number(raw[k].replace(',', '.'))) : null,
    setups: order.filter((o) => o.length).length,
    order: order.filter((o) => o.length),
    m0,
    samples,
  };
}

export interface CutRow {
  d: number;
  kind: OpKind;
  /** Operations it is learned from, and in how many programs. */
  n: number;
  programs: number;
  length: number | null;
  s: number | null;
  f: number | null;
  fz: number | null;
  ap: number | null;
  ae: number | null;
  q: number | null;
}

/** What CAM AI learned: cutting data, the order of operations, raw stock allowance, setups. */
export interface ShopKnowledge {
  version: 1;
  programs: number;
  /** material -> tool type -> rows by Ø and kind of operation (medians). */
  cut: Record<string, Record<string, CutRow[]>>;
  /** Kinds of operation in the order the programmers put them within a setup. */
  order: OpKind[];
  /** Raw minus finished size (mm), sides sorted smallest first (thickness, then the two sides), median. */
  allowance: number[] | null;
  /** How many parts had 1, 2, 3 ... setups. */
  setups: Record<string, number>;
  /** The clamping instructions most written (numbers as N). */
  m0: [string, number][];
}

export function summarise(parts: PartRead[]): ShopKnowledge {
  const groups = new Map<string, { s: Sample[]; progs: Set<string> }>();
  parts.forEach((p) =>
    p.samples.forEach((x) => {
      const k = `${x.material}|${x.type}|${x.d}|${x.kind}`;
      const g = groups.get(k) ?? groups.set(k, { s: [], progs: new Set() }).get(k)!;
      g.s.push(x);
      g.progs.add(p.name);
    }),
  );
  const cut: ShopKnowledge['cut'] = {};
  for (const [k, g] of [...groups].sort()) {
    const [material, type, d, kind] = k.split('|');
    const pick = (f: (x: Sample) => number | null) => median(g.s.map(f).filter((v): v is number => v !== null && v > 0));
    ((cut[material] ??= {})[type] ??= []).push({
      d: Number(d),
      kind: kind as OpKind,
      n: g.s.length,
      programs: g.progs.size,
      length: pick((x) => x.length),
      s: pick((x) => x.s),
      f: pick((x) => x.f),
      fz: pick((x) => x.fz),
      ap: pick((x) => x.ap),
      ae: pick((x) => x.ae),
      q: pick((x) => x.q),
    });
  }
  // Order: each kind's mean position within its setup.
  const pos = new Map<OpKind, number[]>();
  for (const p of parts) for (const o of p.order) o.forEach((k, i) => (pos.get(k) ?? pos.set(k, []).get(k)!).push(i / Math.max(1, o.length - 1)));
  const order = [...pos].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length] as const).sort((a, b) => a[1] - b[1]).map(([k]) => k);
  const allow = parts.filter((p) => p.raw && p.size).map((p) => {
    // Pair raw and finished sides by size (headers write them in different orders).
    const a = [...p.size!].sort((x, y) => x - y);
    const b = [...p.raw!].sort((x, y) => x - y);
    return a.map((v, i) => b[i] - v);
  });
  const setups: Record<string, number> = {};
  for (const p of parts) setups[p.setups] = (setups[p.setups] ?? 0) + 1;
  const m0 = new Map<string, number>();
  for (const p of parts) for (const t of p.m0) {
    const k = t.replace(/\d+(?:[.,]\d+)?/g, 'N').replace(/\s+/g, ' ');
    m0.set(k, (m0.get(k) ?? 0) + 1);
  }
  return {
    version: 1,
    programs: parts.length,
    cut,
    order,
    allowance: allow.length ? [0, 1, 2].map((i) => median(allow.map((a) => a[i]))!) : null,
    setups,
    m0: [...m0].sort((a, b) => b[1] - a[1]).slice(0, 40),
  };
}
