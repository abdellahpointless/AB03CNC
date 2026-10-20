import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, newRecoveryCodes, passwordProblem, verifyTotp } from '../security';
import { hashPassword, verifyPassword } from '../auth';
import { csvCell } from '../../src/lib/csv';

// RFC 6238 appendix B: ASCII secret "12345678901234567890", SHA-1, 8 digits -> last 6 digits here.
const RFC_SECRET = base32Encode(new TextEncoder().encode('12345678901234567890'));

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors', async () => {
    expect(await verifyTotp(RFC_SECRET, '287082', 0, 59_000)).toBe(1);
    expect(await verifyTotp(RFC_SECRET, '081804', 0, 1_111_111_109_000)).toBe(37037036);
    expect(await verifyTotp(RFC_SECRET, '005924', 0, 1_234_567_890_000)).toBe(41152263);
  });
  it('accepts one step of clock drift but not more', async () => {
    expect(await verifyTotp(RFC_SECRET, '287082', 0, 59_000 + 30_000)).toBe(1);
    expect(await verifyTotp(RFC_SECRET, '287082', 0, 59_000 + 90_000)).toBeNull();
  });
  it('refuses a code that was already used (replay)', async () => {
    expect(await verifyTotp(RFC_SECRET, '287082', 1, 59_000)).toBeNull();
  });
  it('refuses malformed codes', async () => {
    expect(await verifyTotp(RFC_SECRET, '28708', 0, 59_000)).toBeNull();
    expect(await verifyTotp(RFC_SECRET, '28708a', 0, 59_000)).toBeNull();
  });
  it('base32 round-trips', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes]);
  });
  it('makes 10 distinct recovery codes', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  });
});

describe('password policy', () => {
  it('needs 8 characters for machinists and 10 for admins', () => {
    expect(passwordProblem('Tq7#lmn', 'bob', 'MACHINIST')).toMatch(/at least 8/);
    expect(passwordProblem('Tq7#lmnop', 'bob', 'MACHINIST')).toBeNull();
    expect(passwordProblem('Tq7#lmnop', 'bob', 'ADMIN')).toMatch(/at least 10/);
    expect(passwordProblem('Tq7#lmnopqr', 'bob', 'ADMIN')).toBeNull();
  });
  it('refuses common, repeated and username-based passwords', () => {
    expect(passwordProblem('password123', 'bob', 'ADMIN')).toMatch(/common/);
    expect(passwordProblem('aaaaaaaaaaaa', 'bob', 'ADMIN')).toMatch(/common/);
    expect(passwordProblem('12345678901', 'bob', 'ADMIN')).toMatch(/common/);
    expect(passwordProblem('karim-the-best', 'Karim', 'ADMIN')).toMatch(/username/);
  });
});

describe('password hashing', () => {
  const plain = { DB: null as any, ASSETS: null as any };
  const peppered = { ...plain, AUTH_PEPPER: 'a-long-random-pepper-value-123456' };
  it('verifies without a pepper', async () => {
    const h = await hashPassword(plain, 'correct horse');
    expect(h.startsWith('pbkdf2-sha256$')).toBe(true);
    expect(await verifyPassword(plain, 'correct horse', h)).toBe(true);
    expect(await verifyPassword(plain, 'wrong', h)).toBe(false);
  });
  it('uses the pepper when set, and old hashes still verify', async () => {
    const oldHash = await hashPassword(plain, 'correct horse');
    const h = await hashPassword(peppered, 'correct horse');
    expect(h.startsWith('pbkdf2-sha256-p$')).toBe(true);
    expect(await verifyPassword(peppered, 'correct horse', h)).toBe(true);
    expect(await verifyPassword(peppered, 'correct horse', oldHash)).toBe(true);
    // A peppered hash is useless without the pepper (a stolen database alone is not enough).
    expect(await verifyPassword(plain, 'correct horse', h)).toBe(false);
    expect(await verifyPassword({ ...plain, AUTH_PEPPER: 'another-pepper-value-000000000' }, 'correct horse', h)).toBe(false);
  });
});

describe('CSV export', () => {
  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell('+cmd')).toBe(`"'+cmd"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('\tx')).toBe(`"'\tx"`);
  });
  it('leaves normal values and negative numbers alone', () => {
    expect(csvCell('O1234.nc')).toBe('"O1234.nc"');
    expect(csvCell(-12.5)).toBe('"-12.5"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell('-')).toBe('"-"');
  });
});
