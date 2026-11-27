import { describe, expect, it } from 'vitest';
import { setupMarkers } from '../src/lib/usePlayback';
import type { SetupInfo } from '../src/lib/setups';

/** Setups starting at these moves (the first setup has no marker); `turned`: each marker reads "n ⟳180° X ▭30". */
const at = (starts: (number | null)[], turned = false) =>
  [0, ...starts].map((m, index) => ({ index, moves: m === null ? null : [m, m + 1], rotation: turned ? { axis: 'X', deg: 180 } : null, support: turned ? 30 : null }) as SetupInfo);
/** On a 1000 px slider over 1000 moves: one move is one px. */
const shown = (starts: (number | null)[], turned = false, width = 1000) => setupMarkers(at(starts, turned), 1000, width).map((m) => [m.setup.index + 1, m.up, m.more]);

describe('setupMarkers', () => {
  it('keeps markers far apart on the slider row', () => {
    expect(shown([200, 500, 800])).toEqual([[2, false, 0], [3, false, 0], [4, false, 0]]);
  });
  it('puts a marker close to the one before it a row up, and back down once the slider row is free', () => {
    expect(shown([100, 140, 200])).toEqual([[2, false, 0], [3, true, 0], [4, false, 0]]);
  });
  it('joins a marker with no room on either row to the marker before it', () => {
    expect(shown([100, 120, 140, 400])).toEqual([[2, false, 0], [3, true, 1], [5, false, 0]]);
  });
  it('makes room for the longer labels, more so on a narrow slider', () => {
    expect(shown([100, 180, 260], true)).toEqual([[2, false, 0], [3, true, 0], [4, false, 0]]);
    expect(shown([100, 180, 260], true, 500)).toEqual([[2, false, 0], [3, true, 1]]);
  });
  it('never puts two markers on top of each other, and loses no setup', () => {
    const starts = [250, 270, 275, 290, 310, 400, 410, 440, 460, 470, 700, 720, 730, 750, 760];
    const many = setupMarkers(at(starts), 1000, 1000);
    // These labels ("7", "12 +3") are about 18 px plus 7 px a character, with room for " +9".
    const w = (n: number) => 18 + 7 * (String(n).length + 3);
    for (const up of [false, true]) {
      const row = many.filter((m) => m.up === up);
      expect(row.every((m, i) => i === 0 || (m.f - row[i - 1].f) * 1000 >= (w(m.setup.index + 1) + w(row[i - 1].setup.index + 1)) / 2)).toBe(true);
    }
    expect(many.reduce((n, m) => n + 1 + m.more, 0)).toBe(starts.length);
  });
  it('skips setups without moves', () => {
    expect(shown([null, 500])).toEqual([[3, false, 0]]);
  });
});
