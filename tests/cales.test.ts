import { describe, expect, it } from 'vitest';
import { CALE_HEIGHTS, calesOf, calesSummary, lowStock, orderRows, statusOf } from '../src/lib/cales';

describe('cales box', () => {
  it('has the 14 heights of the real box, tallest first', () => {
    expect([...CALE_HEIGHTS]).toEqual([43, 42, 41, 40, 38, 35, 33, 30, 28, 25, 22, 20, 15, 8]);
  });

  it('reads one machine from the server rows; every other pair is in place', () => {
    const state = calesOf(
      [
        { machine_id: 'HAAS-1', height: 8, status: 'MISSING', count: 1 },
        { machine_id: 'HAAS-1', height: 41, status: 'MISSING', count: 2 },
        { machine_id: 'HAAS-1', height: 30, status: 'DAMAGED', count: 2 },
        { machine_id: 'FANUC-1', height: 43, status: 'DAMAGED', count: 1 },
      ],
      'HAAS-1',
    );
    expect(statusOf(state, 41)).toBe('missing');
    expect(statusOf(state, 30)).toBe('damaged');
    expect(statusOf(state, 43)).toBe('present');
    expect(calesSummary(state)).toEqual({ missing: [41, 8], damaged: [30], missingCales: 3, damagedCales: 2 });
  });

  it('orders what is missing or damaged and not covered by the spare stock (single cales)', () => {
    const rows = orderRows(
      [
        { machine_id: 'HAAS-1', height: 30, status: 'MISSING', count: 2 },
        { machine_id: 'HAAS-1', height: 43, status: 'DAMAGED', count: 1 },
        { machine_id: 'FANUC-1', height: 8, status: 'MISSING', count: 2 },
      ],
      [
        { machine_id: 'HAAS-1', height: 30, qty: 1 },
        { machine_id: 'HAAS-1', height: 43, qty: 5 },
        { machine_id: 'FANUC-1', height: 30, qty: 9 }, // another machine's stock does not count
      ],
    );
    expect(rows).toEqual([
      { machine_id: 'HAAS-1', height: 30, missing: 2, damaged: 0, stock: 1, toOrder: 1 },
      { machine_id: 'HAAS-1', height: 43, missing: 0, damaged: 1, stock: 5, toOrder: 0 },
      { machine_id: 'FANUC-1', height: 8, missing: 2, damaged: 0, stock: 0, toOrder: 2 },
    ]);
  });
});

describe('cales to order', () => {
  it('lists every machine and size under 4 spare cales, with what brings it back to 4', () => {
    const stock = CALE_HEIGHTS.map((h) => ({ machine_id: 'HAAS-1', height: h, qty: 4 }));
    stock[0] = { machine_id: 'HAAS-1', height: 43, qty: 1 };
    stock[13] = { machine_id: 'HAAS-1', height: 8, qty: 9 };
    const rows = lowStock(['HAAS-1'], stock);
    expect(rows).toEqual([{ machine_id: 'HAAS-1', height: 43, stock: 1, need: 3 }]);
    // a machine with no stock counted yet needs 4 of every size
    expect(lowStock(['FANUC-1'], stock).map((r) => r.need)).toEqual(CALE_HEIGHTS.map(() => 4));
  });
});
