import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stepMesh } from '../src/lib/step';
import { recognizeFaces, type Feature, type FeatureKind } from '../src/lib/cam/recognize';

/*
 * The shape engine against its answer keys: every test part in tests/models with a key next to it (feat-*: drawn for
 * it by tools/test-part/make_feature_parts.py; step-*: tools/test-part/make_step_parts.py). Each shape found once,
 * nothing found that is not there (strict: no field the key does not give), sizes to 0.01 mm, boxes to 0.02 mm; nothing
 * between the part and its box unexplained; the same however the part lies (turned to put each side up); and the check
 * names what a shape left out would have explained.
 */

type Want = Omit<Feature, 'faces'>;
type V = [number, number, number];
const PARTS = readdirSync('tests/models')
  .filter((f) => (f.startsWith('feat-') || f.startsWith('step-')) && f.endsWith('.step') && existsSync(`tests/models/${f.slice(0, -5)}.json`))
  .map((f) => f.slice(0, -5));

/** Why a found shape is not the one wanted ('' when it is). */
function differs(got: Feature, want: Want): string {
  const { faces: _faces, ...g } = got;
  const keys = new Set([...Object.keys(g), ...Object.keys(want)]);
  for (const k of keys) {
    const [a, b] = [(g as Record<string, unknown>)[k], (want as Record<string, unknown>)[k]];
    if (a === undefined || b === undefined) return `${k}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
    const tol = k === 'box' ? 0.02 : 0.01;
    const off = typeof b === 'number' ? Math.abs((a as number) - b) > tol : Array.isArray(b) && typeof b[0] === 'number' ? (a as number[]).length !== b.length || (a as number[]).some((v, i) => Math.abs(v - (b[i] as number)) > tol) : JSON.stringify(a) !== JSON.stringify(b);
    if (off) return `${k}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  return '';
}

/** What is wrong with a recognition against the key (empty: nothing). */
function compare(features: Feature[], key: Want[]): { missing: string[]; extra: Want[] } {
  const left = [...features];
  const missing: string[] = [];
  for (const w of key) {
    const i = left.findIndex((g) => !differs(g, w));
    if (i < 0) {
      const near = left.filter((g) => g.kind === w.kind).map((g) => differs(g, w));
      missing.push(`${JSON.stringify(w)}${near.length ? ` (nearest: ${near.join('; ')})` : ''}`);
    } else left.splice(i, 1);
  }
  return { missing, extra: left.map(({ faces: _f, ...x }) => x) };
}

const load = async (name: string) => {
  const { tris, faces } = await stepMesh(new Uint8Array(readFileSync(`tests/models/${name}.step`)));
  const key: { features: Want[] } = JSON.parse(readFileSync(`tests/models/${name}.json`, 'utf8'));
  return { tris, faces, key: key.features };
};

// Turns that put each of the six sides up (rows of the matrix).
const TURNS: { name: string; R: [V, V, V] }[] = [
  { name: 'X +90', R: [[1, 0, 0], [0, 0, -1], [0, 1, 0]] },
  { name: 'X 180', R: [[1, 0, 0], [0, -1, 0], [0, 0, -1]] },
  { name: 'X -90', R: [[1, 0, 0], [0, 0, 1], [0, -1, 0]] },
  { name: 'Y +90', R: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]] },
  { name: 'Y -90, Z +90', R: [[0, -1, 0], [0, 0, -1], [1, 0, 0]] },
];
const AX = ['X', 'Y', 'Z'];
const turn = (R: [V, V, V], p: V): V => R.map((row) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2]) as V;
const unitOf = (k: number, s = 1): V => [0, 1, 2].map((i) => (i === k ? s : 0)) as V;
const axisOf = (v: V) => v.findIndex((x) => Math.abs(x) > 0.5);
const others = (k: number) => [0, 1, 2].filter((i) => i !== k);
/** A key as it reads with the part turned by R. */
function turnKey(R: [V, V, V], w: Want): Want {
  const out: Want = { ...w, from: w.from.map((s) => {
    const v = turn(R, unitOf(AX.indexOf(s[0]), s[1] === '+' ? 1 : -1));
    const k = axisOf(v);
    return `${AX[k]}${v[k] > 0 ? '+' : '-'}`;
  }).sort() };
  if (w.axis && w.at) {
    const k = AX.indexOf(w.axis);
    const p: V = [0, 0, 0];
    others(k).forEach((i, n) => (p[i] = w.at![n]));
    const k2 = axisOf(turn(R, unitOf(k)));
    const q = turn(R, p);
    out.axis = AX[k2] as Feature['axis'];
    out.at = others(k2).map((i) => q[i]) as [number, number];
  }
  if (w.dir && w.on) {
    // Toward its upper end: Z up first, then Y, then X.
    const d = turn(R, w.dir);
    const k = [2, 1, 0].find((i) => Math.abs(d[i]) > 1e-3)!;
    out.dir = (d[k] > 0 ? d : d.map((v) => -v)) as V;
    out.on = turn(R, w.on);
  }
  if (w.box) {
    const pts = [0, 1, 2, 3, 4, 5, 6, 7].map((b) => turn(R, [w.box![b & 1 ? 3 : 0], w.box![b & 2 ? 4 : 1], w.box![b & 4 ? 5 : 2]]));
    out.box = [0, 1, 2, 0, 1, 2].map((k, i) => (i < 3 ? Math.min(...pts.map((p) => p[k])) : Math.max(...pts.map((p) => p[k])))) as Feature['box'];
  }
  return out;
}

describe('shape engine (step 2): the answer keys', () => {
  it.each(PARTS)('%s', async (name) => {
    const { tris, faces, key } = await load(name);
    const r = recognizeFaces(tris, faces);
    const { missing, extra } = compare(r.features, key);
    expect(missing, 'shapes not found').toEqual([]);
    expect(extra, 'shapes found that are not there').toEqual([]);
    expect(r.unexplained, 'material no shape explains').toEqual([]);
    expect(r.unowned, 'faces no shape is made of').toEqual([]);
  }, 60_000);

  it.each(PARTS)('%s, each side up', async (name) => {
    const { tris, faces, key } = await load(name);
    for (const { name: how, R } of TURNS) {
      const T = new Float32Array(tris.length);
      for (let i = 0; i < tris.length; i += 3) T.set(turn(R, [tris[i], tris[i + 1], tris[i + 2]]), i);
      const r = recognizeFaces(T, faces);
      const { missing, extra } = compare(r.features, key.map((w) => turnKey(R, w)));
      expect({ how, missing, extra, unexplained: r.unexplained, unowned: r.unowned }).toEqual({ how, missing: [], extra: [], unexplained: [], unowned: [] });
    }
  }, 120_000);
});

describe('shape engine (step 2): the check names what is not explained', () => {
  const left = (name: string, out: FeatureKind[]) => async () => {
    const { tris, faces } = await load(name);
    return recognizeFaces(tris, faces, undefined, { leaveOut: out }).unexplained.reduce((t, u) => t + u.mm3, 0);
  };
  // The check counts cells (0.25 to 0.3 mm here): within 5%, a thin shape (a 1 mm chamfer, four cells across) 20%.
  const near = (v: number, want: number, within = 0.05) => expect(Math.abs(v - want), `${v} mm3 for ${want}`).toBeLessThan(within * want);
  it('a pocket left out: its room, 20 x 20 x 10 less its R2 corners', async () => {
    near(await left('feat-step-pocket', ['pocket'])(), 4000 - 4 * (4 - Math.PI) * 10);
  }, 60_000);
  it('a hole left out: Ø6 under the pocket, 12 deep', async () => {
    near(await left('feat-pocket-hole', ['hole'])(), Math.PI * 9 * 12);
  }, 60_000);
  it('the slots left out: their rooms (the pocket holds none of it)', async () => {
    // The X slot's strip, 10 wide and 10 deep right across; the Y slot's, 8 wide and 6 deep, but where the X slot is.
    near(await left('feat-slot-pocket', ['slot'])(), 60 * 10 * 10 + 8 * 30 * 6);
  }, 60_000);
  it('the step under a body left out: named, not taken for an undercut (open from below)', async () => {
    // Under the body round the foot, 8 high, less the notch's column through it (its room is the notch's).
    near(await left('step-foot-under-body', ['step'])(), (30 * 24 - 16 * 12) * 8 - (Math.PI * 16) / 2 * 8);
  }, 60_000);
  it('the chamfers left out: four 1 mm top edges, less where the Ø6 hole cuts one', async () => {
    // Four edges' triangles, less the four corners where two meet (a third of a cube each) and the Ø6 hole's 6 mm.
    near(await left('feat-chamfer-holes', ['chamfer'])(), 0.5 * (2 * 40 + 2 * 30) - 4 / 3 - 0.5 * 6, 0.2);
  }, 60_000);
});
