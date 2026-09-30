import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client, Result } from '@srtdio/rpc';
import { READ_TIMEOUT_MS, listChannelClears, listChannelSummaries } from '@/lib/chat-reads';
import {
  latestPerChannel,
  loadConversationPreviews,
  loadLatestMessages,
  loadMessageById,
  loadMessagesByIds,
  loadNewerMessages,
  loadOlderMessages,
  loadPeerReadCursor,
  loadReactions,
  loadUnreadCounts,
  rowPreviewContent,
  type PreviewRow,
} from '@/lib/chat/history';
import {
  applyEditedPreview,
  applyIncoming,
  applyPreviews,
  initialState,
  loadReady,
  messagePreviewContent,
  OWN_PREFIX,
  PREVIEW_LABELS,
  previewPrefix,
  previewText,
  updateOwnMessage,
  type ChatStoreState,
} from '@/lib/chat/chat-store';
import { runLatestLoad } from '@/lib/chat/use-chat-thread';
import { anchorAfterOlderLoad } from '@/lib/chat/stick-to-bottom';
import { CARD_READ_CHUNK, createSharedCardCache } from '@/lib/chat/shared-cards';
import type { ChannelSummary, ChatProfile } from '@/lib/chat-reads';
import type { ThreadMessage } from '@/lib/chat/thread';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** A client whose every query and rpc never answers (a hung request). */
function hangingClient(): Client {
  const builder: object = new Proxy(
    {},
    {
      get: (_target, key) => (key === 'then' ? () => {} : () => builder),
    },
  );
  return { from: () => builder, rpc: () => builder } as unknown as Client;
}

afterEach(() => {
  vi.useRealTimers();
});

/** Resolves only after exactly READ_TIMEOUT_MS, to a failed Result. */
async function expectTimesOutAt5s<T>(start: () => Promise<Result<T>>): Promise<void> {
  vi.useFakeTimers();
  let settled = false;
  const pending = start().then((r) => {
    settled = true;
    return r;
  });
  await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true);
  const result = await pending;
  expect(result.ok).toBe(false);
  vi.useRealTimers();
}

describe('P1: every chat read times out at 5s and fails', () => {
  const db = hangingClient();
  const cursor = { createdAt: '2026-09-30T00:00:00Z', id: 'm1' };
  const reads: Array<[string, () => Promise<Result<unknown>>]> = [
    [
      'listChannelSummaries',
      () => listChannelSummaries(db, { workspaceId: 'w', currentUserId: 'u' }),
    ],
    ['listChannelClears', () => listChannelClears(db, { workspaceId: 'w' })],
    ['loadConversationPreviews', () => loadConversationPreviews(db, 'w')],
    ['loadUnreadCounts', () => loadUnreadCounts(db, 'w')],
    ['loadLatestMessages', () => loadLatestMessages(db, 'c')],
    ['loadOlderMessages', () => loadOlderMessages(db, 'c', cursor)],
    ['loadNewerMessages', () => loadNewerMessages(db, 'c', cursor)],
    ['loadMessagesByIds', () => loadMessagesByIds(db, ['m1'])],
    ['loadReactions', () => loadReactions(db, ['m1'], 'u')],
    ['loadPeerReadCursor', () => loadPeerReadCursor(db, 'c', 'peer')],
    ['loadMessageById', () => loadMessageById(db, 'm1')],
  ];
  for (const [name, start] of reads) {
    it(`${name} resolves to a failure at 5s`, async () => {
      await expectTimesOutAt5s(start);
    });
  }
});

describe('P2: thread history failure and Retry', () => {
  it('a failed or timed-out latest page is the failed outcome; Retry re-runs and succeeds', async () => {
    const page = { rows: [], hasMore: false };
    const load = vi
      .fn<() => Promise<Result<typeof page>>>()
      .mockResolvedValueOnce({ ok: false, error: { code: 'unknown', message: 'read timed out' } })
      .mockResolvedValueOnce({ ok: true, data: page });
    expect(await runLatestLoad(load)).toEqual({ kind: 'failed', message: 'read timed out' });
    expect(await runLatestLoad(load)).toEqual({ kind: 'page', page });
    expect(load).toHaveBeenCalledTimes(2);
    // A rejection is a failure too, never a stuck skeleton.
    expect(await runLatestLoad(() => Promise.reject(new Error('boom')))).toMatchObject({
      kind: 'failed',
    });
  });

  it('a failed older page lets go of the anchor, so scrolling up retries it', () => {
    expect(anchorAfterOlderLoad({ anchored: true, loadEnded: true, messagesChanged: false })).toBe(
      false,
    );
  });
});

const ME = 'me-0000';
const ANA = 'ana-0000';

function roster(channelId: string, channelType: 'dm' | 'group'): ChannelSummary {
  return {
    channelId,
    channelType,
    title: channelId,
    avatarUrl: null,
    agoraGroupId: null,
    groupId: null,
    peerUserId: null,
    createdAt: '2026-09-01T00:00:00Z',
  };
}

function ready(
  previews: Parameters<typeof applyPreviews>[1],
  nameOf?: (id: string) => string | undefined,
): ChatStoreState {
  return loadReady(
    { ...initialState(), scope: 's' },
    {
      scope: 's',
      roster: [roster('g1', 'group'), roster('d1', 'dm')],
      clears: [],
      previews,
      counts: [],
      currentUserId: ME,
      ...(nameOf !== undefined ? { nameOf } : {}),
    },
  );
}

function preview(channelId: string, senderUserId: string | null, body: string, id = 'm1') {
  return {
    channelId,
    messageId: id,
    senderUserId,
    createdAt: '2026-09-30T10:00:00Z',
    ...rowPreviewContent(row({ body })),
  };
}

function row(over: Partial<PreviewRow>): PreviewRow {
  return {
    body: null,
    attachment_asset_ids: null,
    attachment_meta: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    ...over,
  };
}

describe('P3: group list preview names the sender', () => {
  it('"<first name>: text" in a group, "You: text" for own, no prefix in a DM', () => {
    const names = (id: string) => (id === ANA ? 'Ana Maria Lopez' : undefined);
    const state = ready([preview('g1', ANA, 'hello team'), preview('d1', ANA, 'hi', 'm2')], names);
    expect(state.conversations.g1).toMatchObject({
      lastMessagePrefix: 'Ana',
      lastMessageText: 'hello team',
    });
    expect(state.conversations.d1?.lastMessagePrefix).toBeUndefined();
    const own = ready([preview('g1', ME, 'mine')], names);
    expect(own.conversations.g1?.lastMessagePrefix).toBe(OWN_PREFIX);
  });

  it('a sender whose name is not loaded gets no prefix (never "Someone" or blank)', () => {
    const state = ready([preview('g1', 'stranger', 'hello')], () => undefined);
    expect(state.conversations.g1?.lastMessagePrefix).toBeUndefined();
    expect(state.conversations.g1?.lastMessageText).toBe('hello');
    expect(
      previewPrefix({ senderUserId: 'x', currentUserId: ME, isGroup: true, nameOf: () => '  ' }),
    ).toBeUndefined();
  });

  it('the live line carries the same prefix', () => {
    const prefix = previewPrefix({
      senderUserId: ANA,
      currentUserId: ME,
      isGroup: true,
      nameOf: () => 'Ana Lopez',
    });
    const next = applyIncoming(ready([]), {
      channelId: 'g1',
      messageId: 'm9',
      senderIsSelf: false,
      text: 'live',
      ...(prefix !== undefined ? { prefix } : {}),
      ts: 1,
    });
    expect(next.conversations.g1).toMatchObject({
      lastMessagePrefix: 'Ana',
      lastMessageText: 'live',
    });
  });
});

describe('P4: preview text for a message with no body', () => {
  const img = { assetId: 'a1', name: 'p.png', mime: 'image/png' };
  const pdf = { assetId: 'a2', name: 'a.pdf', mime: 'application/pdf' };
  const voice = { assetId: 'a3', name: 'v.webm', mime: 'audio/webm' };
  const cases: Array<[string, Partial<ThreadMessage>, string]> = [
    ['shared post', { sharedPostIds: ['p1'] }, 'Post'],
    ['shared brief', { sharedBriefIds: ['b1'] }, 'Brief'],
    ['image', { attachments: [img] }, 'Photo'],
    ['images', { attachments: [img, img] }, '2 photos'],
    ['file', { attachments: [pdf] }, 'File'],
    ['voice', { attachments: [voice] }, 'Voice message'],
    ['mixed post + photo', { sharedPostIds: ['p1'], attachments: [img] }, 'Post'],
    ['mixed voice + file', { attachments: [voice, pdf] }, 'File'],
    ['mixed brief + photo', { sharedBriefIds: ['b1'], attachments: [img] }, 'Brief'],
  ];

  function message(over: Partial<ThreadMessage>): ThreadMessage {
    return {
      id: 'm1',
      senderUserId: ME,
      body: '',
      createdAt: '2026-09-30T10:00:00Z',
      time: 0,
      provisionalTime: false,
      mine: true,
      attachments: [],
      sharedPostIds: [],
      sharedBriefIds: [],
      reply: null,
      state: 'sent',
      status: 'sent',
      reactions: [],
      ...over,
    };
  }

  function rowOf(m: ThreadMessage): PreviewRow {
    return row({
      body: m.body,
      attachment_asset_ids: m.attachments.map((a) => a.assetId),
      attachment_meta: Object.fromEntries(
        m.attachments.map((a) => [a.assetId, { name: a.name, mime: a.mime }]),
      ),
      shared_post_ids: m.sharedPostIds,
      shared_brief_ids: m.sharedBriefIds,
    });
  }

  for (const [label, over, expected] of cases) {
    it(`${label} -> "${expected}": live, reload and own send agree`, () => {
      const m = message(over);
      const live = previewText(rowPreviewContent(rowOf(m)));
      const [reload] = latestPerChannel([
        { id: 'm1', channel_id: 'c1', sender_user_id: ME, created_at: m.createdAt, ...rowOf(m) },
      ]);
      const own = previewText(messagePreviewContent(m));
      expect(live).toBe(expected);
      expect(reload !== undefined ? previewText(reload) : null).toBe(expected);
      expect(own).toBe(expected);
    });
  }

  it('own attachment-only send reads "You: Photo" (never an empty line)', () => {
    const state = updateOwnMessage(ready([]), {
      channelId: 'd1',
      text: previewText(messagePreviewContent(message({ attachments: [img] }))),
      ts: 1,
    });
    expect(state.conversations.d1).toMatchObject({
      lastMessagePrefix: OWN_PREFIX,
      lastMessageText: PREVIEW_LABELS.photo,
    });
  });

  it('a body always wins', () => {
    expect(previewText(messagePreviewContent(message({ body: 'hi', sharedPostIds: ['p'] })))).toBe(
      'hi',
    );
  });
});

describe('P5: an edit updates the list line only when it is the latest', () => {
  it('edit of the latest message updates the line; sender and time stay', () => {
    const state = ready([preview('g1', ANA, 'before', 'latest')], () => 'Ana');
    const next = applyEditedPreview(state, { channelId: 'g1', messageId: 'latest', text: 'after' });
    expect(next.conversations.g1).toMatchObject({
      lastMessageText: 'after',
      lastMessagePrefix: 'Ana',
      lastMessageTs: state.conversations.g1?.lastMessageTs,
    });
  });

  it('edit of an older message changes nothing', () => {
    const state = ready([preview('g1', ANA, 'before', 'latest')]);
    expect(applyEditedPreview(state, { channelId: 'g1', messageId: 'older', text: 'x' })).toBe(
      state,
    );
  });
});

interface Post {
  id: string;
  approved_by: string | null;
}
interface Brief {
  id: string;
}

function cardReaders(over: Partial<Parameters<typeof createSharedCardCache<Post, Brief>>[0]> = {}) {
  const readPosts = vi.fn(
    async (ids: string[]): Promise<Result<Post[]>> => ({
      ok: true,
      data: ids.map((id) => ({ id, approved_by: `u-${id}` })),
    }),
  );
  const readBriefs = vi.fn(
    async (ids: string[]): Promise<Result<Brief[]>> => ({
      ok: true,
      data: ids.map((id) => ({ id })),
    }),
  );
  const readNames = vi.fn(
    async (ids: string[]): Promise<Result<ChatProfile[]>> => ({
      ok: true,
      data: ids.map((userId) => ({ userId, displayName: `Name ${userId}`, avatarUrl: null })),
    }),
  );
  return {
    readPosts,
    readBriefs,
    readNames,
    readers: {
      readPosts,
      readBriefs,
      readNames,
      postId: (p: Post) => p.id,
      briefId: (b: Brief) => b.id,
      approverIds: (posts: readonly Post[]) =>
        posts.map((p) => p.approved_by).filter((id): id is string => id !== null),
      ...over,
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('P7: cards are batched per thread', () => {
  it('10 cards -> 1 posts read + 1 briefs read + 1 profile read', async () => {
    const { readers, readPosts, readBriefs, readNames } = cardReaders();
    const cache = createSharedCardCache(readers);
    const postIds = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const briefIds = Array.from({ length: 10 }, (_, i) => `b${i}`);
    // The thread asks for everything, and each card asks for its own ids.
    cache.request({ postIds, briefIds });
    postIds.forEach((id, i) => cache.request({ postIds: [id], briefIds: [briefIds[i] ?? ''] }));
    expect(cache.posts(postIds).loading).toBe(true);
    await settle();
    expect(readPosts).toHaveBeenCalledTimes(1);
    expect(readPosts).toHaveBeenCalledWith(postIds, expect.any(AbortSignal));
    expect(readBriefs).toHaveBeenCalledTimes(1);
    expect(readNames).toHaveBeenCalledTimes(1);
    const snap = cache.posts(['p3']);
    expect(snap.loading).toBe(false);
    expect(snap.posts).toEqual([{ id: 'p3', approved_by: 'u-p3' }]);
    expect(snap.names.get('u-p3')).toBe('Name u-p3');
    expect(cache.briefs(['b4']).briefs).toEqual([{ id: 'b4' }]);
    // A new message adds only its missing ids.
    cache.request({ postIds: [...postIds, 'p10'] });
    await settle();
    expect(readPosts).toHaveBeenCalledTimes(2);
    expect(readPosts).toHaveBeenLastCalledWith(['p10'], expect.any(AbortSignal));
    cache.dispose();
  });

  it('reads in chunks of 100', async () => {
    const { readers, readPosts } = cardReaders();
    const cache = createSharedCardCache(readers);
    cache.request({ postIds: Array.from({ length: 250 }, (_, i) => `p${i}`) });
    await settle();
    expect(readPosts.mock.calls.map(([ids]) => ids.length)).toEqual([CARD_READ_CHUNK, 100, 50]);
  });

  it('a read that times out (5s) keeps the skeleton (never "not visible") and retries', async () => {
    vi.useFakeTimers();
    const never = () => new Promise<never>(() => {});
    const { readers } = cardReaders({ readPosts: never, readBriefs: never });
    const cache = createSharedCardCache(readers, { schedule: (flush) => flush() });
    cache.request({ postIds: ['p1'], briefIds: ['b1'] });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    expect(cache.posts(['p1'])).toMatchObject({ loading: true, posts: [], failed: [] });
    expect(cache.briefs(['b1'])).toMatchObject({ loading: true, failed: [] });
  });

  it('a failed refresh keeps the cards shown; dispose ignores reads in flight', async () => {
    const { readers, readPosts } = cardReaders();
    const cache = createSharedCardCache(readers);
    cache.request({ postIds: ['p1'] });
    await settle();
    readPosts.mockResolvedValueOnce({ ok: false, error: { code: 'unknown', message: 'x' } });
    cache.refreshPosts(['p1']);
    await settle();
    expect(cache.posts(['p1']).posts).toHaveLength(1);
    const listener = vi.fn();
    cache.subscribe(listener);
    cache.refreshPosts(['p1']);
    cache.dispose();
    await settle();
    expect(listener).not.toHaveBeenCalled();
  });
});
