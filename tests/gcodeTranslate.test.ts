import { describe, expect, it } from 'vitest';
import { translateCommentText, translateGcodeComments } from '../src/lib/gcodeTranslate';
import { codeOnly } from '../src/lib/gcodeProcessor';

describe('French G-code comments to English', () => {
  it('translates tool words and keeps the case', () => {
    expect(translateCommentText('POINTEUR D6')).toBe('SPOT DRILL D6');
    expect(translateCommentText('Foret 8.5')).toBe('Drill 8.5');
    expect(translateCommentText('AUTO-REMAP: T4 pointeur')).toBe('AUTO-REMAP: T4 spot drill');
    expect(translateCommentText('T12 fraise ebauche')).toBe('T12 roughing end mill');
    expect(translateCommentText('FRAISE FINITION D10')).toBe('FINISHING END MILL D10');
    expect(translateCommentText('TARAUD M6')).toBe('TAP M6');
  });

  it('handles accents, apostrophes and plurals', () => {
    expect(translateCommentText('ÉBAUCHE POCHE')).toBe('ROUGHING POCKET');
    expect(translateCommentText("FRAISE D'ÉBAUCHE D16")).toBe('ROUGHING END MILL D16');
    expect(translateCommentText('PERÇAGE 4 TROUS')).toBe('DRILLING 4 HOLES');
    expect(translateCommentText('ALÉSOIR 8H7')).toBe('REAMER 8H7');
  });

  it('does not take a tool number for a T-slot cutter', () => {
    expect(translateCommentText('FRAISE T5 D10')).toBe('END MILL T5 D10');
    expect(translateCommentText('fraise T')).toBe('T-slot cutter');
  });

  it('leaves words that only start with a French word alone', () => {
    expect(translateCommentText('FORETS')).toBe('DRILLS');
    expect(translateCommentText('PORTE-OUTIL BT40')).toBe('TOOL HOLDER BT40');
    expect(translateCommentText('TOOLING')).toBe('TOOLING');
  });

  it('never changes the machine code, only the comments', () => {
    const program = [
      'O1000 (PROGRAMME PIECE 12)',
      'N10 T4 M6 (POINTEUR D6)',
      'N20 G0 G90 G54 X0. Y0. S3000 M3',
      'N30 G43 H4 Z50. M8 (ARROSAGE)',
      'N40 G81 Z-2. R2. F100',
      'N50 T7 M6 (FORET 8.5)',
      'N60 M30',
    ].join('\n');
    const out = translateGcodeComments(program);
    expect(out.split('\n').map(codeOnly)).toEqual(program.split('\n').map(codeOnly));
    expect(out).toContain('(PROGRAM PART 12)');
    expect(out).toContain('(SPOT DRILL D6)');
    expect(out).toContain('(COOLANT)');
    expect(out).toContain('(DRILL 8.5)');
  });
});

describe('features per country', async () => {
  const { REGIONS, featuresOfApiPath } = await import('../src/regions');
  it('maps API paths to the optional features they need', () => {
    expect(featuresOfApiPath('/parts')).toEqual(['partTracking']);
    expect(featuresOfApiPath('/parts/pending')).toEqual(['partTracking']);
    expect(featuresOfApiPath('/admin/import/parts')).toEqual(['partTracking']);
    expect(featuresOfApiPath('/machines')).toEqual(['preventive']);
    expect(featuresOfApiPath('/machines/HAAS-1/checks')).toEqual(['preventive']);
    // Shift checks and the cales box only exist with preventive actions.
    expect(featuresOfApiPath('/machines/required')).toEqual(['preventive', 'shiftChecks']);
    expect(featuresOfApiPath('/machines/cales/stock')).toEqual(['preventive', 'shiftChecks']);
    expect(featuresOfApiPath('/machines/cales/requests/abc')).toEqual(['preventive', 'shiftChecks']);
    expect(featuresOfApiPath('/machines/HAAS-1/cales/report')).toEqual(['preventive', 'shiftChecks']);
    expect(featuresOfApiPath('/fleet')).toEqual([]);
    expect(featuresOfApiPath('/tools')).toEqual([]);
    expect(featuresOfApiPath('/partsx')).toEqual([]);
  });
  it('Türkiye only has the G-code remapper; Morocco keeps everything', () => {
    const [ma, tr] = REGIONS;
    expect(ma.features).toEqual({ partTracking: true, preventive: true, shiftChecks: true });
    expect(ma.gcodeComments).toBe('fr');
    expect(tr.features).toEqual({ partTracking: false, preventive: false, shiftChecks: false });
    expect(tr.gcodeComments).toBe('en');
  });
});
