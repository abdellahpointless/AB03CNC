import { describe, expect, it } from 'vitest';
import { MAX_CODE_BYTES, compressCode, decompressCode } from '../src/lib/codeStorage';

describe('stored programs', () => {
  it('come back as they were', async () => {
    const code = '%\nO1000\nN10 T2 M6\nN20 G0 X0 Y0\nN30 M30\n%';
    expect(await decompressCode(await compressCode(code))).toBe(code);
  });

  it('a file that unpacks to more than the limit is refused, not unpacked into memory', async () => {
    const bomb = await compressCode('0'.repeat(MAX_CODE_BYTES + 1));
    expect(bomb.data.length).toBeLessThan(1_000_000);
    await expect(decompressCode(bomb)).rejects.toThrow(/too large/);
  });
});
