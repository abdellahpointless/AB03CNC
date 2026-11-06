import { carve, drilledHoles, mesher, thicknessAt, wallThickness, type Grid, type Mesher, type SimInput } from './stockSim';
import { readModel } from './model';
import { PrcError } from './prc';
import { differences, layModel, placeModel, type Placed } from './modelCompare';
import { MODEL_MAX_BYTES, MODEL_MAX_TRIS, type ModelError } from './modelLimits';
import { rewriteTurns, searchTurns } from './fixTurns';
import { parseToolpath, speedsFor } from './toolpath';
import { DEFAULT_JAW_HEIGHT } from './setups';

/*
 * Cuts the part away from the UI thread. Messages:
 *   { type: 'init', input }  -> { type: 'progress', share } ..., { type: 'ready', size }
 *   { type: 'mesh', step, heat } -> { type: 'mesh', step, full, chunks: [{ id, positions, normals, cut, thick? }] }
 * thick: wall thickness of the finished part at each point (weak spots), measured the first time
 * heat is asked for (it takes a second on big parts), then sent with every chunk.
 * step is an instant of the program (move × SUB + share of the move, see stockSim), so the cut
 * follows the tool along a move. Only the chunks that change between two instants are sent again.
 *   { type: 'holes', before } -> { type: 'holes', before, holes }: the round holes plunged before move `before`.
 *   { type: 'model', bytes, input, setups } -> { type: 'model', tris (part frame), overlap } or { type: 'model', error }:
 *   the real part (3D PDF or STL) read and laid on the simulated finished part, with how alike they
 *   are (match) and where they differ (pieces). Needs no 'init'.
 *   { type: 'search', bytes, code, brand } -> { type: 'searching', count, total, best } ...,
 *   { type: 'search', result, fix } or { type: 'search', error }: the turns that make the part like
 *   the model (fixTurns.ts), and the program with its M0 comments rewritten for them.
 */


/** The model's triangles (mm), or why it cannot be used. */
async function readTris(bytes: Uint8Array): Promise<Float32Array | { error: ModelError }> {
  if (bytes.length > MODEL_MAX_BYTES) return { error: 'tooBig' };
  let tris: Float32Array;
  try {
    tris = await readModel(bytes);
  } catch (e) {
    if (!(e instanceof PrcError) && !(e instanceof RangeError)) throw e;
    return { error: /no 3D model/.test(e.message) ? 'noModel' : /compressed/.test(e.message) ? 'compressed' : 'unreadable' };
  }
  if (tris.length > MODEL_MAX_TRIS * 9) return { error: 'tooBig' };
  if (tris.length < 9 || tris.some((v) => !Number.isFinite(v))) return { error: 'unreadable' };
  return tris;
}

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
  return { result, fix: result.same ? null : rewriteTurns(code, tp, result.orients, opts) };
}

let m: Mesher | null = null;
let g: Grid | null = null;
let input: SimInput | null = null;
let th: Float32Array | null = null;
let last = -1;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as
    | { type: 'init'; input: SimInput }
    | { type: 'mesh'; step: number; heat?: boolean }
    | { type: 'holes'; before: number }
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
  if (msg.type === 'holes' && g) {
    self.postMessage({ type: 'holes', before: msg.before, holes: drilledHoles(input!, g, msg.before) });
    return;
  }
  if (msg.type === 'init') {
    input = msg.input;
    g = carve(msg.input, (share) => self.postMessage({ type: 'progress', share }));
    m = mesher(g, msg.input);
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
    const full = last < 0 || measure;
    const ids = full ? Array.from({ length: m.chunks }, (_, i) => i) : m.dirty(last, msg.step);
    const chunks = ids.map((id) => {
      const c = m!.build(id, msg.step);
      return th ? { ...c, thick: thicknessAt(g!, th, c.positions) } : c;
    });
    last = msg.step;
    self.postMessage(
      { type: 'mesh', step: msg.step, full, chunks },
      { transfer: chunks.flatMap((c) => [c.positions.buffer, c.normals.buffer, c.cut.buffer, ...(c.thick ? [c.thick.buffer] : [])]) },
    );
  }
};
