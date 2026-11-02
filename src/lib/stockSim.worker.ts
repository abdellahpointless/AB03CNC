import { carve, mesher, thicknessAt, wallThickness, type Grid, type Mesher, type SimInput } from './stockSim';

/*
 * Cuts the part away from the UI thread. Messages:
 *   { type: 'init', input }  -> { type: 'progress', share } ..., { type: 'ready', size }
 *   { type: 'mesh', step, heat } -> { type: 'mesh', step, full, chunks: [{ id, positions, normals, cut, thick? }] }
 * thick: wall thickness of the finished part at each point (weak spots), measured the first time
 * heat is asked for (it takes a second on big parts), then sent with every chunk.
 * step is an instant of the program (move × SUB + share of the move, see stockSim), so the cut
 * follows the tool along a move. Only the chunks that change between two instants are sent again.
 */

let m: Mesher | null = null;
let g: Grid | null = null;
let input: SimInput | null = null;
let th: Float32Array | null = null;
let last = -1;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: 'init'; input: SimInput } | { type: 'mesh'; step: number; heat?: boolean };
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
