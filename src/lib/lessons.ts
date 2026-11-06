import type { Toolpath } from './toolpath';
import type { ProgramSetups } from './setups';
import type { Mat3 } from './orient';
import type { TurnFix, TurnSearch } from './fixTurns';
import type { Piece } from './modelCompare';
import { readProgram } from './cam/learn';

/*
 * A learning record: what a program's clamping instructions say, how the app read them, and the
 * turns that made the simulated part like the real one (its 3D model). Saved on the server after
 * every turn search; an admin downloads them all to improve how the app reads written turns.
 * Only the instructions and the header are kept, not the program (part records below keep it).
 */
export const LESSON_VERSION = 1;

export function lessonOf(tp: Toolpath, read: ProgramSetups, search: TurnSearch, fix: TurnFix | null) {
  const turned = (m: Mat3) => m.join(',');
  return {
    version: LESSON_VERSION,
    header: tp.header.slice(0, 12),
    stage: search.stage,
    simulations: search.count,
    found: search.match >= 0.99,
    setups: read.setups.map((s, k) => ({
      n: k + 1,
      line: s.line + 1,
      notes: s.notes,
      read: { orient: turned(s.orient), turns: s.turns, marker: s.marker, pers: s.pers, side: s.side, onEdge: s.onEdge, conflict: s.conflict },
      right: turned(search.orients[k]),
      changed: turned(s.orient) !== turned(search.orients[k]),
    })),
    corrected: fix?.changes.map((c) => ({ line: c.line + 1, from: c.from.trim(), to: c.to.trim() })) ?? [],
  };
}
export type Lesson = ReturnType<typeof lessonOf>;

/** gzip, then base64 (the way part records keep the model and the program). */
export async function gzip64(bytes: Uint8Array): Promise<string> {
  const buf = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A part record is kept under this (the server's limit is 1.9 MB with the rest of the record). */
const MAX_MODEL64 = 1_500_000;

/**
 * A part record: a program checked with its part's 3D model (or made by CAM AI). Keeps the model
 * and the program (compressed), how alike the simulated part and the model are, where they differ,
 * and how each operation was machined, so the kind of parts the shop makes can be learned from.
 */
export async function partLessonOf(o: {
  code: string;
  tp: Toolpath;
  model: { name: string; bytes: Uint8Array };
  match: number;
  pieces: Piece[];
  brand?: string;
  source: 'program' | 'cam';
}) {
  const read = readProgram(o.code);
  const model64 = await gzip64(o.model.bytes);
  const seconds = new Map(o.tp.tools.map((t) => [t.op || t.label, t.seconds]));
  return {
    version: 1,
    source: o.source,
    brand: o.brand ?? null,
    header: o.tp.header.slice(0, 12),
    material: read.material,
    size: read.size,
    raw: read.raw,
    setups: read.setups,
    order: read.order,
    clamping: read.m0,
    minutes: Math.round(o.tp.totalSeconds / 6) / 10,
    toolChanges: o.tp.toolChanges,
    match: o.match,
    differences: o.pieces.map((p) => ({ kind: p.kind, mm3: Math.round(p.mm3), min: p.min.map((v) => Math.round(v * 10) / 10), max: p.max.map((v) => Math.round(v * 10) / 10) })),
    operations: read.samples.map((x) => ({ ...x, seconds: seconds.get(x.op) ?? null })),
    modelName: o.model.name,
    model: model64.length <= MAX_MODEL64 ? model64 : null,
    program: await gzip64(new TextEncoder().encode(o.code)),
  };
}
