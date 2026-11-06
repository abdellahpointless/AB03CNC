import { readTris } from '../model';
import type { ModelError } from '../modelLimits';
import { parseToolpath, speedsFor } from '../toolpath';
import { partLessonOf } from '../lessons';
import { camProgram, type CamInput } from './program';
import type { CamNote, Need } from './tools';

/*
 * CAM AI away from the screen (a part takes from seconds to a few minutes):
 *   CamRequest -> { type: 'progress', done, of } ..., then { type: 'done', result, lesson }
 *   or { type: 'error', error }.
 * lesson: the part record (lib/lessons) of the program made, for the learning records.
 */

export type CamRequest = Omit<CamInput, 'tris'> & { model: { name: string; bytes: Uint8Array } };

/** What the page shows of the result (the program and its proof, without the paths). */
export interface CamSummary {
  code: string;
  match: number;
  minutes: number;
  toolChanges: number;
  collisions: number;
  cales: number;
  size: number[];
  raw: number[];
  missing: Need[];
  notes: CamNote[];
  setups: { side: string; notes: string[]; ops: { name: string; tool: number; diameter: number; learned: boolean }[] }[];
}

export type CamMessage =
  | { type: 'progress'; done: number; of: number }
  | { type: 'done'; result: CamSummary; lesson: unknown }
  | { type: 'error'; error: ModelError | 'failed' };

const post = (m: CamMessage) => postMessage(m);

self.onmessage = async (e: MessageEvent<CamRequest>) => {
  const { model, ...input } = e.data;
  try {
    const tris = await readTris(model.bytes);
    if ('error' in tris) return post({ type: 'error', error: tris.error });
    post({ type: 'progress', done: 0, of: 3 });
    const r = camProgram({ ...input, tris }, (done, of) => post({ type: 'progress', done, of }));
    const tp = parseToolpath(r.code, input.speeds ?? speedsFor(input.brand));
    const lesson = await partLessonOf({ code: r.code, tp, model, match: r.check.match, pieces: r.check.pieces, brand: input.brand, source: 'cam' }).catch(() => null);
    post({
      type: 'done',
      lesson,
      result: {
        code: r.code,
        match: r.check.match,
        minutes: r.check.minutes,
        toolChanges: r.check.toolChanges,
        collisions: r.check.collisions,
        cales: r.check.cales,
        size: r.size,
        raw: r.raw,
        missing: r.missing,
        notes: r.notes,
        setups: r.setups.map((s) => ({
          side: s.side,
          notes: s.notes,
          ops: s.ops.map((o) => ({ name: o.name, tool: o.tool.number, diameter: o.tool.diameter, learned: o.cut.from !== 'default' })),
        })),
      },
    });
  } catch (err) {
    console.error(err);
    post({ type: 'error', error: 'failed' });
  }
};
