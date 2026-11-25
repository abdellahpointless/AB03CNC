import { readTris } from '../model';
import type { ModelError } from '../modelLimits';
import { parseToolpath, speedsFor } from '../toolpath';
import { partLessonOf } from '../lessons';
import { JAW } from './clamp';
import { camProgram, editProgram, gougeOf, opSegments, type CamInput, type LiveEvent, type Purpose, type Zone } from './program';
import type { OpEdit } from './opEdit';
import type { CamNote, Coolant, Need } from './tools';
import type { Contact, SetupCheck } from './physics';
import { layouts, type Layout } from './layouts';
import { recognize, type Shape } from './shapes';
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
/** The last program made, its operations changed by hand (by operation key): answered with 'edited'. */
/** toolDb: the shop's tool database as it is now (a tool added since the make can be swapped in). */
export type EditRequest = { type: 'edit'; edits: Record<string, OpEdit>; toolDb?: CamRequest['toolDb'] };

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
  /** What the part is made of, named (shapes.ts). */
  shapes: Shape[];
}

/** What the page shows of the result (the program and its proof, without the paths). */
export interface CamSummary {
  code: string;
  match: number;
  minutes: number;
  toolChanges: number;
  collisions: number;
  /** Of them, tools or holders into the X stop below the jaw tops (the toolpath viewer does not mark these). */
  stops: number;
  cales: number;
  /** Clampings where the vise would hold the part off where the program puts it (CamCheck.misplaced). */
  misplaced: number;
  /** The simulated part has the model's size (CamCheck.sized): else stock stands out of it. */
  sized: boolean;
  /** The largest piece cut out of the part that the model keeps (mm³): a gouge. */
  gouge: number;
  size: number[];
  raw: number[];
  /** Where the blank was planned (model frame, centred on its box). */
  blank: { lo: number[]; hi: number[] };
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
    /** Its parallels (mm), the ones the designer may choose here, and CAM AI's own when the designer's are used. */
    cale: number;
    cales: number[];
    own?: number;
    /** Resting on the jaw tops by the face this deep under Z0 (no parallels). */
    onJaw?: number;
    /** The faces it could rest on the jaw tops by here, and how high each holds it (as the parallels' height would). */
    jaws: { depth: number; cale: number }[];
    /** learned: cutting data from the shop's templates or programs (false: a careful default). */
    ops: {
      /** The operation's name in the program (CamInput.skip removes by it). */
      key: string;
      name: string;
      /** Its time in the program: the tool change, the moves at their feed and rapid (s). */
      seconds: number;
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
  | { type: 'edited'; result: CamSummary }
  | { type: 'error'; error: ModelError | 'failed' };

const post = (m: CamMessage) => postMessage(m);

/** The last program made here, for edits by hand (you, Beta 2: items 10 and 11). */
let last: { input: CamInput; r: ReturnType<typeof camProgram> } | null = null;

self.onmessage = async (e: MessageEvent<CamRequest | PrepareRequest | EditRequest>) => {
  if ('type' in e.data && e.data.type === 'prepare') return prepare(e.data.model);
  if ('type' in e.data && e.data.type === 'edit') {
    if (!last) return post({ type: 'error', error: 'failed' });
    try {
      // Always from the program as made: the edits are the whole set the page has now.
      const r = editProgram(e.data.toolDb ? { ...last.input, toolDb: e.data.toolDb } : last.input, last.r, e.data.edits);
      return post({ type: 'edited', result: summaryOf(r, last.input) });
    } catch (err) {
      console.error(err);
      return post({ type: 'error', error: 'failed' });
    }
  }
  const { model, ...input } = e.data as CamRequest;
  try {
    const tris = await readTris(model.bytes);
    if ('error' in tris) return post({ type: 'error', error: tris.error });
    post({ type: 'progress', done: 0, of: 3 });
    const r = camProgram({ ...input, tris, live: (ev) => post({ type: 'live', e: ev }) }, (done, of) => post({ type: 'progress', done, of }));
    const tp = parseToolpath(r.code, input.speeds ?? speedsFor(input.brand));
    const lesson = await partLessonOf({ code: r.code, tp, model, match: r.check.match, pieces: r.check.pieces, brand: input.brand, source: 'cam' }).catch(() => null);
    // Kept for edits by hand (editProgram): the plan and what it was made from.
    last = { input: { ...input, tris }, r };
    post({ type: 'done', lesson, result: summaryOf(r, input) });
  } catch (err) {
    console.error(err);
    post({ type: 'error', error: 'failed' });
  }
};

/**
 * Each operation's time in its program: its moves (the program writes an operation as one run of
 * moves under its "(TOOLPATH name)" line) and the tool change that starts it. Key: setup|operation.
 */
function opSeconds(tp: ReturnType<typeof parseToolpath>, setups: { ops: { name: string }[] }[], toolChange: number): Map<string, number> {
  const runs: { setup: number; op: string; seconds: number }[] = [];
  for (const m of tp.moves) {
    const last = runs[runs.length - 1];
    if (last && last.setup === m.setup && last.op === (m.op ?? '')) last.seconds += m.seconds;
    else runs.push({ setup: m.setup, op: m.op ?? '', seconds: m.seconds });
  }
  const out = new Map<string, number>();
  setups.forEach((s, i) => {
    let at = 0;
    s.ops.forEach((o, k) => {
      const j = runs.findIndex((r, n) => n >= at && r.setup === i && r.op === o.name);
      if (j < 0) return;
      at = j + 1;
      out.set(`${i}|${k}`, Math.round(runs[j].seconds + toolChange));
    });
  });
  return out;
}

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
      { type: 'prepared', title: info?.title ?? null, sap: info?.sap ?? null, partType: partTypeOf(info?.title), size: [0, 1, 2].map((k) => b.max[k] - b.min[k]), layouts: list, tris: out, shapes: recognize(out) },
      [out.buffer],
    );
  } catch (err) {
    console.error(err);
    post({ type: 'error', error: 'failed' });
  }
}

/** The page's view of a program (what the worker keeps is the whole plan, for edits). */
function summaryOf(r: ReturnType<typeof camProgram>, input: Omit<CamRequest, 'model'>): CamSummary {
  const tp = parseToolpath(r.code, input.speeds ?? speedsFor(input.brand));
  const secondsOf = opSeconds(tp, r.setups, (input.speeds ?? speedsFor(input.brand)).toolChange);
  return {
    code: r.code,
    match: r.check.match,
    minutes: r.check.minutes,
    toolChanges: r.check.toolChanges,
    collisions: r.check.collisions,
    stops: r.check.stops,
    cales: r.check.cales,
    misplaced: r.check.misplaced,
    sized: r.check.sized,
    gouge: gougeOf(r.check),
    size: r.size,
    raw: r.raw,
    blank: r.blank,
    missing: r.missing,
    notes: r.notes,
    nests: (r.nests ?? []).map((n) => ({ side: n.side, size: n.nest.size, depth: n.nest.pocket.depth, screws: n.nest.screws.length, code: n.code, match: n.check.match, collisions: n.check.collisions, minutes: n.check.minutes })),
    setups: r.setups.map((s, i) => ({
      side: s.side,
      notes: s.notes,
      grip: s.grip,
      physics: s.physics,
      cale: s.cale,
      cales: s.cales,
      ...(s.own !== undefined ? { own: s.own } : {}),
      ...(s.onJaw !== undefined ? { onJaw: s.onJaw } : {}),
      // The stock's bottom over the table is floor + cale; on a face d deep the jaws grip -d - bottom of it.
      jaws: s.vise && !s.nest ? s.ledges.map((d) => ({ depth: d, cale: JAW - (-d - (s.vise!.floor + s.cale)) })) : [],
      zones: s.zones,
      box: s.box,
      contact: s.contact,
      ops: s.ops.map((o, k) => ({
        key: o.key ?? `${s.side}|${o.name}|${o.tool.code}|${k}`,
        seconds: secondsOf.get(`${i}|${k}`) ?? 0,
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
  };
}
