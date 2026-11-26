import { carve, drilledHoles, fillEnclosed, mesher, soonAt, thicknessAt, wallThickness, type ChunkMesh, type Grid, type Mesher, type SimInput } from './stockSim';
import { readTris } from './model';
import { differences, layModel, placeModel, type Placed } from './modelCompare';
import type { ModelError } from './modelLimits';
import { rewriteTurns, searchTurns } from './fixTurns';
import { parseToolpath, speedsFor } from './toolpath';
import { analyseProgram, DEFAULT_JAW_HEIGHT } from './setups';
import { lessonOf } from './lessons';

/*
 * Cuts the part away from the UI thread. Messages:
 *   { type: 'init', input }  -> { type: 'progress', share } ..., { type: 'ready', size }
 *   { type: 'mesh', step, heat, until?, hull? } -> { type: 'mesh', step, full, chunks: [{ id, positions, normals, cut, thick?, soon? }] }
 *   (hull: the part's outer walls only at that instant, every hollow closed: item 2)
 * thick: wall thickness of the finished part at each point (weak spots), measured the first time
 * heat is asked for (it takes a second on big parts), then sent with every chunk.
 * step is an instant of the program (move × SUB + share of the move, see stockSim), so the cut
 * follows the tool along a move. Only the chunks that change between two instants are sent again.
 *   { type: 'prebuild', steps } -> (nothing): the part built ahead at those instants (each operation's start), in the
 *   background between requests, so a jump to one is answered from it at once (the owner: no waiting); then
 *   { type: 'prebuilt', built, of, bytes } (fewer built than asked when the memory budget ran out).
 *   { type: 'holes', before } -> { type: 'holes', before, holes }: the round holes plunged before move `before`.
 *   { type: 'model', bytes, input, setups } -> { type: 'model', tris (part frame), overlap } or { type: 'model', error }:
 *   the real part (3D PDF or STL) read and laid on the simulated finished part, with how alike they
 *   are (match) and where they differ (pieces). Needs no 'init'.
 *   { type: 'search', bytes, code, brand } -> { type: 'searching', count, total, best } ...,
 *   { type: 'search', result, fix, lesson } or { type: 'search', error }: the turns that make the part like
 *   the model (fixTurns.ts), and the program with its M0 comments rewritten for them.
 */


async function model(bytes: Uint8Array, input: SimInput, setups: Placed[]) {
  const tris = await readTris(bytes);
  if ('error' in tris) return tris;
  const laid = layModel(tris, input, setups);
  if ('mismatch' in laid) return { error: 'notPart' as ModelError };
  const { match, pieces } = differences(laid);
  return { tris: placeModel(tris, laid.R, laid.t), overlap: laid.overlap, match, pieces };
}

async function search(bytes: Uint8Array, code: string, brand: string | undefined) {
  const tris = await readTris(bytes);
  if ('error' in tris) return tris;
  const tp = parseToolpath(code, speedsFor(brand));
  const opts = { jawHeight: DEFAULT_JAW_HEIGHT };
  const result = searchTurns(tris, tp, opts, (p) => self.postMessage({ type: 'searching', ...p }));
  if (!result) return { error: 'notPart' as ModelError };
  const fix = result.same ? null : rewriteTurns(code, tp, result.orients, opts);
  return { result, fix, lesson: result.same ? null : lessonOf(tp, analyseProgram(tp, opts), result, fix) };
}

let m: Mesher | null = null;
let g: Grid | null = null;
let input: SimInput | null = null;
let th: Float32Array | null = null;
let last = -1;
let lastUntil: number | null = null;
// Built ahead (prebuild): the part at each instant asked, as the chunks that changed since the instant before (all of
// them at the first). A chunk at steps[j] is the latest layer up to j that has it. Kept under a memory budget.
const PRE_BYTES = 150e6;
let pre: { steps: number[]; layers: Map<number, ChunkMesh>[]; bytes: number; j: number; ids: number[]; k: number } | null = null;
let preTimer = 0;
const sizeOf = (c: ChunkMesh) => c.positions.byteLength + c.normals.byteLength + c.cut.byteLength;
const cachedAt = (id: number, j: number): ChunkMesh | null => {
  for (let i = j; i >= 0; i--) {
    const c = pre!.layers[i]?.get(id);
    if (c) return c;
  }
  return null;
};
/** A slice of the building ahead (a few chunks), then the worker is free for what is asked. */
function preSlice() {
  preTimer = 0;
  if (!pre || !m) return;
  if (pre.j >= pre.steps.length || pre.bytes > PRE_BYTES) {
    self.postMessage({ type: 'prebuilt', built: pre.j, of: pre.steps.length, bytes: pre.bytes });
    return;
  }
  const p = pre;
  if (p.k === 0 && p.ids.length === 0) p.ids = p.j === 0 ? Array.from({ length: m.chunks }, (_, i) => i) : m.dirty(p.steps[p.j - 1], p.steps[p.j]);
  const layer = (p.layers[p.j] ??= new Map());
  const until = performance.now() + 120;
  while (p.k < p.ids.length && performance.now() < until) {
    const c = m.build(p.ids[p.k++], p.steps[p.j]);
    layer.set(c.id, c);
    p.bytes += sizeOf(c);
  }
  if (p.k >= p.ids.length) {
    p.j++;
    p.k = 0;
    p.ids = [];
  }
  preTimer = self.setTimeout(preSlice, 0) as unknown as number;
}
/** The last instant built ahead that is not after `step` (its layers complete), or -1. */
const preBefore = (step: number) => {
  if (!pre) return -1;
  let j = -1;
  for (let i = 0; i < pre.j && pre.steps[i] <= step; i++) j = i;
  return j;
};

// The outer shape: made again for each instant asked, all of it sent each time.
let hull: { at: number; m: Mesher } | null = null;
let lastHull = false;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as
    | { type: 'init'; input: SimInput }
    | { type: 'mesh'; step: number; heat?: boolean; until?: number | null; hull?: boolean }
    | { type: 'holes'; before: number }
    | { type: 'prebuild'; steps: number[] }
    | { type: 'model'; bytes: Uint8Array; input: SimInput; setups: Placed[] }
    | { type: 'search'; bytes: Uint8Array; code: string; brand?: string };
  if (msg.type === 'search') {
    search(msg.bytes, msg.code, msg.brand).then(
      (r) => self.postMessage({ type: 'search', ...r }),
      () => self.postMessage({ type: 'search', error: 'unreadable' }),
    );
    return;
  }
  if (msg.type === 'model') {
    model(msg.bytes, msg.input, msg.setups).then(
      (r) => self.postMessage({ type: 'model', ...r }, 'tris' in r ? { transfer: [r.tris.buffer] } : undefined),
      () => self.postMessage({ type: 'model', error: 'unreadable' }),
    );
    return;
  }
  if (msg.type === 'prebuild' && m) {
    const steps = [...new Set(msg.steps.filter((x) => Number.isFinite(x) && x >= 0))].sort((a, b) => a - b);
    pre = { steps, layers: [], bytes: 0, j: 0, ids: [], k: 0 };
    if (!preTimer) preTimer = self.setTimeout(preSlice, 0) as unknown as number;
    return;
  }
  if (msg.type === 'holes' && g) {
    self.postMessage({ type: 'holes', before: msg.before, holes: drilledHoles(input!, g, msg.before) });
    return;
  }
  if (msg.type === 'init') {
    input = msg.input;
    g = carve(msg.input, (share) => self.postMessage({ type: 'progress', share }));
    m = mesher(g, msg.input);
    pre = null;
    th = null;
    last = -1;
    self.postMessage({ type: 'ready', size: g.size });
    return;
  }
  if (msg.type === 'mesh' && m) {
    // The first time weak spots are asked for: measure, and send every chunk again with them.
    const measure = !!msg.heat && !th;
    if (measure) {
      self.postMessage({ type: 'measuring' });
      th = wallThickness(g!, input!, 1.5);
    }
    // The x-ray's tint (until: what the tool at work still takes): every chunk again when it changes.
    const until: number | null = typeof msg.until === 'number' ? msg.until : null;
    const outer = !!msg.hull;
    const full = last < 0 || measure || until !== lastUntil || outer || outer !== lastHull;
    lastUntil = until;
    lastHull = outer;
    if (outer && hull?.at !== msg.step) hull = { at: msg.step, m: mesher(fillEnclosed(g!, msg.step), input!) };
    const use = outer ? hull!.m : m;
    const ids = full ? Array.from({ length: m.chunks }, (_, i) => i) : m.dirty(last, msg.step);
    // Built ahead: a chunk unchanged since the last instant built ahead before this one is taken from there (copied:
    // what is sent is given away); only the others are built now.
    const j = outer ? -1 : preBefore(msg.step);
    const changed = j >= 0 && pre!.steps[j] !== msg.step ? new Set(m.dirty(pre!.steps[j], msg.step)) : null;
    const chunks = ids.map((id) => {
      const kept = j >= 0 && !changed?.has(id) ? cachedAt(id, j) : null;
      const c = kept ? { id, positions: kept.positions.slice(), normals: kept.normals.slice(), cut: kept.cut.slice() } : use.build(id, msg.step);
      return { ...c, ...(th && !outer ? { thick: thicknessAt(g!, th, c.positions) } : {}), ...(until !== null && !outer ? { soon: soonAt(g!, c.positions, msg.step, until) } : {}) };
    });
    last = msg.step;
    self.postMessage(
      { type: 'mesh', step: msg.step, full, chunks },
      { transfer: chunks.flatMap((c) => [c.positions.buffer, c.normals.buffer, c.cut.buffer, ...(c.thick ? [c.thick.buffer] : []), ...(c.soon ? [c.soon.buffer] : [])]) },
    );
  }
};
