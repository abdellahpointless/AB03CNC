import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A dialog taller than the screen must scroll to its buttons: the glass modal's own clipping is layered,
// so a dialog's overflow-y-auto (a Tailwind utility, also layered but later) wins over it.
describe('glass modal', () => {
  it('sets no overflow outside the cascade layers', () => {
    const css = readFileSync('src/index.css', 'utf8');
    const unlayered = css.replace(/@layer[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    for (const rule of unlayered.match(/(^|\})\s*\.glass-modal\s*\{[^}]*\}/g) ?? []) expect(rule).not.toMatch(/overflow/);
    expect(css).toMatch(/@layer components\s*\{\s*\.glass-modal\s*\{[^}]*overflow:\s*hidden/);
  });
});
