/**
 * G-code files are gzip-compressed in the browser before upload (G-code
 * shrinks 5-10x), which keeps the database small and the server's CPU free.
 */

export interface StoredCode {
  encoding: 'gzip-base64' | 'plain';
  data: string;
  size: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function pipeThrough(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const piped = new Blob([bytes as BlobPart]).stream().pipeThrough(stream as unknown as TransformStream<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

export async function compressCode(code: string): Promise<StoredCode> {
  if (typeof CompressionStream === 'undefined') {
    return { encoding: 'plain', data: code, size: code.length };
  }
  const gz = await pipeThrough(new TextEncoder().encode(code), new CompressionStream('gzip'));
  return { encoding: 'gzip-base64', data: bytesToBase64(gz), size: code.length };
}

/** Far above any real program (the biggest shop programs are well under 1 MB). */
export const MAX_CODE_BYTES = 50_000_000;

/** Unpacks a stored program, refusing one that unpacks past MAX_CODE_BYTES (a "zip bomb" would freeze the PC). */
export async function decompressCode(stored: StoredCode): Promise<string> {
  if (stored.encoding === 'plain') return stored.data;
  const reader = new Blob([base64ToBytes(stored.data) as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>)
    .getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_CODE_BYTES) {
      await reader.cancel();
      throw new Error('This program is too large to open.');
    }
    parts.push(value);
  }
  return new TextDecoder().decode(await new Blob(parts as BlobPart[]).arrayBuffer());
}
