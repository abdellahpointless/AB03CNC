import { afterEach, describe, expect, it } from 'vitest';
import { CALE_HEIGHTS, calesSummary, emptyCales, foundAll, loadCales, saveCales, setPair } from '../src/lib/cales';

describe('cales box', () => {
  it('has the 14 heights of the real box, tallest first', () => {
    expect([...CALE_HEIGHTS]).toEqual([43, 42, 41, 40, 38, 35, 33, 30, 28, 25, 22, 20, 15, 8]);
  });

  it('starts with every pair in place but not checked', () => {
    const s = calesSummary(emptyCales());
    expect(s).toEqual({ missing: [], damaged: [], allGood: false, verifiedAt: null });
  });

  it('lists missing and damaged pairs in box order', () => {
    const r = setPair(setPair(setPair(emptyCales(), 8, 'missing'), 41, 'missing'), 30, 'damaged');
    const s = calesSummary(r);
    expect(s.missing).toEqual([41, 8]);
    expect(s.damaged).toEqual([30]);
    expect(s.allGood).toBe(false);
  });

  it('"I found all the rest" confirms the box and keeps missing and damaged pairs as reported', () => {
    const r = foundAll(setPair(setPair(emptyCales(), 22, 'missing'), 30, 'damaged'), 1000);
    expect(r.status[22]).toBe('missing');
    expect(r.status[30]).toBe('damaged');
    expect(r.verifiedAt).toBe(1000);
    expect(calesSummary(r).allGood).toBe(false);
    expect(calesSummary(foundAll(emptyCales(), 5)).allGood).toBe(true);
  });

  it('does not change the record it was given', () => {
    const r = emptyCales();
    setPair(r, 25, 'missing');
    foundAll(r);
    expect(r.status[25]).toBe('present');
    expect(r.verifiedAt).toBeNull();
  });
});

describe('cales storage (this browser only, for the preview)', () => {
  const g = globalThis as { localStorage?: Storage };
  const original = g.localStorage;
  afterEach(() => {
    g.localStorage = original;
  });
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m } as unknown as Storage & { m: Map<string, string> };
  };

  it('saves and loads per machine', () => {
    g.localStorage = memory();
    saveCales('HAAS-1', foundAll(setPair(emptyCales(), 15, 'damaged'), 42));
    expect(loadCales('HAAS-1').status[15]).toBe('damaged');
    expect(loadCales('HAAS-1').verifiedAt).toBe(42);
    expect(loadCales('FANUC-1')).toEqual(emptyCales());
  });

  it('ignores broken or tampered data', () => {
    const s = memory();
    g.localStorage = s;
    s.setItem('cnc-cales-preview:HAAS-1', '{"status":{"43":"stolen","8":"missing"},"verifiedAt":"yesterday"}');
    const r = loadCales('HAAS-1');
    expect(r.status[43]).toBe('present');
    expect(r.status[8]).toBe('missing');
    expect(r.verifiedAt).toBeNull();
    s.setItem('cnc-cales-preview:HAAS-1', 'not json');
    expect(loadCales('HAAS-1')).toEqual(emptyCales());
  });

  it('keeps working when storage is not available', () => {
    g.localStorage = undefined;
    expect(() => saveCales('HAAS-1', emptyCales())).not.toThrow();
    expect(loadCales('HAAS-1')).toEqual(emptyCales());
  });
});
