// STEP (.step/.stp) models: read with OpenCascade (occt-import-js, WebAssembly), in a web worker only.
import occtimportjs from 'occt-import-js';

/** Where the browser fetches the WebAssembly part (a private file), set by the worker that reads models. */
let wasmUrl: string | null = null;
export const setStepWasm = (url: string) => {
  wasmUrl = url;
};

type Occt = { ReadStepFile: (buf: Uint8Array, params: Record<string, unknown> | null) => { success: boolean; meshes: { attributes: { position: { array: number[] } }; index: { array: number[] } }[] } };
let occt: Promise<Occt> | null = null;

/** A STEP file starts with this header line. */
export const isStep = (buf: Uint8Array) => new TextDecoder().decode(buf.subarray(0, 64)).trimStart().startsWith('ISO-10303-21');

/** Triangles (9 numbers each, mm) of a STEP file; empty when it cannot be read. */
export async function readStep(buf: Uint8Array): Promise<Float32Array> {
  // In Node (tests, tools) the library finds its .wasm next to itself; a browser fetches it from wasmUrl.
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
