// STEP (.step/.stp) models: read with OpenCascade (occt-import-js, WebAssembly).
import occtimportjs from 'occt-import-js';

type Occt = { ReadStepFile: (buf: Uint8Array, params: Record<string, unknown> | null) => { success: boolean; meshes: { attributes: { position: { array: number[] } }; index: { array: number[] }; brep_faces?: { first: number; last: number }[] }[] } };
let occt: Promise<Occt> | null = null;

/** A STEP file starts with this header line. */
export const isStep = (buf: Uint8Array) => new TextDecoder().decode(buf.subarray(0, 64)).trimStart().startsWith('ISO-10303-21');

/** Triangles (9 numbers each, mm) of a STEP file; empty when it cannot be read. `wasmUrl`: where a browser fetches the library. */
export async function stepTriangles(buf: Uint8Array, wasmUrl?: string): Promise<Float32Array> {
  return (await stepMesh(buf, wasmUrl)).tris;
}

/**
 * A STEP file's triangles and, for each, the exact face of the file it lies on (0, 1, ... across its bodies; -1: none):
 * the faces CAM AI fits exactly (cam/faces.ts). Empty when it cannot be read.
 */
export async function stepMesh(buf: Uint8Array, wasmUrl?: string): Promise<{ tris: Float32Array; faces: Int32Array }> {
  occt ??= (occtimportjs as unknown as (o?: object) => Promise<Occt>)(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
  const lib = await occt;
  // 0.03 mm chords (17° at most round a small hole): as fine as the shop's 3D PDFs (0.01 to 0.05 mm, measured on
  // two). At 0.01 the STEP test parts came in with 2.5 to 3.5 times the triangles, read 3 to 5 times slower.
  const r = lib.ReadStepFile(buf, { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.03, angularDeflection: 0.3 });
  if (!r?.success) return { tris: new Float32Array(), faces: new Int32Array() };
  let n = 0;
  for (const m of r.meshes) n += m.index.array.length * 3;
  const out = new Float32Array(n);
  const faces = new Int32Array(n / 9).fill(-1);
  let k = 0;
  let t0 = 0;
  let f0 = 0;
  for (const m of r.meshes) {
    const p = m.attributes.position.array;
    for (const i of m.index.array) {
      out[k++] = p[3 * i];
      out[k++] = p[3 * i + 1];
      out[k++] = p[3 * i + 2];
    }
    const bf = m.brep_faces ?? [];
    bf.forEach((f, j) => {
      for (let t = Math.max(0, f.first); t <= f.last && t0 + t < faces.length; t++) faces[t0 + t] = f0 + j;
    });
    t0 += m.index.array.length / 3;
    f0 += bf.length;
  }
  return { tris: out, faces };
}

/** A STEP file's triangles: in a browser read in its own worker (step.worker.ts), in Node (tests, tools) here. */
export async function readStep(buf: Uint8Array): Promise<Float32Array> {
  return (await readStepMesh(buf)).tris;
}

/** A STEP file's triangles and their exact faces (stepMesh), read as readStep reads it. */
export function readStepMesh(buf: Uint8Array): Promise<{ tris: Float32Array; faces: Int32Array }> {
  if (typeof Worker === 'undefined') return stepMesh(buf);
  return new Promise((resolve) => {
    const w = new Worker(new URL('./step.worker.ts', import.meta.url), { type: 'module' });
    const done = (m: { tris: Float32Array; faces: Int32Array }) => {
      w.terminate();
      resolve(m);
    };
    w.onmessage = (e: MessageEvent<{ tris: Float32Array; faces: Int32Array }>) => done(e.data);
    w.onerror = () => done({ tris: new Float32Array(), faces: new Int32Array() });
    w.postMessage(buf);
  });
}
