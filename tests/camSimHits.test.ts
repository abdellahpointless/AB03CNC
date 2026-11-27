import { describe, expect, it } from 'vitest';
import { hitTools } from '../src/components/CamSim';
import type { SetupInfo } from '../src/lib/setups';

// An opened program said "283 tools into the vise" (every point of every hit, parallels too) while the 3D view said
// "172 tools reach the vise" (finding H1-26): both count tools now, each once, the vise apart from the parallels.
const setup = (hits: { tool: number | null; what?: 'holder' | 'holderPart' | 'cale' | 'spacer' }[]) => ({ collisions: hits }) as unknown as SetupInfo;

describe('the tools that hit', () => {
  it('counts each tool once, however many points of it hit', () => {
    const setups = [setup([{ tool: 9 }, { tool: 9 }, { tool: 9, what: 'holder' }, { tool: 4 }]), setup([{ tool: 9 }])];
    expect(hitTools(setups)).toEqual({ vise: 2, cales: 0 });
  });

  it('counts the parallels apart, a spacer (there to be cut into) not at all', () => {
    const setups = [setup([{ tool: 28, what: 'cale' }, { tool: 28, what: 'cale' }, { tool: 15, what: 'cale' }, { tool: 3, what: 'spacer' }])];
    expect(hitTools(setups)).toEqual({ vise: 0, cales: 2 });
  });

  it('never says none when a tool with no number hits', () => {
    expect(hitTools([setup([{ tool: null }])])).toEqual({ vise: 1, cales: 0 });
    expect(hitTools([setup([])])).toEqual({ vise: 0, cales: 0 });
  });
});
