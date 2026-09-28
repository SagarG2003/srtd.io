import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Lint-style guard: chat stays token-only. Each banned literal is assembled from
// parts so this file does not trip its own check.
const BANNED = [
  ['dark', ':'],
  [String.fromCharCode(35)],
  ['bg-accent', '/'],
  ['bg-fg-3', '/'],
  ['text-[12px', ']'],
  ['rotate-', '180'],
  ['Attachment', 'Icons'],
].map((parts) => parts.join(''));

const DIR = fileURLToPath(new URL('.', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return [path];
  });
}

describe('src/components/chat token hygiene', () => {
  it('no chat file contains a banned literal', () => {
    const hits: string[] = [];
    for (const path of files(DIR)) {
      const text = readFileSync(path, 'utf8');
      for (const banned of BANNED) {
        if (text.includes(banned)) hits.push(`${path}: ${banned}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
