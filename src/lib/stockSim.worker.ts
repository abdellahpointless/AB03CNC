import { carve, mesher, type Mesher, type SimInput } from './stockSim';

/*
 * Cuts the part away from the UI thread. Messages:
 *   { type: 'init', input }  -> { type: 'progress', share } ..., { type: 'ready', size }
 *   { type: 'mesh', step }   -> { type: 'mesh', step, full, chunks: [{ id, positions, normals, cut }] }
 * Only the chunks that change between two steps are sent again.
 */

let m: Mesher | null = null;
let last = -1;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as { type: 'init'; input: SimInput } | { type: 'mesh'; step: number };
  if (msg.type === 'init') {
    const g = carve(msg.input, (share) => self.postMessage({ type: 'progress', share }));
    m = mesher(g);
    last = -1;
    self.postMessage({ type: 'ready', size: g.size });
    return;
  }
  if (msg.type === 'mesh' && m) {
    const full = last < 0;
    const ids = full ? Array.from({ length: m.chunks }, (_, i) => i) : m.dirty(last, msg.step);
    const chunks = ids.map((id) => m!.build(id, msg.step));
    last = msg.step;
    self.postMessage(
      { type: 'mesh', step: msg.step, full, chunks },
      { transfer: chunks.flatMap((c) => [c.positions.buffer, c.normals.buffer, c.cut.buffer]) },
    );
  }
};
