// Reads one STEP file with OpenCascade, alone in this worker: its loader builds functions at run time, so only
// this file is served with a policy that allows that (worker/assets.ts). In: the file's bytes. Out: triangles and the
// exact face each lies on.
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import { stepMesh } from './step';

self.onmessage = async (e: MessageEvent<Uint8Array>) => {
  const m = await stepMesh(e.data, wasmUrl).catch(() => ({ tris: new Float32Array(), faces: new Int32Array() }));
  (postMessage as (m: { tris: Float32Array; faces: Int32Array }, transfer: Transferable[]) => void)(m, [m.tris.buffer, m.faces.buffer]);
};
