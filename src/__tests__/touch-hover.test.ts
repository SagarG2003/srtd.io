// Guard: touch screens get no tap flash and no sticky hover. Tailwind's hover:
// variants only apply where a real hover pointer exists, and the base layer
// turns the browser tap highlight off app-wide.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import tailwindConfig from '../../tailwind.config';

describe('touch: no tap flash or sticky hover', () => {
  it('tailwind applies hover: only on devices that can hover', () => {
    expect(tailwindConfig.future).toEqual({ hoverOnlyWhenSupported: true });
  });

  it('index.css sets the tap highlight transparent on html', () => {
    const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');
    expect(css).toMatch(/html\s*\{\s*-webkit-tap-highlight-color:\s*transparent;\s*\}/);
  });
});
