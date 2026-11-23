import { describe, expect, it } from 'vitest';
import { hasProgramMark, PROGRAM_MARK } from '../src/lib/programMark';

describe("the planner's mark on its programs (the remapper keeps their tool numbers)", () => {
  it('is read on its own line, numbered or not, and the older mark too', () => {
    expect(hasProgramMark(`%\nO0001\nN1 ${PROGRAM_MARK}\nN2 G90`)).toBe(true);
    expect(hasProgramMark(`%\nO0001\n${PROGRAM_MARK}\n`)).toBe(true);
    expect(hasProgramMark('%\nO0001\nN1 (CAM AI)\n')).toBe(true);
    // Not inside another comment, not a look-alike.
    expect(hasProgramMark('%\nO0001\nN1 (PLATE 3D-MODELL)\n')).toBe(false);
    expect(hasProgramMark('%\nO0001\nN1 (DATUM DER ERSTELLUNG: 01.01.26 / BEARBEITER: X)\n')).toBe(false);
  });
});
