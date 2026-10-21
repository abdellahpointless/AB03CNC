import { codeOnly } from './gcodeProcessor';

/*
 * Safety check of a finished program, run before it is exported.
 *
 * It reads the program the way the controller would (modal states: motion mode, absolute or
 * incremental, spindle, length offset, canned cycle) and reports the classic causes of a crash
 * or scrap part. It never changes the program. Findings are either errors ("fix this") or
 * warnings ("have a look"); only errors ask for a confirmation before export.
 */

export type SafetyLevel = 'error' | 'warning';

export type SafetyCode =
  | 'noOffset' // cutting with no tool length offset (G43) active
  | 'offsetMismatch' // HAAS: G43 H number is not the tool in the spindle
  | 'spindleOff' // cutting with the spindle stopped
  | 'noFeed' // first cutting move with no feed rate ever set
  | 'rapidBelowZero' // G0 down below Z0 (part top) in absolute mode
  | 'noWorkOffset' // moving before any work offset (G54...) was selected
  | 'noProgramEnd' // no M30 / M2 / M99
  | 'toolTooShort'; // tool sticks out less than the deepest cut

export interface SafetyFinding {
  level: SafetyLevel;
  code: SafetyCode;
  /** 0-based index of the program line, or null when it is about the whole program. */
  line: number | null;
  params: Record<string, string | number>;
}

/** The checks that ran, so the panel can list passed ones too. */
export const SAFETY_CHECKS: Exclude<SafetyCode, 'offsetMismatch'>[] = ['noOffset', 'spindleOff', 'noFeed', 'noWorkOffset', 'rapidBelowZero', 'toolTooShort', 'noProgramEnd'];

export interface SafetyReport {
  findings: SafetyFinding[];
  errors: number;
  warnings: number;
  /** Check codes that found nothing. */
  passed: Exclude<SafetyCode, 'offsetMismatch'>[];
}

export interface ToolDepthCheck {
  tool: number;
  length: number;
  depth: number;
}

const CYCLES = new Set([73, 74, 76, 81, 82, 83, 84, 85, 86, 87, 88, 89]);

interface Words {
  g: number[];
  m: number[];
  get(letter: string): string | undefined;
}

function words(line: string): Words {
  const code = codeOnly(line).toUpperCase();
  const g: number[] = [];
  const m: number[] = [];
  const other = new Map<string, string>();
  const re = /([A-Z])\s*(#\d+|[-+]?\d*\.?\d+)/g;
  let w: RegExpExecArray | null;
  while ((w = re.exec(code))) {
    const [, letter, value] = w;
    if (letter === 'G') g.push(Number(value));
    else if (letter === 'M') m.push(Number(value));
    else if (!other.has(letter)) other.set(letter, value);
  }
  return { g, m, get: (letter) => other.get(letter) };
}

const num = (v: string | undefined) => (v === undefined || v.startsWith('#') ? NaN : Number(v));
const nLabel = (line: string) => line.match(/^\s*N(\d+)/i)?.[1];

export function checkProgram(code: string, opts: { fanuc: boolean; toolDepths?: ToolDepthCheck[] }): SafetyReport {
  const lines = code.split('\n');
  const findings: SafetyFinding[] = [];
  const add = (level: SafetyLevel, codeName: SafetyCode, line: number | null, params: Record<string, string | number> = {}) => {
    const n = line !== null ? nLabel(lines[line]) : undefined;
    findings.push({ level, code: codeName, line, params: { ...params, line: line !== null ? line + 1 : '', n: n ? `N${n}` : '' } });
  };

  let motion = 0; // 0 rapid, 1 feed, 2/3 arcs
  let absolute = true;
  let cycle = false;
  let spindleOn = false;
  let rigidTap = false;
  let offsetActive = false;
  let feedSet = false;
  let workOffset = false;
  let warnedWorkOffset = false;
  let warnedFeed = false;
  let tool: string | null = null;
  let pendingTool: string | null = null;
  // One report per tool segment for the cutting checks (a missing offset shows once, not 200 times).
  let reportedOffset = false;
  let reportedSpindle = false;
  let hasEnd = false;

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('(') || line === '%') return;
    const w = words(line);
    const has = (list: number[], ...codes: number[]) => list.some((c) => codes.includes(c));

    const t = w.get('T');
    if (t !== undefined) pendingTool = t;
    if (has(w.m, 30, 2, 99)) hasEnd = true;

    // Tool change: offset and spindle must be set again for the new tool.
    if (has(w.m, 6)) {
      tool = pendingTool;
      offsetActive = false;
      spindleOn = false;
      rigidTap = false;
      reportedOffset = false;
      reportedSpindle = false;
    }
    if (has(w.m, 3, 4)) spindleOn = true;
    if (has(w.m, 5, 30, 2)) spindleOn = false;
    if (has(w.m, 29)) rigidTap = true;
    if (w.get('F') !== undefined && num(w.get('F')) > 0) feedSet = true;

    if (has(w.g, 90)) absolute = true;
    if (has(w.g, 91)) absolute = false;
    if (w.g.some((g) => g >= 54 && g < 60) || w.g.some((g) => g >= 110 && g <= 129)) workOffset = true;
    if (has(w.g, 49)) offsetActive = false;
    if (has(w.g, 43, 44)) {
      offsetActive = true;
      const h = w.get('H');
      if (!opts.fanuc && h !== undefined && !h.startsWith('#') && tool !== null && Number(h) !== Number(tool)) {
        add('warning', 'offsetMismatch', i, { h: `H${Number(h)}`, t: `T${Number(tool)}` });
      }
    }
    if (has(w.g, 80)) cycle = false;
    for (const g of w.g) if (g === 0 || g === 1 || g === 2 || g === 3) motion = g;
    const startsCycle = w.g.some((g) => CYCLES.has(g));
    if (startsCycle) cycle = true;
    else if (w.g.some((g) => g >= 0 && g <= 3)) cycle = false;

    const machineCoords = has(w.g, 53, 28, 30);
    const moves = ['X', 'Y', 'Z'].some((a) => w.get(a) !== undefined) && !machineCoords;
    const cutting = (cycle && (startsCycle || moves)) || (moves && motion >= 1 && motion <= 3 && !cycle);

    if (moves && !workOffset && !warnedWorkOffset) {
      warnedWorkOffset = true;
      add('warning', 'noWorkOffset', i);
    }

    if (cutting) {
      if (!feedSet && !warnedFeed) {
        warnedFeed = true;
        add('error', 'noFeed', i);
      }
      if (!offsetActive && !reportedOffset) {
        reportedOffset = true;
        add('error', 'noOffset', i, { t: tool !== null ? `T${Number(tool)}` : '?' });
      }
      const tapping = w.g.some((g) => g === 84 || g === 74) || (cycle && rigidTap);
      if (!spindleOn && !(tapping && rigidTap) && !reportedSpindle) {
        reportedSpindle = true;
        add('error', 'spindleOff', i, { t: tool !== null ? `T${Number(tool)}` : '?' });
      }
    }

    // A rapid move straight down below the top of the part.
    const z = num(w.get('Z'));
    if (motion === 0 && !cycle && !startsCycle && absolute && !machineCoords && Number.isFinite(z) && z < 0) {
      add('warning', 'rapidBelowZero', i, { z: z.toFixed(3).replace(/\.?0+$/, '') });
    }
  });

  if (!hasEnd) add('warning', 'noProgramEnd', null);
  for (const d of opts.toolDepths ?? []) {
    if (d.length > 0 && d.length < d.depth) add('error', 'toolTooShort', null, { t: `T${d.tool}`, length: d.length, depth: d.depth });
  }

  findings.sort((a, b) => (a.level === b.level ? (a.line ?? 1e9) - (b.line ?? 1e9) : a.level === 'error' ? -1 : 1));
  const errors = findings.filter((f) => f.level === 'error').length;
  const found = new Set<SafetyCode>(findings.map((f) => (f.code === 'offsetMismatch' ? 'noOffset' : f.code)));
  return { findings, errors, warnings: findings.length - errors, passed: SAFETY_CHECKS.filter((c) => !found.has(c)) };
}
