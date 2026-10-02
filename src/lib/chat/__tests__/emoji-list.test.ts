import { describe, expect, it } from 'vitest';
import {
  EMOJI_LIST,
  EMOJI_RECENTS_KEY,
  EMOJI_RECENTS_MAX,
  insertAtCaret,
  pushRecent,
  readRecents,
  rememberRecent,
  type RecentsStorage,
} from '@/lib/chat/emoji-list';

function memory(): RecentsStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe('emoji list', () => {
  it('is a curated static list of about 200 in 6 groups', () => {
    expect(EMOJI_LIST).toHaveLength(6);
    const total = EMOJI_LIST.reduce((n, g) => n + g.emoji.length, 0);
    expect(total).toBeGreaterThanOrEqual(180);
    expect(total).toBeLessThanOrEqual(240);
  });
});

describe('T7 emoji recents', () => {
  it('caps at 16, newest first', () => {
    let row: string[] = [];
    for (let i = 0; i < 20; i += 1) row = pushRecent(row, `e${i}`);
    expect(row).toHaveLength(EMOJI_RECENTS_MAX);
    expect(row[0]).toBe('e19');
  });

  it('dedupes: a repeat moves to the front', () => {
    expect(pushRecent(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('persists to storage and reads back', () => {
    const store = memory();
    rememberRecent('👍', store);
    rememberRecent('🔥', store);
    expect(readRecents(store)).toEqual(['🔥', '👍']);
    expect(store.data.has(EMOJI_RECENTS_KEY)).toBe(true);
  });

  it('a throwing storage is handled', () => {
    const throwing: RecentsStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readRecents(throwing)).toEqual([]);
    expect(rememberRecent('👍', throwing)).toEqual(['👍']);
    expect(readRecents(null)).toEqual([]);
  });

  it('junk in storage reads as empty', () => {
    const store = memory();
    store.data.set(EMOJI_RECENTS_KEY, '{not json');
    expect(readRecents(store)).toEqual([]);
  });

  it('inserting keeps the caret just after the emoji', () => {
    expect(insertAtCaret('hello world', { start: 5, end: 5 }, '👍')).toEqual({
      value: 'hello👍 world',
      caret: 7,
    });
    expect(insertAtCaret('abc', { start: 1, end: 2 }, 'X')).toEqual({ value: 'aXc', caret: 2 });
  });
});
