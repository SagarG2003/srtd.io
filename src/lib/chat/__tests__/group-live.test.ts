import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgoraChat } from 'agora-chat';
import type { Result } from '@srtdio/rpc';
import type { ChannelSummary } from '@/lib/chat-reads';
import { toAgoraUsername } from '@/lib/chat/agora-identity';
import {
  MAX_FANOUT,
  fanoutTarget,
  mapLiveTextMessage,
  replaceReactions,
  sendText,
  subscribeIncoming,
  type ChannelTarget,
  type MessageReaction,
  type ThreadConnection,
  type ThreadMessage,
} from '@/lib/chat/thread';
import { sendSignal, sendTyping, type CreateCmdMessage } from '@/lib/chat/typing';
import {
  REACTION_RECHECK_CHUNK,
  reactionRecheckIds,
  reactionRecheckWanted,
  rereadReactions,
} from '@/lib/chat/catch-up';
import {
  cmdChannelId,
  createGroupMemberCache,
  createHeldMessages,
  createRosterReloader,
  openChannelAfterRoster,
  parseRosterCmd,
  resolveLiveTarget,
  rosterExt,
} from '@/lib/chat/roster-signal';
import { applyRoster, initialState, type ChatStoreState } from '@/lib/chat/chat-store';
import { sortChannelsByRecency } from '@/lib/chat/sort-conversations';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

const ME = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const CHANNEL = 'c0000000-0000-4000-8000-000000000001';
const GROUP_ID = 'g0000000-0000-4000-8000-000000000001';
const MSG = 'm0000000-0000-4000-8000-000000000001';

function group(over: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    channelId: CHANNEL,
    channelType: 'group',
    title: 'Launch',
    avatarUrl: null,
    createdBy: ME,
    agoraGroupId: null,
    groupId: GROUP_ID,
    peerUserId: null,
    role: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

function connection(send = vi.fn().mockResolvedValue({ serverMsgId: 's' })): ThreadConnection & {
  send: ReturnType<typeof vi.fn>;
} {
  return {
    open: vi.fn(),
    close: vi.fn(),
    addEventHandler: vi.fn(),
    removeEventHandler: vi.fn(),
    send,
  } as unknown as ThreadConnection & { send: ReturnType<typeof vi.fn> };
}

const createText = vi.fn((options: object) => options as unknown as AgoraChat.MessageBody);
const createCmd: CreateCmdMessage = (options) => options as unknown as AgoraChat.MessageBody;

function ids(n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
  );
}

function sentTo(send: ReturnType<typeof vi.fn>): Array<{ to: string; chatType: string }> {
  return send.mock.calls.map(([m]) => m as { to: string; chatType: string });
}

beforeEach(() => {
  createText.mockClear();
});

describe('L1 unsynced group fan-out', () => {
  it('publishes the txt once per member minus the sender, same ext, as singleChat', async () => {
    const target = fanoutTarget(CHANNEL, [ME, A, B, A], ME);
    expect(target).not.toBeNull();
    const conn = connection();
    await sendText({
      connection: conn,
      target: target as ChannelTarget,
      text: 'hi',
      attachments: [],
      sharedPostIds: [],
      reply: null,
      createMessage: createText,
      liveIds: { sorted_message_id: MSG, sorted_channel_id: CHANNEL },
    });
    const sent = sentTo(conn.send);
    expect(sent.map((m) => m.to).sort()).toEqual([toAgoraUsername(A), toAgoraUsername(B)].sort());
    expect(sent.every((m) => m.chatType === 'singleChat')).toBe(true);
    const exts = conn.send.mock.calls.map(([m]) => (m as { ext: unknown }).ext);
    expect(exts[0]).toMatchObject({ sorted_message_id: MSG, sorted_channel_id: CHANNEL });
    expect(exts[1]).toEqual(exts[0]);
  });

  it('skips above 50 recipients and with nobody to reach', () => {
    expect(fanoutTarget(CHANNEL, ids(MAX_FANOUT), ME)).not.toBeNull();
    expect(fanoutTarget(CHANNEL, ids(MAX_FANOUT + 1), ME)).toBeNull();
    expect(fanoutTarget(CHANNEL, [ME], ME)).toBeNull();
  });

  it('a synced group still sends once to the Agora group', async () => {
    const target = await resolveLiveTarget(group({ agoraGroupId: 'ag-1' }), ME, {
      get: vi.fn(),
    });
    expect(target).toEqual({ targetId: 'ag-1', chatType: 'groupChat' });
  });

  it('uses the loaded member list without a read', async () => {
    const read = vi.fn();
    const cache = createGroupMemberCache(read);
    cache.set(GROUP_ID, [ME, A]);
    const target = await resolveLiveTarget(group(), ME, cache);
    expect(read).not.toHaveBeenCalled();
    expect(target?.fanout).toEqual([toAgoraUsername(A)]);
  });

  it('reads members once when not loaded; a timeout skips the publish', async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn(() => new Promise<Result<string[]>>(() => {}));
      const cache = createGroupMemberCache(read);
      const pending = resolveLiveTarget(group(), ME, cache);
      const second = resolveLiveTarget(group(), ME, cache);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toBeNull();
      expect(await second).toBeNull();
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed member read skips the publish', async () => {
    const cache = createGroupMemberCache(() =>
      Promise.resolve({ ok: false, error: { code: 'unknown', message: 'x' } }),
    );
    expect(await resolveLiveTarget(group(), ME, cache)).toBeNull();
  });

  it('edit/delete/reaction/mark/read and typing cmds fan out the same way', async () => {
    const target = fanoutTarget(CHANNEL, [ME, A, B], ME) as ChannelTarget;
    const conn = connection();
    await sendSignal({ connection: conn, target, createCmd, ext: { sorted_event: 'mark' } });
    await sendTyping({ connection: conn, target, createCmd, channelId: CHANNEL });
    const sent = sentTo(conn.send);
    expect(sent).toHaveLength(4);
    expect(sent.every((m) => m.chatType === 'singleChat')).toBe(true);
    expect(new Set(sent.map((m) => m.to))).toEqual(
      new Set([toAgoraUsername(A), toAgoraUsername(B)]),
    );
  });

  it('a fan-out fails only when every delivery failed', async () => {
    const target = fanoutTarget(CHANNEL, [ME, A, B], ME) as ChannelTarget;
    const partly = connection(
      vi.fn().mockRejectedValueOnce(new Error('one')).mockResolvedValue({ serverMsgId: 's' }),
    );
    await expect(
      sendSignal({ connection: partly, target, createCmd, ext: {} }),
    ).resolves.toBeDefined();
    const none = connection(vi.fn().mockRejectedValue(new Error('down')));
    await expect(sendSignal({ connection: none, target, createCmd, ext: {} })).rejects.toThrow(
      'down',
    );
  });

  it('receiver routes a singleChat txt with a group channel ext into the group', () => {
    const raw = {
      id: 'agora-1',
      type: 'txt',
      chatType: 'singleChat',
      from: toAgoraUsername(A),
      to: toAgoraUsername(ME),
      msg: 'hi',
      time: 1_000,
      ext: { sorted_message_id: MSG, sorted_channel_id: CHANNEL },
    } as unknown as AgoraChat.TextMsgBody;
    const mapped = mapLiveTextMessage(raw, ME);
    expect(mapped.ok && mapped.channelId).toBe(CHANNEL);

    const conn = connection();
    const onMessage = vi.fn();
    subscribeIncoming({
      connection: conn,
      channelId: CHANNEL,
      currentUserId: ME,
      onMessage,
      onIgnored: vi.fn(),
      onReaction: vi.fn(),
      onRead: vi.fn(),
    });
    const handler = vi.mocked(conn.addEventHandler).mock.calls[0]?.[1] as {
      onTextMessage: (m: AgoraChat.TextMsgBody) => void;
    };
    handler.onTextMessage(raw);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: MSG }));
  });
});

describe('L3 roster reload', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a roster cmd triggers one debounced reload', async () => {
    const reload = vi.fn().mockResolvedValue(true);
    const reloader = createRosterReloader({ reload });
    expect(parseRosterCmd({ action: 'roster', ext: rosterExt(CHANNEL, 'renamed') })).toEqual({
      channelId: CHANNEL,
      kind: 'renamed',
    });
    reloader.request();
    await vi.advanceTimersByTimeAsync(499);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledTimes(1);
    reloader.dispose();
  });

  it('three cmds in 200ms = one reload', async () => {
    const reload = vi.fn().mockResolvedValue(true);
    const reloader = createRosterReloader({ reload });
    reloader.request();
    await vi.advanceTimersByTimeAsync(100);
    reloader.request();
    await vi.advanceTimersByTimeAsync(100);
    reloader.request();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).toHaveBeenCalledTimes(1);
    reloader.dispose();
  });

  it('at most one in flight; a request during it runs once after', async () => {
    let finish: (ok: boolean) => void = () => {};
    const reload = vi
      .fn()
      .mockImplementationOnce(() => new Promise<boolean>((r) => (finish = r)))
      .mockResolvedValue(true);
    const reloader = createRosterReloader({ reload });
    reloader.request();
    await vi.advanceTimersByTimeAsync(500);
    reloader.request();
    await vi.advanceTimersByTimeAsync(500);
    reloader.request();
    await vi.advanceTimersByTimeAsync(500);
    expect(reload).toHaveBeenCalledTimes(1);
    finish(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(reload).toHaveBeenCalledTimes(2);
    reloader.dispose();
  });

  it('an unknown-channel message is held and handed back with the reload that lists it', () => {
    const held = createHeldMessages<string>();
    held.add(CHANNEL, 'm1', 0);
    expect(held.settle(() => false, 0)).toEqual([]);
    expect(held.size()).toBe(1);
    expect(held.settle((id) => id === CHANNEL, 1)).toEqual(['m1']);
    expect(held.size()).toBe(0);
    held.dispose();
  });

  it('still unknown after a reload that started after the hold = dropped', () => {
    const onDrop = vi.fn();
    const held = createHeldMessages<string>({ onDrop });
    held.add(CHANNEL, 'm1', 0);
    expect(held.settle(() => false, 1)).toEqual([]);
    expect(onDrop).toHaveBeenCalledWith('m1');
    expect(held.size()).toBe(0);
  });

  it('J5 a hold survives an in-flight reload and applies after the next; drop at 10s', async () => {
    const onDrop = vi.fn();
    const held = createHeldMessages<string>({ onDrop });
    // Reload #1 already started (1 started) when the message is held.
    held.add(CHANNEL, 'm1', 1);
    expect(held.settle(() => false, 1)).toEqual([]);
    expect(onDrop).not.toHaveBeenCalled();
    expect(held.settle((id) => id === CHANNEL, 2)).toEqual(['m1']);

    held.add(CHANNEL, 'm2', 2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(onDrop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDrop).toHaveBeenCalledWith('m2');
    held.add(CHANNEL, 'm3', 2);
    held.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dispose clears the reloader timers, including an in-flight timeout', async () => {
    const reloader = createRosterReloader({ reload: () => new Promise<boolean>(() => {}) });
    reloader.request();
    await vi.advanceTimersByTimeAsync(600);
    reloader.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a reload failure or timeout keeps the roster (nothing applied, holds re-check it)', async () => {
    const roster = [group()];
    const onError = vi.fn();
    const reloader = createRosterReloader({
      reload: () => Promise.reject(new Error('rls')),
      onError,
    });
    reloader.request();
    await vi.advanceTimersByTimeAsync(500);
    expect(onError).toHaveBeenCalled();
    expect(roster).toEqual([group()]);
    const hung = createRosterReloader({ reload: () => new Promise<boolean>(() => {}), onError });
    hung.request();
    await vi.advanceTimersByTimeAsync(5_500);
    expect(onError).toHaveBeenCalledTimes(2);
    reloader.dispose();
    hung.dispose();
  });

  it('payload content is ignored: only the channel id and a known kind are read', () => {
    expect(
      parseRosterCmd({
        action: 'roster',
        ext: { sorted_channel_id: CHANNEL, kind: 'renamed', name: 'Evil', members: [A] },
      }),
    ).toEqual({ channelId: CHANNEL, kind: 'renamed' });
    expect(parseRosterCmd({ action: 'roster', ext: { sorted_channel_id: CHANNEL } })).toBeNull();
    expect(parseRosterCmd({ action: 'typing', ext: rosterExt(CHANNEL, 'members') })).toBeNull();
    expect(cmdChannelId({ channel_id: CHANNEL })).toBe(CHANNEL);
    expect(cmdChannelId({ channelId: CHANNEL })).toBe(CHANNEL);
    expect(cmdChannelId({ message_id: MSG })).toBeNull();
  });
});

describe('L4 removed while open', () => {
  it('the open channel missing after a reload closes the thread', () => {
    expect(openChannelAfterRoster(group(), [], true)).toEqual({ kind: 'close' });
  });
  it('missing without a reload (loading, switch) keeps it', () => {
    expect(openChannelAfterRoster(group(), [], false)).toEqual({ kind: 'keep' });
  });
  it('nothing open: keep', () => {
    expect(openChannelAfterRoster(null, [], true)).toEqual({ kind: 'keep' });
  });
});

describe('L5 reactions catch-up', () => {
  function message(id: string, reactions: MessageReaction[] = []): ThreadMessage {
    return {
      id,
      senderUserId: A,
      body: 'x',
      createdAt: '',
      time: 0,
      provisionalTime: false,
      mine: false,
      attachments: [],
      sharedPostIds: [],
      sharedBriefIds: [],
      reply: null,
      state: 'sent',
      status: 'sent',
      reactions,
    };
  }

  it('runs on visible, online and connected, not on the 60s tick', () => {
    expect(reactionRecheckWanted('visible')).toBe(true);
    expect(reactionRecheckWanted('online')).toBe(true);
    expect(reactionRecheckWanted('connected')).toBe(true);
    expect(reactionRecheckWanted('interval')).toBe(false);
  });

  it('re-reads every loaded recorded row in chunks of 100', async () => {
    const all = ids(250);
    const load = vi.fn((chunk: readonly string[]) =>
      Promise.resolve<Result<Map<string, MessageReaction[]>>>({
        ok: true,
        data: new Map(chunk.map((id) => [id, [{ emoji: '👍', count: 1, mine: false }]])),
      }),
    );
    const result = await rereadReactions(load, all);
    expect(REACTION_RECHECK_CHUNK).toBe(100);
    expect(load.mock.calls.map(([chunk]) => chunk.length)).toEqual([100, 100, 50]);
    expect(result.ok && result.data.size).toBe(250);
    const loaded = [message('a'), { ...message('b'), state: 'sending' as const }];
    expect(reactionRecheckIds(loaded)).toEqual(['a']);
  });

  it('a failed or timed-out chunk keeps the current reactions', async () => {
    vi.useFakeTimers();
    try {
      const load = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, data: new Map() })
        .mockImplementationOnce(() => new Promise(() => {}));
      const pending = rereadReactions(load, ids(150));
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await pending).ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies without moving any row; a missed removal clears', () => {
    const rows = [
      message('a', [{ emoji: '👍', count: 1, mine: false }]),
      message('b'),
      message('c'),
    ];
    const next = replaceReactions(
      rows,
      ['a', 'b'],
      new Map([['b', [{ emoji: '🔥', count: 2, mine: true }]]]),
    );
    expect(next.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(next[0]?.reactions).toEqual([]);
    expect(next[1]?.reactions).toEqual([{ emoji: '🔥', count: 2, mine: true }]);
    expect(next[2]).toBe(rows[2]);
    expect(replaceReactions(next, ['a', 'b'], new Map([['b', next[1]?.reactions ?? []]]))).toBe(
      next,
    );
  });
});

describe('L6 in-place updates', () => {
  const older = group({ channelId: 'c-old', title: 'Old', createdAt: '2026-08-01T00:00:00.000Z' });
  const dm: ChannelSummary = {
    channelId: 'c-dm',
    channelType: 'dm',
    title: 'Asha',
    avatarUrl: null,
    agoraGroupId: null,
    groupId: null,
    peerUserId: A,
    createdAt: '2026-07-01T00:00:00.000Z',
  };

  it('a rename updates the name in the list and header without reordering', () => {
    const roster = [group(), older, dm];
    let state = applyRoster(initialState(), roster);
    state = {
      ...state,
      conversations: {
        ...state.conversations,
        [CHANNEL]: { ...state.conversations[CHANNEL]!, lastMessageTs: 100 },
        'c-dm': { ...state.conversations['c-dm']!, lastMessageTs: 300 },
      },
    };
    const before = sortChannelsByRecency(state.roster, (id) => state.conversations[id]);
    const renamed = [group({ title: 'Launch v2', avatarUrl: 'https://x/a.png' }), older, dm];
    const after = applyRoster(state, renamed);
    const list = sortChannelsByRecency(after.roster, (id) => after.conversations[id]);
    expect(list.map((c) => c.channelId)).toEqual(before.map((c) => c.channelId));
    expect(list.find((c) => c.channelId === CHANNEL)?.title).toBe('Launch v2');
    expect(after.conversations[CHANNEL]).toBe(state.conversations[CHANNEL]);

    const header = openChannelAfterRoster(group(), renamed, true);
    expect(header).toEqual({ kind: 'update', channel: renamed[0] });
    const same = openChannelAfterRoster(renamed[0]!, renamed, true);
    expect(same).toEqual({ kind: 'keep' });
  });

  it('a new chat tile is inserted by recency', () => {
    const state = applyRoster(initialState(), [older, dm]);
    const created = group({ channelId: 'c-new', createdAt: '2026-09-29T00:00:00.000Z' });
    const next = applyRoster(state, [created, older, dm]);
    const withRecency: ChatStoreState = {
      ...next,
      conversations: {
        ...next.conversations,
        'c-dm': { ...next.conversations['c-dm']!, lastMessageTs: 300 },
      },
    };
    const list = sortChannelsByRecency(withRecency.roster, (id) => withRecency.conversations[id]);
    expect(list.map((c) => c.channelId)).toEqual(['c-dm', 'c-new', 'c-old']);
  });
});
