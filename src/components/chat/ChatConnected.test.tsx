import { describe, expect, it, vi } from 'vitest';

// The component's import graph pulls the agora-chat browser SDK; mock it so the
// pure helpers import in node (as ChatStoreProvider.test.tsx does).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  messageParamTarget,
  openMentionDm,
  profileIdsNeeded,
} from '@/components/chat/ChatConnected';
import type { ThreadMessage } from '@/lib/chat/thread';

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
