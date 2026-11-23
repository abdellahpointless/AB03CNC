// STEP (.step/.stp) models: read with OpenCascade (occt-import-js, WebAssembly).
import occtimportjs from 'occt-import-js';

type Occt = { ReadStepFile: (buf: Uint8Array, params: Record<string, unknown> | null) => { success: boolean; meshes: { attributes: { position: { array: number[] } }; index: { array: number[] } }[] } };
let occt: Promise<Occt> | null = null;

/** A STEP file starts with this header line. */
export const isStep = (buf: Uint8Array) => new TextDecoder().decode(buf.subarray(0, 64)).trimStart().startsWith('ISO-10303-21');

/** Triangles (9 numbers each, mm) of a STEP file; empty when it cannot be read. `wasmUrl`: where a browser fetches the library. */
export async function stepTriangles(buf: Uint8Array, wasmUrl?: string): Promise<Float32Array> {
  occt ??= (occtimportjs as unknown as (o?: object) => Promise<Occt>)(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
  const lib = await occt;
  // shortcut: 0.01 mm chords, well inside the shop's 0.1 mm; finer only if a part ever needs it.
  const r = lib.ReadStepFile(buf, { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.01, angularDeflection: 0.1 });
  if (!r?.success) return new Float32Array();
  let n = 0;
  for (const m of r.meshes) n += m.index.array.length * 3;
  const out = new Float32Array(n);
  let k = 0;
  for (const m of r.meshes) {
    const p = m.attributes.position.array;
    for (const i of m.index.array) {
      out[k++] = p[3 * i];
      out[k++] = p[3 * i + 1];
      out[k++] = p[3 * i + 2];
    }
  }
  return out;
}

/** A STEP file's triangles: in a browser read in its own worker (step.worker.ts), in Node (tests, tools) here. */
export function readStep(buf: Uint8Array): Promise<Float32Array> {
  if (typeof Worker === 'undefined') return stepTriangles(buf);
  return new Promise((resolve) => {
    const w = new Worker(new URL('./step.worker.ts', import.meta.url), { type: 'module' });
    const done = (t: Float32Array) => {
      w.terminate();
      resolve(t);
    };
    w.onmessage = (e: MessageEvent<Float32Array>) => done(e.data);
    w.onerror = () => done(new Float32Array());
    w.postMessage(buf);
  });
}
