import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stepMesh } from '../src/lib/step';
import { recognizeFaces, type Feature } from '../src/lib/cam/recognize';

/*
 * The shape engine against its answer keys: every part in tests/models/feat-*.step, drawn with its shapes by
 * tools/test-part/make_feature_parts.py. Each shape found once, nothing found that is not there (strict: no field the
 * key does not give), sizes to 0.01 mm, boxes to 0.02 mm; and nothing between the part and its box unexplained.
 */

type Want = Omit<Feature, 'faces'>;
const PARTS = readdirSync('tests/models')
  .filter((f) => f.startsWith('feat-') && f.endsWith('.step'))
  .map((f) => f.slice(0, -5));

/** Why a found shape is not the one wanted ('' when it is). */
function differs(got: Feature, want: Want): string {
  const { faces: _faces, ...g } = got;
  const keys = new Set([...Object.keys(g), ...Object.keys(want)]);
  for (const k of keys) {
    const [a, b] = [(g as Record<string, unknown>)[k], (want as Record<string, unknown>)[k]];
    if (a === undefined || b === undefined) return `${k}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
    const tol = k === 'box' ? 0.02 : 0.01;
    if (typeof b === 'number' ? Math.abs((a as number) - b) > tol : Array.isArray(b) && typeof b[0] === 'number' ? (a as number[]).length !== b.length || (a as number[]).some((v, i) => Math.abs(v - (b[i] as number)) > tol) : JSON.stringify(a) !== JSON.stringify(b)) return `${k}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  return '';
}

describe('shape engine (step 2): the answer keys', () => {
  it.each(PARTS)('%s', async (name) => {
    const { tris, faces } = await stepMesh(new Uint8Array(readFileSync(`tests/models/${name}.step`)));
    const key: { features: Want[] } = JSON.parse(readFileSync(`tests/models/${name}.json`, 'utf8'));
    const r = recognizeFaces(tris, faces);
    const left = [...r.features];
    const missing: string[] = [];
    for (const w of key.features) {
      const i = left.findIndex((g) => !differs(g, w));
      if (i < 0) {
        const near = left.filter((g) => g.kind === w.kind).map((g) => differs(g, w));
        missing.push(`${JSON.stringify(w)}${near.length ? ` (nearest: ${near.join('; ')})` : ''}`);
      } else left.splice(i, 1);
    }
    expect(missing, 'shapes not found').toEqual([]);
    expect(left.map(({ faces: _f, ...x }) => x), 'shapes found that are not there').toEqual([]);
    expect(r.unexplained, 'material no shape explains').toEqual([]);
    expect(r.unowned, 'faces no shape is made of').toEqual([]);
  }, 60_000);
});
