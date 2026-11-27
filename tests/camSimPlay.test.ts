import { describe, expect, it } from 'vitest';
import { toolRuns } from '../src/components/CamSim';

// "Play this tool" on a mill that runs twice in a clamping (its outline, then the roughing after a drill) plays both
// runs, not only the first one (finding H2-4).
describe("a tool's runs in one clamping", () => {
  const moves = [
    { setup: 0, tool: 3 },
    { setup: 0, tool: 28 },
    { setup: 0, tool: 28 },
    { setup: 0, tool: 15 },
    { setup: 0, tool: 28 },
    { setup: 0, tool: 28 },
    { setup: 0, tool: 28 },
    { setup: 1, tool: 28 },
  ];

  it('finds every run, each from its first move to the move after its last', () => {
    expect(toolRuns(moves, 0, 28)).toEqual([[1, 3], [4, 7]]);
  });

  it('keeps to the clamping asked', () => {
    expect(toolRuns(moves, 1, 28)).toEqual([[7, 8]]);
    expect(toolRuns(moves, 0, 3)).toEqual([[0, 1]]);
    expect(toolRuns(moves, 1, 3)).toEqual([]);
  });
});
