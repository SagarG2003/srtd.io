import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXPECT_CARD_MS,
  PAGE_HYDRATION_WAIT_MS,
  aboutState,
  admitRows,
  caretHashQuery,
  createCardExpectation,
  expectedCard,
  holdingFirstPage,
  hydrationDeadline,
  rowReady,
  chipPostIds,
  chipTargetFor,
  isCardMessage,
  newCardFor,
  newestCardFor,
  parentIndexOf,
  replyForSend,
  stripHashToken,
} from '@/lib/chat/post-refs';
import type { ThreadMessage } from '@/lib/chat/thread';

type Row = Pick<
  ThreadMessage,
  'id' | 'sharedPostIds' | 'reply' | 'parentSharedPostIds' | 'mine' | 'state' | 'time'
>;

let clock = 0;
function msg(id: string, over: Partial<Row> = {}): Row {
  clock += 1;
  return { id, sharedPostIds: [], reply: null, mine: false, state: 'sent', time: clock, ...over };
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

  it('finds the own outbox card a share queued, newest first, after the snapshot', () => {
    const loaded = [msg('a', { time: 10 }), msg('b', { time: 20 })];
    const expected = expectedCard(loaded, 'p1');
    expect(expected.after).toBe(20);
    const queued = [
      ...loaded,
      msg('new1', { time: 21, mine: true, state: 'sending', sharedPostIds: ['p1'] }),
      msg('new2', { time: 22, mine: true, state: 'sending', sharedPostIds: ['p1'] }),
    ];
    expect(newCardFor(queued, expected)?.id).toBe('new2');
  });

  it('never takes an older own card from a page loaded since, or a live echo', () => {
    const loaded = [msg('a', { time: 10 }), msg('b', { time: 20 })];
    const expected = expectedCard(loaded, 'p1');
    const olderPage = msg('old', { time: 5, mine: true, state: 'sending', sharedPostIds: ['p1'] });
    const echo = msg('echo', { time: 30, mine: true, state: 'sent', sharedPostIds: ['p1'] });
    const peer = msg('peer', { time: 31, state: 'sending', sharedPostIds: ['p1'] });
    const known = msg('b2', { time: 32, mine: true, state: 'sending', sharedPostIds: ['p2'] });
    expect(newCardFor([olderPage, ...loaded, echo, peer, known], expected)).toBeNull();
    // A known id never matches either.
    const again = expectedCard([...loaded, msg('k', { time: 25 })], 'p1');
    expect(
      newCardFor(
        [msg('k', { time: 40, mine: true, state: 'sending', sharedPostIds: ['p1'] })],
        again,
      ),
    ).toBeNull();
  });
});

describe('createCardExpectation', () => {
  const loaded = [msg('a', { time: 10 })];
  const card = msg('card', { time: 11, mine: true, state: 'sending', sharedPostIds: ['p1'] });

  it('resolves to the new card once, then stops waiting', () => {
    const wait = createCardExpectation();
    expect(wait.expect(loaded, 'p1', true)).toBe(true);
    expect(wait.resolve(loaded)).toBeNull();
    expect(wait.resolve([...loaded, card])).toEqual({ postId: 'p1', cardMessageId: 'card' });
    expect(wait.pending()).toBeNull();
    expect(wait.resolve([...loaded, card])).toBeNull();
  });

  it('clear 1: cannot send waits on nothing', () => {
    const wait = createCardExpectation();
    expect(wait.expect(loaded, 'p1', true)).toBe(true);
    expect(wait.expect(loaded, 'p1', false)).toBe(false);
    expect(wait.pending()).toBeNull();
    expect(wait.resolve([...loaded, card])).toBeNull();
  });

  it('clear 2: a conversation switch (clear) forgets it', () => {
    const wait = createCardExpectation();
    wait.expect(loaded, 'p1', true);
    wait.clear();
    expect(wait.resolve([...loaded, card])).toBeNull();
  });

  it('clear 3: forgotten after 30 s with no card', () => {
    vi.useFakeTimers();
    const wait = createCardExpectation();
    wait.expect(loaded, 'p1', true);
    vi.advanceTimersByTime(EXPECT_CARD_MS - 1);
    expect(wait.pending()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(wait.pending()).toBeNull();
    expect(wait.resolve([...loaded, card])).toBeNull();
    vi.useRealTimers();
  });
});

describe('admitRows (first paint final, page by page)', () => {
  const settled = new Set<string>();
  const readiness = (nowMs: number, rows: readonly Row[]) => {
    const parentIndex = parentIndexOf(rows);
    return (row: Row, since: number): boolean =>
      rowReady(row, since, { parentIndex, chipSettled: (id) => settled.has(id), nowMs });
  };
  const card = msg('card', { sharedPostIds: ['p1'], time: 10 });
  const chip = replyTo('r', 'card', { time: 11 });

  beforeEach(() => settled.clear());

  it('the first page shows nothing until every page row is ready, then everything', () => {
    const first = [card, chip];
    const a = admitRows(null, 't', first, readiness(0, first), 0);
    expect(a.rows).toEqual([]);
    expect(holdingFirstPage(a.gate)).toBe(true);
    settled.add('p1');
    const b = admitRows(a.gate, 't', first, readiness(1, first), 1);
    expect(b.rows).toBe(first);
    expect(holdingFirstPage(b.gate)).toBe(false);
  });

  it('R4: an own send during a pending older page shows on the next cut; sending to sent is not delayed', () => {
    settled.add('p1');
    const first = [card, chip];
    let gate = admitRows(null, 't', first, readiness(0, first), 0).gate;
    const older = [msg('c0', { sharedPostIds: ['p0'], time: 1 }), replyTo('r0', 'c0', { time: 2 })];
    const own = msg('own', { time: 12, mine: true, state: 'sending' });
    const withOlder = [...older, ...first, own];
    const cut = admitRows(gate, 't', withOlder, readiness(1, withOlder), 1);
    gate = cut.gate;
    expect(cut.rows.map((r) => r.id)).toEqual(['card', 'r', 'own']);
    const sent = { ...own, state: 'sent' as const };
    const next = [...older, ...first, sent];
    const cut2 = admitRows(gate, 't', next, readiness(2, next), 2);
    expect(cut2.rows.find((r) => r.id === 'own')?.state).toBe('sent');
    expect(cut2.rows.map((r) => r.id)).toEqual(['card', 'r', 'own']);
    // A live reply with an unread chip post shows at once (its chip comes later).
    const live = replyTo('live', 'c0', { time: 13 });
    const cut3 = admitRows(cut2.gate, 't', [...next, live], readiness(3, next), 3);
    expect(cut3.rows.map((r) => r.id)).toEqual(['card', 'r', 'own', 'live']);
    // The older page appears whole once its chip post settles.
    settled.add('p0');
    const all = [...next, live];
    const cut4 = admitRows(cut3.gate, 't', all, readiness(4, all), 4);
    expect(cut4.rows).toBe(all);
  });

  it('R3: a reply to a card on an unloaded page waits for hydration, then for its chip', () => {
    const raw: Row = {
      ...replyTo('r9', 'gone', { time: 5 }),
      reply: { id: 'gone', authorUserId: null, preview: '' },
    };
    let cut = admitRows(null, 't', [raw], readiness(0, [raw]), 0);
    expect(cut.rows).toEqual([]);
    expect(hydrationDeadline(cut.gate, [raw], parentIndexOf([raw]))).toBe(PAGE_HYDRATION_WAIT_MS);
    const hydrated: Row = {
      ...raw,
      reply: { id: 'gone', authorUserId: null, preview: 'Shared post' },
      parentSharedPostIds: ['p9'],
    };
    cut = admitRows(cut.gate, 't', [hydrated], readiness(1, [hydrated]), 1);
    expect(cut.rows).toEqual([]);
    expect(hydrationDeadline(cut.gate, [hydrated], parentIndexOf([hydrated]))).toBeNull();
    settled.add('p9');
    cut = admitRows(cut.gate, 't', [hydrated], readiness(2, [hydrated]), 2);
    expect(cut.rows.map((r) => r.id)).toEqual(['r9']);
  });

  it('a hydration that never lands is waited on for PAGE_HYDRATION_WAIT_MS, then shown as is', () => {
    const raw: Row = {
      ...replyTo('r9', 'gone', { time: 5 }),
      reply: { id: 'gone', authorUserId: null, preview: '' },
    };
    let cut = admitRows(null, 't', [raw], readiness(0, [raw]), 0);
    expect(cut.rows).toEqual([]);
    cut = admitRows(
      cut.gate,
      't',
      [raw],
      readiness(PAGE_HYDRATION_WAIT_MS - 1, [raw]),
      PAGE_HYDRATION_WAIT_MS - 1,
    );
    expect(cut.rows).toEqual([]);
    cut = admitRows(
      cut.gate,
      't',
      [raw],
      readiness(PAGE_HYDRATION_WAIT_MS, [raw]),
      PAGE_HYDRATION_WAIT_MS,
    );
    expect(cut.rows.map((r) => r.id)).toEqual(['r9']);
  });

  it('a conversation switch starts a fresh gate; removed rows are forgotten', () => {
    settled.add('p1');
    const first = [card, chip];
    const a = admitRows(null, 't1', first, readiness(0, first), 0);
    expect(a.rows).toBe(first);
    const b = admitRows(a.gate, 't2', [chip], readiness(1, [chip]), 1);
    expect(b.gate).not.toBe(a.gate);
    expect(b.rows.map((r) => r.id)).toEqual(['r']);
    const c = admitRows(b.gate, 't2', [], readiness(2, []), 2);
    expect(c.gate.shown.size).toBe(0);
  });
});

describe('aboutState', () => {
  it('visible, pending or gone', () => {
    expect(aboutState({ id: 'p1' })).toBe('visible');
    expect(aboutState(undefined)).toBe('pending');
    expect(aboutState(null)).toBe('gone');
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
