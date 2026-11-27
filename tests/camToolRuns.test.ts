import { describe, expect, it } from 'vitest';
import { changesAt } from '../src/components/CamAiResult';

// The tool list has one row per tool: a mill that comes in twice (its outline, then the roughing after the drills)
// says so, with its places in the clamping's tool changes (finding H1-40).
describe("a clamping's tool changes", () => {
  it('gives each tool every place it comes in', () => {
    const at = changesAt(['FM93', 'SF20', 'SF20', 'ZB', 'BO', 'SF20', 'BO6']);
    expect(at.get('SF20')).toEqual([2, 5]);
    expect(at.get('FM93')).toEqual([1]);
    expect(at.get('BO6')).toEqual([6]);
  });

  it('counts operations of one tool in a row as one tool change', () => {
    expect(changesAt(['SF8', 'SF8', 'SF8']).get('SF8')).toEqual([1]);
    expect(changesAt([]).size).toBe(0);
  });
});
