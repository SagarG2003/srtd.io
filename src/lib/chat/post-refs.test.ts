import { describe, expect, it } from 'vitest';
import {
  caretHashQuery,
  chipPostIds,
  chipTargetFor,
  filterRows,
  isCardMessage,
  newCardFor,
  newestCardFor,
  parentIndexOf,
  replyForSend,
  stripHashToken,
} from '@/lib/chat/post-refs';
import type { ThreadMessage } from '@/lib/chat/thread';

type Row = Pick<ThreadMessage, 'id' | 'sharedPostIds' | 'reply' | 'parentSharedPostIds' | 'mine'>;

function msg(id: string, over: Partial<Row> = {}): Row {
  return { id, sharedPostIds: [], reply: null, mine: false, ...over };
}

function replyTo(id: string, parent: string, over: Partial<Row> = {}): Row {
  return msg(id, { reply: { id: parent, authorUserId: null, preview: 'x' }, ...over });
}

describe('isCardMessage', () => {
  it('is true only for rows that share a post', () => {
    expect(isCardMessage(msg('a', { sharedPostIds: ['p1'] }))).toBe(true);
    expect(isCardMessage(msg('a'))).toBe(false);
  });
});

describe('chipTargetFor', () => {
  const rows = [msg('card', { sharedPostIds: ['p1', 'p2'] }), msg('plain')];
  const index = parentIndexOf(rows);

  it('targets a loaded card parent, on its first post', () => {
    expect(chipTargetFor(replyTo('r', 'card'), index)).toEqual({
      cardMessageId: 'card',
      postId: 'p1',
    });
  });

  it('falls back to the hydrated parentSharedPostIds when the parent is not loaded', () => {
    expect(chipTargetFor(replyTo('r', 'gone', { parentSharedPostIds: ['p9'] }), index)).toEqual({
      cardMessageId: 'gone',
      postId: 'p9',
    });
  });

  it('is null for a plain parent, an unknown parent and a non-reply', () => {
    expect(chipTargetFor(replyTo('r', 'plain'), index)).toBeNull();
    expect(chipTargetFor(replyTo('r', 'gone'), index)).toBeNull();
    expect(chipTargetFor(msg('r'), index)).toBeNull();
  });
});

describe('chipPostIds', () => {
  it('is the distinct sorted post ids of every chip', () => {
    const rows = [
      msg('c1', { sharedPostIds: ['pb'] }),
      msg('c2', { sharedPostIds: ['pa'] }),
      replyTo('r1', 'c1'),
      replyTo('r2', 'c1'),
      replyTo('r3', 'c2'),
      replyTo('r4', 'x', { parentSharedPostIds: ['pc'] }),
      msg('plain'),
    ];
    expect(chipPostIds(rows, parentIndexOf(rows))).toEqual(['pa', 'pb', 'pc']);
  });
});

describe('newestCardFor / newCardFor', () => {
  const rows = [
    msg('c1', { sharedPostIds: ['p1'] }),
    msg('c2', { sharedPostIds: ['p1'], mine: true }),
    msg('c3', { sharedPostIds: ['p2'], mine: true }),
  ];

  it('finds the newest card of a post', () => {
    expect(newestCardFor(rows, 'p1')?.id).toBe('c2');
    expect(newestCardFor(rows, 'p3')).toBeNull();
  });

  it('finds the own card a share queued, ignoring known ids', () => {
    expect(newCardFor(rows, new Set(['c1', 'c2', 'c3']), 'p1')).toBeNull();
    expect(newCardFor(rows, new Set(['c1']), 'p1')?.id).toBe('c2');
    expect(newCardFor(rows, new Set(), 'p1')?.id).toBe('c2');
  });
});

describe('filterRows', () => {
  it('keeps the post’s cards and the replies to them, in order', () => {
    const rows = [
      msg('a'),
      msg('c1', { sharedPostIds: ['p1'] }),
      replyTo('r1', 'c1'),
      msg('c2', { sharedPostIds: ['p2'] }),
      replyTo('r2', 'c2'),
      replyTo('r3', 'a'),
      msg('c3', { sharedPostIds: ['p2', 'p1'] }),
      replyTo('r4', 'c3'),
    ];
    expect(filterRows(rows, 'p1').map((r) => r.id)).toEqual(['c1', 'r1', 'c3', 'r4']);
    expect(filterRows(rows, 'p2').map((r) => r.id)).toEqual(['c2', 'r2', 'c3', 'r4']);
    expect(filterRows(rows, 'none')).toEqual([]);
  });
});

describe('replyForSend', () => {
  const reply = { id: 'reply', authorUserId: null, preview: 'r' };
  const about = { id: 'card', authorUserId: null, preview: 'Shared post' };

  it('reply wins, then about', () => {
    expect(replyForSend(reply, about, false)).toBe(reply);
    expect(replyForSend(null, about, false)).toBe(about);
    expect(replyForSend(null, null, false)).toBeNull();
  });

  it('a send that shares posts never replies to the About card', () => {
    expect(replyForSend(null, about, true)).toBeNull();
    expect(replyForSend(reply, about, true)).toBe(reply);
  });
});

const H = '#';

describe('caretHashQuery', () => {
  it('matches a hash token at the caret', () => {
    expect(caretHashQuery(H, 1)).toBe('');
    expect(caretHashQuery(`${H}lau`, 4)).toBe('lau');
    expect(caretHashQuery(`see ${H}14`, 7)).toBe('14');
    expect(caretHashQuery(`line\n${H}x`, 7)).toBe('x');
  });

  it('reads only up to the caret', () => {
    expect(caretHashQuery(`${H}abc def`, 3)).toBe('ab');
    expect(caretHashQuery(`${H}abc def`, 8)).toBeNull();
  });

  it('is null mid-word, after a space, or on a double hash', () => {
    expect(caretHashQuery(`a${H}b`, 3)).toBeNull();
    expect(caretHashQuery(`${H}ab `, 4)).toBeNull();
    expect(caretHashQuery(`${H}${H}`, 2)).toBeNull();
    expect(caretHashQuery(`${H}a${H}`, 3)).toBeNull();
    expect(caretHashQuery('plain', 5)).toBeNull();
  });

  it('clamps the caret', () => {
    expect(caretHashQuery(`${H}ab`, 99)).toBe('ab');
    expect(caretHashQuery(`${H}ab`, -1)).toBeNull();
  });
});

describe('stripHashToken', () => {
  it('removes the token and keeps the text around it', () => {
    expect(stripHashToken(`see ${H}14 now`, 7)).toEqual({ text: 'see  now', caret: 4 });
    expect(stripHashToken(`${H}lau`, 4)).toEqual({ text: '', caret: 0 });
    expect(stripHashToken(`a\n${H}`, 3)).toEqual({ text: 'a\n', caret: 2 });
  });

  it('leaves text without a token unchanged', () => {
    expect(stripHashToken('hello', 5)).toEqual({ text: 'hello', caret: 5 });
    expect(stripHashToken('hello', 50)).toEqual({ text: 'hello', caret: 5 });
  });
});
