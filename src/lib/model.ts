import { PrcError, readPdfModel } from './prc';
import { MODEL_MAX_BYTES, MODEL_MAX_TRIS, type ModelError } from './modelLimits';

/** Triangles (9 numbers each, mm) of a binary or text STL. */
export function readStl(buf: Uint8Array): Float32Array {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = buf.length >= 84 ? dv.getUint32(80, true) : 0;
  if (buf.length === 84 + count * 50) {
    const out = new Float32Array(count * 9);
    for (let i = 0; i < count; i++) for (let k = 0; k < 9; k++) out[i * 9 + k] = dv.getFloat32(84 + i * 50 + 12 + k * 4, true);
    return out;
  }
  const v = [...new TextDecoder().decode(buf).matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].flatMap((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  return Float32Array.from(v);
}

/** The part's model from a 3D PDF or an STL, by its first bytes. */
export function readModel(buf: Uint8Array): Promise<Float32Array> | Float32Array {
  return String.fromCharCode(buf[0], buf[1], buf[2], buf[3], buf[4]) === '%PDF-' ? readPdfModel(buf) : readStl(buf);
}

/** The model's triangles (mm), or why it cannot be used. */
export async function readTris(bytes: Uint8Array): Promise<Float32Array | { error: ModelError }> {
  if (bytes.length > MODEL_MAX_BYTES) return { error: 'tooBig' };
  let tris: Float32Array;
  try {
    tris = await readModel(bytes);
  } catch (e) {
    if (!(e instanceof PrcError) && !(e instanceof RangeError)) throw e;
    return { error: /no 3D model/.test(e.message) ? 'noModel' : /compressed/.test(e.message) ? 'compressed' : 'unreadable' };
  }
  if (tris.length > MODEL_MAX_TRIS * 9) return { error: 'tooBig' };
  if (tris.length < 9 || tris.some((v) => !Number.isFinite(v))) return { error: 'unreadable' };
  return tris;
}
