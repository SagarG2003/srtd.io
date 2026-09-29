import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guard: chat feels live at all times. No connection-state or presence text in
// any UI copy; failures surface per message only (clock while pending, 'Not
// sent' plus retry on failure), and online is the dot on the photo only. Each
// banned word is assembled from parts so this file does not trip its own check.
const BANNED = [
  ['Re', 'connecting'],
  ['Con', 'necting'],
  ['Off', 'line'],
  ['On', 'line'],
  ['Last', ' seen'],
  ['last', ' seen'],
].map((parts) => parts.join(''));

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const ROOTS = [join(SRC, 'components'), join(SRC, 'lib', 'chat')];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Source with comments removed, so only code, strings and JSX text remain. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** A whole-word match, so SDK handler names like onReconnecting do not count. */
function wordPattern(word: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${word}(?![A-Za-z0-9_])`);
}

describe('no connection-state or presence copy', () => {
  it('src/components and src/lib/chat carry none of the banned words', () => {
    const hits: string[] = [];
    for (const path of ROOTS.flatMap(files)) {
      const code = stripComments(readFileSync(path, 'utf8'));
      for (const word of BANNED) {
        if (wordPattern(word).test(code)) hits.push(`${path}: ${word}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
