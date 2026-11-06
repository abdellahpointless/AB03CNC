import { describe, expect, it } from 'vitest';
import pdfUrl from './models/O2504411.pdf?inline';
import program from './models/O2504411.000.txt?raw';
import { partLessonOf } from '../src/lib/lessons';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';

const bytes = (url: string) => Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));
const gunzip64 = async (s: string) =>
  new Uint8Array(await new Response(new Blob([Uint8Array.from(atob(s), (c) => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());

describe('a part record', () => {
  it('keeps the model and the program (back to the same bytes) and how each operation was machined', async () => {
    const model = { name: 'TSP.pdf', bytes: bytes(pdfUrl) };
    const tp = parseToolpath(program, speedsFor('HAAS'));
    const r = await partLessonOf({ code: program, tp, model, match: 0.99, pieces: [], brand: 'HAAS', source: 'program' });
    expect(await gunzip64(r.model!)).toEqual(model.bytes);
    expect(new TextDecoder().decode(await gunzip64(r.program))).toBe(program);
    expect(r.material).toBe('ALU');
    expect(r.setups).toBe(3);
    expect(r.operations.length).toBeGreaterThan(5);
    expect(r.operations[0]).toMatchObject({ type: 'MK', kind: 'face' });
    expect(JSON.stringify(r).length).toBeLessThan(1_900_000);
  });
});
