import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The component's import graph pulls the agora-chat browser SDK; mock it so the
// pure helpers import in node (as ChatStoreProvider.test.tsx does).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  applyProfileRead,
  CHAT_UNAVAILABLE_TOAST,
  deepLinkStep,
  idsToRead,
  initialJumpFor,
  messageParamTarget,
  NO_NAME_READS,
  openMentionDm,
  paintableMessages,
  profileIdsNeeded,
  type NameReads,
} from '@/components/chat/ChatConnected';
import {
  initialJumpDue,
  profileNameOf,
  renderBodyWithMentions,
} from '@/components/chat/MessageThread';
import type { ChannelSummary, ChatProfile } from '@/lib/chat-reads';
import { findInOlderPages } from '@/lib/chat/marks';
import { knownMentionName, resetMentionNames } from '@/lib/chat/mentions';
import type { ChatMessageRow, ThreadMessage } from '@/lib/chat/thread';
import type { Result } from '@srtdio/rpc';

const ANA = '11111111-1111-4111-8111-111111111111';
const BEN = '22222222-2222-4222-8222-222222222222';

function message(over: Partial<ThreadMessage>): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: 'sender',
    body: '',
    createdAt: '2026-09-22T10:00:00Z',
    time: 0,
    provisionalTime: false,
    mine: false,
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

describe('profileIdsNeeded', () => {
  it('one batch covers senders, the DM peer and every mention (body and quote)', () => {
    const ids = profileIdsNeeded(
      [
        message({ body: `hi @[${ANA}]` }),
        message({ id: 'm2', reply: { id: 'm1', authorUserId: null, preview: `@[${BEN}]` } }),
      ],
      'peer',
      new Map(),
    );
    expect(ids.sort()).toEqual([ANA, BEN, 'peer', 'sender'].sort());
  });

  it('skips ids already held', () => {
    const held = new Map([
      [ANA, {}],
      ['sender', {}],
    ]);
    expect(profileIdsNeeded([message({ body: `@[${ANA}]` })], null, held)).toEqual([]);
  });
});

describe('messageParamTarget', () => {
  it('reads ?channel= with ?message= as the jump target', () => {
    expect(messageParamTarget(new URLSearchParams('channel=c1&message=m9'))).toEqual({
      channelId: 'c1',
      messageId: 'm9',
    });
  });

  it('no message (or no channel) is no jump: the chat opens at the bottom', () => {
    expect(messageParamTarget(new URLSearchParams('channel=c1'))).toBeNull();
    expect(messageParamTarget(new URLSearchParams('message=m9'))).toBeNull();
    expect(messageParamTarget(new URLSearchParams('channel=c1&message='))).toBeNull();
  });
});

describe('openMentionDm', () => {
  it('opens the DM through the existing open-or-create function with a fresh trace', async () => {
    const onOpen = vi.fn();
    const start = vi.fn(async (_p: unknown, open: (id: string) => void) => {
      open('dm-1');
      return null;
    });
    const onFailed = vi.fn();
    await openMentionDm(BEN, { workspaceId: 'w1', start, onOpen, onFailed });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w1', peerUserId: BEN, traceId: expect.any(String) }),
      onOpen,
    );
    expect(onOpen).toHaveBeenCalledWith('dm-1');
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('a failure is reported, never thrown', async () => {
    const onFailed = vi.fn();
    await openMentionDm(BEN, {
      workspaceId: 'w1',
      start: async () => ({ message: 'nope' }),
      onOpen: vi.fn(),
      onFailed,
    });
    expect(onFailed).toHaveBeenCalledWith(expect.any(String), 'nope');
  });
});

// --- fix round 1 -------------------------------------------------------------

const EX = '33333333-3333-4333-8333-333333333333';

type Profiles = Map<string, ChatProfile>;

function profile(userId: string, displayName: string): ChatProfile {
  return { userId, displayName, avatarUrl: null };
}

/** ChatConnected's row gate: a row paints once each name it needs has settled. */
function paint(messages: ThreadMessage[], profiles: Profiles, reads: NameReads): ThreadMessage[] {
  return paintableMessages(
    messages,
    (id) => profiles.has(id) || knownMentionName(id) !== undefined,
    reads,
  );
}

/** One pass of ChatConnected's profile effect: one batched read, folded in. */
async function readOnce(
  messages: ThreadMessage[],
  profiles: Profiles,
  reads: NameReads,
  read: (ids: string[]) => Promise<Result<ChatProfile[]>>,
): Promise<{ asked: string[]; profiles: Profiles; reads: NameReads }> {
  const asked = idsToRead(profileIdsNeeded(messages, null, profiles), reads, new Set());
  if (asked.length === 0) return { asked, profiles, reads };
  const result = await read(asked);
  const next = new Map(profiles);
  if (result.ok) for (const p of result.data) next.set(p.userId, p);
  return { asked, profiles: next, reads: applyProfileRead(reads, asked, result) };
}

/** A painted row's body as the bubble draws it (peer bubble, tappable mentions). */
function bubbleHtml(message: ThreadMessage, profiles: Profiles): string {
  return renderToStaticMarkup(
    <p>
      {renderBodyWithMentions(message.body, false, {
        nameOf: profileNameOf(profiles),
        viewerUserId: 'me',
        mentions: { peerUserId: null, onOpen: () => {} },
      })}
    </p>,
  );
}

const ok = (data: ChatProfile[]): Result<ChatProfile[]> => ({ ok: true, data });
const failed: Result<ChatProfile[]> = { ok: false, error: { code: 'unknown', message: 'down' } };

describe('F2 live and older-page mentions paint final', () => {
  beforeEach(() => resetMentionNames());
  const firstPage = [message({ id: 'm1', body: 'hi' })];
  const known: Profiles = new Map([['sender', profile('sender', 'Sam')]]);

  it('F2 live row with a not-yet-known current member renders "@Name" on first paint', async () => {
    const live = message({ id: 'm2', body: `ping @[${ANA}]` });
    const messages = [...firstPage, live];
    // Before its read settles the row is held, never painted as "@Unknown member".
    expect(paint(messages, known, NO_NAME_READS).map((m) => m.id)).toEqual(['m1']);
    const read = vi.fn(async () => ok([profile(ANA, 'Ana')]));
    const after = await readOnce(messages, known, NO_NAME_READS, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(after.asked).toEqual([ANA]);
    const painted = paint(messages, after.profiles, after.reads);
    expect(painted.map((m) => m.id)).toEqual(['m1', 'm2']);
    const html = bubbleHtml(live, after.profiles);
    expect(html).toContain('@Ana');
    expect(html).not.toContain('Unknown member');
  });

  it('F2 older page with a not-yet-known member (body and quote) renders "@Name" on first paint', async () => {
    const older = [
      message({ id: 'o1', body: `for @[${ANA}]` }),
      message({ id: 'o2', reply: { id: 'o1', authorUserId: BEN, preview: `for @[${ANA}]` } }),
    ];
    const messages = [...older, ...firstPage];
    expect(paint(messages, known, NO_NAME_READS).map((m) => m.id)).toEqual(['m1']);
    const read = vi.fn(async () => ok([profile(ANA, 'Ana'), profile(BEN, 'Ben')]));
    const after = await readOnce(messages, known, NO_NAME_READS, read);
    // One batched read for the whole page.
    expect(read).toHaveBeenCalledTimes(1);
    expect([...after.asked].sort()).toEqual([ANA, BEN].sort());
    expect(paint(messages, after.profiles, after.reads).map((m) => m.id)).toEqual([
      'o1',
      'o2',
      'm1',
    ]);
    expect(bubbleHtml(older[0] ?? message({}), after.profiles)).toContain('@Ana');
  });

  it('F2 confirmed ex-member renders "@Unknown member" on first paint and stays', async () => {
    const live = message({ id: 'm2', body: `was @[${EX}]` });
    const messages = [...firstPage, live];
    const after = await readOnce(messages, known, NO_NAME_READS, async () => ok([]));
    expect(after.reads.unknown.has(EX)).toBe(true);
    expect(paint(messages, after.profiles, after.reads).map((m) => m.id)).toEqual(['m1', 'm2']);
    const html = bubbleHtml(live, after.profiles);
    expect(html).toContain('@Unknown member');
    expect(html).not.toContain('<button');
    // Never read again: no swap later.
    expect(
      idsToRead(profileIdsNeeded(messages, null, after.profiles), after.reads, new Set()),
    ).toEqual([]);
  });
});

describe('F3 a failed profile read is not cached as unknown', () => {
  beforeEach(() => resetMentionNames());

  it('F3 first read fails, second succeeds, name appears; failure not memoized', async () => {
    const known: Profiles = new Map([['sender', profile('sender', 'Sam')]]);
    const first = message({ id: 'm1', body: `hey @[${ANA}]` });
    const one = await readOnce([first], known, NO_NAME_READS, async () => failed);
    expect(one.asked).toEqual([ANA]);
    expect(one.reads.unknown.has(ANA)).toBe(false);
    expect(one.reads.failed.has(ANA)).toBe(true);
    // Unresolved after a failure: the row paints, the mention is inert "@Unknown member".
    expect(paint([first], one.profiles, one.reads).map((m) => m.id)).toEqual(['m1']);
    const inert = bubbleHtml(first, one.profiles);
    expect(inert).toContain('@Unknown member');
    expect(inert).not.toContain('<button');
    // No retry loop on its own.
    expect(idsToRead(profileIdsNeeded([first], null, one.profiles), one.reads, new Set())).toEqual(
      [],
    );
    // The next profile read (a live row) retries it alongside the new id.
    const next = message({ id: 'm2', body: `and @[${BEN}]` });
    const read = vi.fn(async (ids: string[]) =>
      ok(ids.map((id) => profile(id, id === ANA ? 'Ana' : 'Ben'))),
    );
    const two = await readOnce([first, next], one.profiles, one.reads, read);
    expect([...two.asked].sort()).toEqual([ANA, BEN].sort());
    expect(two.reads.failed.size).toBe(0);
    expect(bubbleHtml(first, two.profiles)).toContain('@Ana');
  });
});

function channel(channelId: string): ChannelSummary {
  return {
    channelId,
    channelType: 'group',
    title: 'Team',
    avatarUrl: null,
    agoraGroupId: null,
    groupId: 'g1',
    peerUserId: null,
    createdAt: '2026-09-01T00:00:00Z',
  };
}

describe('F6 Activity jump lands on the mention', () => {
  const roster = [channel('c1')];

  it('F6 link to a message on the first page lands on it', () => {
    const step = deepLinkStep(new URLSearchParams('channel=c1&message=m1'), roster);
    expect(step.open?.channelId).toBe('c1');
    const target = initialJumpFor(step.jump, 'c1');
    expect(target).toBe('m1');
    // Not while the skeleton holds the first page (no row to reveal yet)...
    expect(initialJumpDue({ messageId: target, done: false, bodyLoading: true })).toBe(false);
    // ...then once the rows are on screen, with the row painted.
    expect(initialJumpDue({ messageId: target, done: false, bodyLoading: false })).toBe(true);
    const page = [message({ id: 'm1' }), message({ id: 'm2' })];
    expect(paint(page, new Map(), NO_NAME_READS).some((m) => m.id === target)).toBe(true);
  });

  it('F6 link to a message needing older pages lands on it (ensureLoaded path)', async () => {
    const row = (id: string, at: string): ChatMessageRow =>
      ({ id, created_at: at }) as ChatMessageRow;
    const pages = [[row('p2', '2026-09-02T00:00:00Z')], [row('target', '2026-09-01T00:00:00Z')]];
    let loaded: string[] = ['m1'];
    const outcome = await findInOlderPages({
      start: { createdAt: '2026-09-03T00:00:00Z', id: 'm1' },
      targetId: 'target',
      loadPage: async () => ({
        ok: true,
        data: { rows: pages.shift() ?? [], hasMore: pages.length > 0 },
      }),
      onPage: (rows) => {
        loaded = [...rows.map((r) => r.id), ...loaded];
      },
    });
    expect(outcome).toBe('found');
    const thread = loaded.map((id) => message({ id }));
    expect(paint(thread, new Map(), NO_NAME_READS).some((m) => m.id === 'target')).toBe(true);
  });

  it('F6 leave and reopen: no second jump', () => {
    let pending = deepLinkStep(new URLSearchParams('channel=c1&message=m1'), roster).jump;
    expect(initialJumpFor(pending, 'c1')).toBe('m1');
    // The thread takes it (onInitialJumpTaken): the pending jump is cleared.
    pending = null;
    expect(initialJumpFor(pending, 'c1')).toBeNull();
    expect(initialJumpDue({ messageId: null, done: false, bodyLoading: false })).toBe(false);
  });

  it('F6 unknown channel: toast, stay on the chat list', () => {
    const step = deepLinkStep(new URLSearchParams('channel=gone&message=m1'), roster);
    expect(step).toEqual({ open: null, jump: null, unavailable: true });
    expect(CHAT_UNAVAILABLE_TOAST).toBe("That chat isn't available");
  });
});
