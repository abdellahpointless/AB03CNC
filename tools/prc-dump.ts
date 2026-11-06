/**
 * Check the PDF model reader against STLs of the same parts.
 *   npm run prc-dump -- <part.pdf> <part.stl> [...]
 */
import { readFileSync } from 'node:fs';
import { readPdfModel } from '../src/lib/prc';

function stl(path: string): Float32Array {
  const buf = readFileSync(path);
  const n = buf.readUInt32LE(80);
  const out = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) out[i * 9 + k] = buf.readFloatLE(84 + i * 50 + 12 + k * 4);
  return out;
}
/** Box size and enclosed volume (signed tetrahedra) of a triangle list. */
function measure(t: Float32Array) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let vol = 0;
  for (let i = 0; i < t.length; i += 9) {
    for (let k = 0; k < 9; k++) (lo[k % 3] = Math.min(lo[k % 3], t[i + k])), (hi[k % 3] = Math.max(hi[k % 3], t[i + k]));
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t.subarray(i, i + 9);
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return { tris: t.length / 9, size: hi.map((v, k) => +(v - lo[k]).toFixed(2)), vol: Math.abs(vol) };
}
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  try {
    const m = await readPdfModel(new Uint8Array(readFileSync(args[i])));
    const a = measure(m);
    const b = measure(stl(args[i + 1]));
    console.log(`${args[i].split('/').pop()}: PDF ${a.tris} triangles ${a.size.join(' × ')} mm, ${a.vol.toFixed(0)} mm³ | STL ${b.tris} triangles ${b.size.join(' × ')}, ${b.vol.toFixed(0)} mm³ | volume ${((a.vol / b.vol) * 100).toFixed(2)} %`);
  } catch (e) {
    console.log(`${args[i].split('/').pop()}: ${(e as Error).message}`);
  }
}
