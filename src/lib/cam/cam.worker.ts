import { readTris } from '../model';
import type { ModelError } from '../modelLimits';
import { parseToolpath, speedsFor } from '../toolpath';
import { partLessonOf } from '../lessons';
import { camProgram, opSegments, type CamInput, type LiveEvent, type Purpose, type Zone } from './program';
import type { CamNote, Coolant, Need } from './tools';
import type { Contact, SetupCheck } from './physics';
import { layouts, type Layout } from './layouts';
import { bounds } from './geom';
import { pdfInfo } from '../pdfTitle';
import { partTypeOf, type PartType } from './partType';

/*
 * CAM AI away from the screen (a part takes from seconds to a few minutes):
 *   { type: 'prepare', model } -> { type: 'prepared', title, sap, partType, size, layouts, tris }
 *     (the model read, the name and family from its PDF, the ways it can lie in the vise), or
 *   CamRequest -> { type: 'progress', done, of } ..., then { type: 'done', result, lesson }
 *   or { type: 'error', error }.
 * lesson: the part record (lib/lessons) of the program made, for the learning records.
 */

export type CamRequest = Omit<CamInput, 'tris' | 'live'> & { model: { name: string; bytes: Uint8Array } };
export type PrepareRequest = { type: 'prepare'; model: { name: string; bytes: Uint8Array } };

export interface Prepared {
  /** From the PDF's title block (null for an STL or no title). */
  title: string | null;
  sap: string | null;
  partType: PartType | null;
  /** The model's size along its own X, Y, Z (mm). */
  size: number[];
  /** Best first (layouts.ts). */
  layouts: Layout[];
  /** The model's triangles, for the views of each layout. */
  tris: Float32Array;
}

/** What the page shows of the result (the program and its proof, without the paths). */
export interface CamSummary {
  code: string;
  match: number;
  minutes: number;
  toolChanges: number;
  collisions: number;
  cales: number;
  /** The largest piece cut out of the part that the model keeps (mm³): a gouge. */
  gouge: number;
  size: number[];
  raw: number[];
  missing: Need[];
  notes: CamNote[];
  /** The POM nests the part needs (rare): block size, pocket depth, screws, and the block's own program and check. */
  nests: { side: string; size: number[]; depth: number; screws: number; code: string; match: number; collisions: number; minutes: number }[];
  setups: {
    side: string;
    notes: string[];
    /** The part as held (setup frame: x0, y0, x1, y1; X along the jaws) and where the vise touches it. */
    box: [number, number, number, number];
    contact: Contact | null;
    /** Jaw grip (mm) and what the vise does to the part (clamp force, pressure, issues). */
    grip: number;
    physics: SetupCheck;
    /** learned: cutting data from the shop's templates or programs (false: a careful default). */
    ops: {
      name: string;
      purpose: Purpose;
      tool: number;
      diameter: number;
      length: number;
      code: string;
      type: string;
      inMachine: boolean;
      learned: boolean;
      /** Cutting values as programmed (rpm, mm/min, mm), its coolant, the deepest it goes (Z, setup frame). */
      s: number;
      f: number;
      ae: number;
      ap: number;
      coolant: Coolant;
      zMin: number;
      /** The operator's values are more than the tool takes. */
      unsafe: boolean;
    }[];
    /** Where precision matters (setup frame): the contour, thin walls, engraving. */
    zones: Zone[];
  }[];
}

export type CamMessage =
  | ({ type: 'prepared' } & Prepared)
  | { type: 'progress'; done: number; of: number }
  | { type: 'live'; e: LiveEvent }
  | { type: 'done'; result: CamSummary; lesson: unknown }
  | { type: 'error'; error: ModelError | 'failed' };

const post = (m: CamMessage) => postMessage(m);

self.onmessage = async (e: MessageEvent<CamRequest | PrepareRequest>) => {
  if ('type' in e.data && e.data.type === 'prepare') return prepare(e.data.model);
  const { model, ...input } = e.data as CamRequest;
  try {
    const tris = await readTris(model.bytes);
    if ('error' in tris) return post({ type: 'error', error: tris.error });
    post({ type: 'progress', done: 0, of: 3 });
    const r = camProgram({ ...input, tris, live: (ev) => post({ type: 'live', e: ev }) }, (done, of) => post({ type: 'progress', done, of }));
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
        gouge: Math.round(Math.max(0, ...r.check.pieces.filter((p) => p.kind === 'cut').map((p) => p.mm3))),
        size: r.size,
        raw: r.raw,
        missing: r.missing,
        notes: r.notes,
        nests: (r.nests ?? []).map((n) => ({ side: n.side, size: n.nest.size, depth: n.nest.pocket.depth, screws: n.nest.screws.length, code: n.code, match: n.check.match, collisions: n.check.collisions, minutes: n.check.minutes })),
        setups: r.setups.map((s) => ({
          side: s.side,
          notes: s.notes,
          grip: s.grip,
          physics: s.physics,
          zones: s.zones,
          box: s.box,
          contact: s.contact,
          ops: s.ops.map((o) => ({
            name: o.name,
            purpose: o.purpose,
            tool: o.tool.number,
            diameter: o.tool.diameter,
            length: o.tool.length,
            code: o.tool.code,
            type: o.tool.type,
            inMachine: o.tool.inMachine,
            learned: o.cut.from !== 'default',
            s: o.cut.s,
            f: o.cut.f,
            ae: o.cut.ae,
            ap: o.cut.ap,
            coolant: o.tool.edit?.coolant ?? 'flood',
            zMin: deepest(o.lines),
            unsafe: !!o.cut.unsafe,
          })),
        })),
      },
    });
  } catch (err) {
    console.error(err);
    post({ type: 'error', error: 'failed' });
  }
};

/** The lowest Z an operation's cuts reach (its setup frame, Z0 the top). */
function deepest(lines: string[]): number {
  const seg = opSegments(lines);
  let z = 0;
  for (let i = 2; i < seg.length; i += 3) z = Math.min(z, seg[i]);
  return Math.round(z * 100) / 100;
}

async function prepare(model: { name: string; bytes: Uint8Array }) {
  try {
    const tris = await readTris(model.bytes);
    if ('error' in tris) return post({ type: 'error', error: tris.error });
    const info = /\.pdf$/i.test(model.name) ? await pdfInfo(model.bytes).catch(() => null) : null;
    const b = bounds(tris);
    const list = layouts(tris);
    const out = new Float32Array(tris);
    (postMessage as (m: CamMessage, transfer: Transferable[]) => void)(
      { type: 'prepared', title: info?.title ?? null, sap: info?.sap ?? null, partType: partTypeOf(info?.title), size: [0, 1, 2].map((k) => b.max[k] - b.min[k]), layouts: list, tris: out },
      [out.buffer],
    );
  } catch (err) {
    console.error(err);
    post({ type: 'error', error: 'failed' });
  }
}

