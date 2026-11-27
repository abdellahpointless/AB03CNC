import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// body inherits color-scheme from html; a dark one on body kept native controls dark in light mode.
describe('colour scheme', () => {
  it('is set on html only, so html.light reaches date fields and checkboxes', () => {
    const css = readFileSync('src/index.css', 'utf8');
    for (const rule of css.match(/(^|\})\s*[^{}]*\bbody\b[^{}]*\{[^}]*\}/g) ?? []) {
      if (!/printing-qr/.test(rule)) expect(rule).not.toMatch(/color-scheme/);
    }
    expect(css).toMatch(/html\.light\s*\{[^}]*color-scheme:\s*light/);
  });
});
