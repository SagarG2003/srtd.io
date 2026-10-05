import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgoraChat } from 'agora-chat';
import {
  sendSignal,
  sendTyping,
  subscribeTyping,
  TYPING_ACTION,
  TYPING_MAX_AGE_MS,
  TYPING_EVENT_HANDLER_ID,
  typingChannelId,
  typingForChannel,
  visibleTypingIds,
  type TypingConnection,
} from '@/lib/chat/typing';
import {
  addTypingId,
  removeTypingId,
  trackChannelTyping,
  typingIdsFor,
  type TypingState,
} from '@/lib/chat/use-chat-typing';
import type { ChannelTarget } from '@/lib/chat/thread';
import { toAgoraUsername } from '@/lib/chat/agora-identity';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const DM: ChannelTarget = { targetId: toAgoraUsername(PEER), chatType: 'singleChat' };
const GROUP: ChannelTarget = { targetId: 'agora-group-1', chatType: 'groupChat' };

function cmd(over: Partial<AgoraChat.CmdMsgBody> & { ext?: unknown }): AgoraChat.CmdMsgBody {
  return {
    id: 'c1',
    type: 'cmd',
    chatType: 'singleChat',
    to: toAgoraUsername(ME),
    from: toAgoraUsername(PEER),
    action: TYPING_ACTION,
    time: Date.now(),
    ...over,
  } as AgoraChat.CmdMsgBody;
}

function connection(): {
  conn: TypingConnection;
  handlers: Record<string, AgoraChat.EventHandlerType>;
} {
  const handlers: Record<string, AgoraChat.EventHandlerType> = {};
  const conn = {
    send: vi.fn().mockResolvedValue({}),
    addEventHandler: vi.fn((id: string, h: AgoraChat.EventHandlerType) => {
      handlers[id] = h;
    }),
    removeEventHandler: vi.fn(),
  } as unknown as TypingConnection;
  return { conn, handlers };
}

describe('outbound typing', () => {
  it('carries ext { channelId } with the Sorted channel id', async () => {
    const { conn } = connection();
    const createCmd = vi.fn().mockReturnValue({});
    await sendTyping({ connection: conn, target: GROUP, createCmd, channelId: 'chan-1' });
    expect(createCmd).toHaveBeenCalledWith({
      chatType: 'groupChat',
      type: 'cmd',
      to: 'agora-group-1',
      action: 'typing',
      ext: { channelId: 'chan-1' },
      deliverOnlineOnly: true,
    });
  });
});

describe('inbound typing', () => {
  it('reads the channel id from ext; absent or malformed is null', () => {
    expect(typingChannelId({ channelId: 'c' })).toBe('c');
    expect(typingChannelId({})).toBeNull();
    expect(typingChannelId(undefined)).toBeNull();
    expect(typingChannelId({ channelId: 3 })).toBeNull();
  });

  it('accepts only the open channel id; another channel is rejected', () => {
    expect(typingForChannel(cmd({ ext: { channelId: 'open' } }), DM, 'open')).toBe(true);
    expect(typingForChannel(cmd({ ext: { channelId: 'other' } }), DM, 'open')).toBe(false);
    // Even when Agora's from / to would match the open DM.
    const { conn, handlers } = connection();
    const onTypingFrom = vi.fn();
    subscribeTyping({
      connection: conn,
      target: DM,
      channelId: 'open',
      currentUserId: ME,
      onTypingFrom,
      onMessageFrom: vi.fn(),
    });
    handlers[TYPING_EVENT_HANDLER_ID]?.onCmdMessage?.(cmd({ ext: { channelId: 'other' } }));
    expect(onTypingFrom).not.toHaveBeenCalled();
    handlers[TYPING_EVENT_HANDLER_ID]?.onCmdMessage?.(cmd({ ext: { channelId: 'open' } }));
    expect(onTypingFrom).toHaveBeenCalledWith(PEER);
  });

  it('an older client without ext falls back to the from / to match', () => {
    expect(typingForChannel(cmd({}), DM, 'open')).toBe(true);
    expect(typingForChannel(cmd({ from: toAgoraUsername(OTHER) }), DM, 'open')).toBe(false);
  });
});

describe('switching chats', () => {
  it('clears typing ids synchronously: the old chat never reads into the new one', () => {
    let state: TypingState = { channelId: null, ids: [] };
    state = addTypingId(state, 'chan-a', PEER);
    expect(typingIdsFor(state, 'chan-a')).toEqual([PEER]);
    // Same render as the switch: the state still names chan-a, chan-b reads none.
    expect(typingIdsFor(state, 'chan-b')).toEqual([]);
    expect(typingIdsFor(state, null)).toEqual([]);
    // A late clear timer from chan-a never touches chan-b.
    const b = addTypingId(state, 'chan-b', OTHER);
    expect(removeTypingId(b, 'chan-a', OTHER)).toBe(b);
    expect(typingIdsFor(b, 'chan-b')).toEqual([OTHER]);
  });

  it('shows the DM peer only, and group members only', () => {
    const ids = [PEER, OTHER];
    expect(visibleTypingIds({ ids, isGroup: false, peerUserId: PEER, memberIds: null })).toEqual([
      PEER,
    ]);
    expect(
      visibleTypingIds({ ids, isGroup: true, peerUserId: null, memberIds: new Set([OTHER]) }),
    ).toEqual([OTHER]);
    expect(visibleTypingIds({ ids, isGroup: true, peerUserId: null, memberIds: null })).toEqual([]);
  });
});

function text(over: Partial<AgoraChat.TextMsgBody> & { ext?: unknown }): AgoraChat.TextMsgBody {
  return {
    id: 't1',
    type: 'txt',
    chatType: 'singleChat',
    to: toAgoraUsername(ME),
    from: toAgoraUsername(PEER),
    msg: 'hi',
    time: Date.now(),
    ext: { sorted_message_id: 'm1', sorted_channel_id: 'open' },
    ...over,
  } as AgoraChat.TextMsgBody;
}

function subscribe() {
  const { conn, handlers } = connection();
  const onTypingFrom = vi.fn();
  const onMessageFrom = vi.fn();
  const teardown = subscribeTyping({
    connection: conn,
    target: DM,
    channelId: 'open',
    currentUserId: ME,
    onTypingFrom,
    onMessageFrom,
  });
  const handler = handlers[TYPING_EVENT_HANDLER_ID];
  return { conn, handler, onTypingFrom, onMessageFrom, teardown };
}

describe('online-only delivery', () => {
  it('sendTyping asks for online-only delivery; sendSignal leaves the SDK default', async () => {
    const { conn } = connection();
    const createCmd = vi.fn().mockReturnValue({});
    await sendTyping({ connection: conn, target: DM, createCmd, channelId: 'open' });
    expect(createCmd.mock.calls[0]?.[0]).toMatchObject({ deliverOnlineOnly: true });
    createCmd.mockClear();
    await sendSignal({ connection: conn, target: DM, createCmd, ext: { kind: 'read' } });
    expect(createCmd.mock.calls[0]?.[0]).not.toHaveProperty('deliverOnlineOnly');
  });
});

describe('stale typing cmds', () => {
  it('drops a cmd older than TYPING_MAX_AGE_MS; fresh and future-dated are accepted', () => {
    const { handler, onTypingFrom } = subscribe();
    const now = Date.now();
    handler?.onCmdMessage?.(cmd({ time: now - TYPING_MAX_AGE_MS - 1000 }));
    expect(onTypingFrom).not.toHaveBeenCalled();
    handler?.onCmdMessage?.(cmd({ time: now }));
    expect(onTypingFrom).toHaveBeenCalledTimes(1);
    handler?.onCmdMessage?.(cmd({ time: now + 60000 }));
    expect(onTypingFrom).toHaveBeenCalledTimes(2);
  });

  it('accepts a cmd with a missing or non-number time', () => {
    const { handler, onTypingFrom } = subscribe();
    handler?.onCmdMessage?.(cmd({ time: undefined as unknown as number }));
    handler?.onCmdMessage?.(cmd({ time: 'x' as unknown as number }));
    expect(onTypingFrom).toHaveBeenCalledTimes(2);
  });
});

describe('message clears typing', () => {
  it('fires onMessageFrom for the peer text message in the open channel', () => {
    const { handler, onMessageFrom } = subscribe();
    handler?.onTextMessage?.(text({}));
    expect(onMessageFrom).toHaveBeenCalledTimes(1);
    expect(onMessageFrom).toHaveBeenCalledWith(PEER);
  });

  it('ignores another channel, self, and unmappable messages', () => {
    const { handler, onMessageFrom } = subscribe();
    handler?.onTextMessage?.(text({ ext: { sorted_message_id: 'm1', sorted_channel_id: 'x' } }));
    handler?.onTextMessage?.(text({ from: toAgoraUsername(ME), to: toAgoraUsername(PEER) }));
    handler?.onTextMessage?.(text({ from: 'not-a-sorted-user' }));
    handler?.onTextMessage?.(text({ ext: {} }));
    expect(onMessageFrom).not.toHaveBeenCalled();
  });

  it('teardown removes exactly the chat-typing handler', () => {
    const { conn, teardown } = subscribe();
    teardown();
    expect(conn.removeEventHandler).toHaveBeenCalledTimes(1);
    expect(conn.removeEventHandler).toHaveBeenCalledWith(TYPING_EVENT_HANDLER_ID);
  });
});

describe('hook inbound tracking', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a peer message clears their typing at once; the old timer is inert', () => {
    vi.useFakeTimers();
    const { conn, handlers } = connection();
    let state: TypingState = { channelId: null, ids: [] };
    const teardown = trackChannelTyping({
      connection: conn,
      target: DM,
      channelId: 'open',
      currentUserId: ME,
      setState: (update) => {
        state = update(state);
      },
    });
    const handler = handlers[TYPING_EVENT_HANDLER_ID];
    handler?.onCmdMessage?.(cmd({ ext: { channelId: 'open' } }));
    expect(typingIdsFor(state, 'open')).toEqual([PEER]);
    handler?.onTextMessage?.(text({}));
    expect(typingIdsFor(state, 'open')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => vi.advanceTimersByTime(10000)).not.toThrow();
    expect(typingIdsFor(state, 'open')).toEqual([]);
    teardown();
    expect(conn.removeEventHandler).toHaveBeenCalledWith(TYPING_EVENT_HANDLER_ID);
  });
});
