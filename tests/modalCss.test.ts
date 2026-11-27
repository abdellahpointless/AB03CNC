import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { transform } from 'lightningcss';

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

// The build's minifier (lightningcss, run by Tailwind) keeps only the last of two backdrop-filter lines.
// With -webkit- last, Chrome got no blur and the page behind showed through the dark pop-ups.
describe('glass blur', () => {
  it('keeps the unprefixed backdrop-filter after minifying', () => {
    const targets = { safari: (16 << 16) | (4 << 8), ios_saf: (16 << 16) | (4 << 8), firefox: 128 << 16, chrome: 111 << 16 }; // Tailwind's
    const out = transform({ filename: 'index.css', code: readFileSync('src/index.css'), minify: true, errorRecovery: true, targets }).code.toString();
    const rules = out.match(/[^{}]*\{[^{}]*-webkit-backdrop-filter[^{}]*\}/g) ?? [];
    expect(rules.length).toBeGreaterThan(5);
    for (const r of rules) expect(r).toMatch(/[;{]backdrop-filter:/);
  });
});
