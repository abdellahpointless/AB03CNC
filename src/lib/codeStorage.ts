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

export async function decompressCode(stored: StoredCode): Promise<string> {
  if (stored.encoding === 'plain') return stored.data;
  const bytes = await pipeThrough(base64ToBytes(stored.data), new DecompressionStream('gzip'));
  return new TextDecoder().decode(bytes);
}
