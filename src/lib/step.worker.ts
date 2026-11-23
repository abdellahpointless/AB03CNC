// Reads one STEP file with OpenCascade, alone in this worker: its loader builds functions at run time, so only
// this file is served with a policy that allows that (worker/assets.ts). In: the file's bytes. Out: triangles.
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import { stepTriangles } from './step';

self.onmessage = async (e: MessageEvent<Uint8Array>) => {
  const tris = await stepTriangles(e.data, wasmUrl).catch(() => new Float32Array());
  (postMessage as (m: Float32Array, transfer: Transferable[]) => void)(tris, [tris.buffer]);
};
