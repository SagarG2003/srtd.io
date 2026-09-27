import { describe, expect, it, vi } from 'vitest';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { ChatMark } from '@/lib/chat/marks';
import type { ThreadMessage } from '@/lib/chat/thread';
import {
  canDeleteSelection,
  canForward,
  forwardFailedMessage,
  forwardPickerChannels,
  forwardPreviewText,
  forwardRecordInput,
  forwardableInOrder,
  pruneThreadSelection,
  runForward,
  selectedForForward,
  sendToLabel,
  toggleForwardTarget,
} from '@/lib/chat/forward';

function msg(over: Partial<ThreadMessage>): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: 'peer',
    body: 'hello',
    createdAt: '2026-09-22T10:00:00Z',
    time: 1,
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

function channel(over: Partial<ChannelSummary>): ChannelSummary {
  return {
    channelId: 'c1',
    channelType: 'group',
    title: 'Team',
    avatarUrl: null,
    agoraGroupId: null,
    groupId: 'g1',
    peerUserId: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const mark = (id: string): ChatMark =>
  ({ messageId: id, type: 'decision', priority: null }) as unknown as ChatMark;

describe('forwardable messages', () => {
  it('only recorded messages can be forwarded', () => {
    expect(canForward(msg({ state: 'sent' }))).toBe(true);
    expect(canForward(msg({ state: 'sending' }))).toBe(false);
    expect(canForward(msg({ state: 'failed' }))).toBe(false);
  });

  it('keeps thread order and drops unrecorded bubbles', () => {
    const list = forwardableInOrder([
      msg({ id: 'b', time: 2 }),
      msg({ id: 'x', time: 3, state: 'failed' }),
      msg({ id: 'a', time: 1 }),
    ]);
    expect(list.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('selectedForForward returns the selected ones in thread order', () => {
    const messages = [
      msg({ id: 'a', time: 1 }),
      msg({ id: 'b', time: 2 }),
      msg({ id: 'c', time: 3 }),
    ];
    expect(selectedForForward(new Set(['c', 'a']), messages).map((m) => m.id)).toEqual(['a', 'c']);
  });
});

describe('thread selection (Forward any, Delete own only)', () => {
  const messages = [
    msg({ id: 'own', mine: true }),
    msg({ id: 'peer', mine: false }),
    msg({ id: 'marked', mine: true }),
    msg({ id: 'pending', mine: true, state: 'sending' }),
  ];
  const marks = new Map([['marked', mark('marked')]]);

  it('prunes to loaded, recorded messages of any sender', () => {
    const pruned = pruneThreadSelection(new Set(['own', 'peer', 'pending', 'gone']), messages);
    expect([...pruned].sort()).toEqual(['own', 'peer']);
  });

  it('allows delete only when every selected message is own and unmarked', () => {
    expect(canDeleteSelection(new Set(), messages, marks)).toBe(false);
    expect(canDeleteSelection(new Set(['own']), messages, marks)).toBe(true);
    expect(canDeleteSelection(new Set(['own', 'peer']), messages, marks)).toBe(false);
    expect(canDeleteSelection(new Set(['marked']), messages, marks)).toBe(false);
  });
});

describe('forward picker', () => {
  const channels = [
    channel({ channelId: 'old', title: 'Old team' }),
    channel({ channelId: 'new', title: 'Acme client' }),
    channel({ channelId: 'hidden', title: 'Hidden DM', channelType: 'dm' }),
  ];
  const ts: Record<string, number> = { old: 10, new: 20, hidden: 5 };

  it('lists every chat (hidden included) most recent first, and filters by name', () => {
    const all = forwardPickerChannels(channels, (id) => ({ lastMessageTs: ts[id] ?? 0 }), '');
    expect(all.map((c) => c.channelId)).toEqual(['new', 'old', 'hidden']);
    const found = forwardPickerChannels(channels, (id) => ({ lastMessageTs: ts[id] ?? 0 }), 'acme');
    expect(found.map((c) => c.channelId)).toEqual(['new']);
  });

  it('toggles targets and labels the send button', () => {
    const one = toggleForwardTarget(new Set(), 'a');
    expect([...one]).toEqual(['a']);
    expect([...toggleForwardTarget(one, 'a')]).toEqual([]);
    expect(sendToLabel(0)).toBe('Send to 0 chats');
    expect(sendToLabel(1)).toBe('Send to 1 chat');
    expect(sendToLabel(3)).toBe('Send to 3 chats');
    expect(forwardFailedMessage('Design')).toBe('Could not forward to Design.');
  });
});

describe('forwardRecordInput', () => {
  it('copies body, attachments with meta, posts and briefs; no reply; the source id', () => {
    const source = msg({
      id: 'src',
      body: 'see this',
      attachments: [{ assetId: 'v1', name: 'a.png', mime: 'image/png', size: 5 }],
      sharedPostIds: ['p1'],
      sharedBriefIds: ['b1'],
      reply: { id: 'q', authorUserId: null, preview: 'x' },
    });
    expect(forwardRecordInput(source, { id: 'new', channelId: 'c2', traceId: 't' })).toEqual({
      id: 'new',
      channelId: 'c2',
      traceId: 't',
      body: 'see this',
      attachmentAssetIds: ['v1'],
      attachmentMeta: { v1: { mime: 'image/png', name: 'a.png', size: 5 } },
      sharedPostIds: ['p1'],
      sharedBriefIds: ['b1'],
      replyToMessageId: null,
      forwardedFromMessageId: 'src',
    });
  });

  it('previews an attachment-only forward as Attachment', () => {
    expect(forwardPreviewText(msg({ body: '', sharedPostIds: ['p'] }))).toBe('Attachment');
    expect(forwardPreviewText(msg({ body: 'hi' }))).toBe('hi');
  });
});

describe('runForward', () => {
  const targets = ['a', 'b', 'c'];
  const messages = [msg({ id: 'm1' }), msg({ id: 'm2' })];

  it('sends each message to each chat in order', async () => {
    const calls: string[] = [];
    const result = await runForward({
      targets,
      messages,
      sendOne: (t, m) => {
        calls.push(`${t}:${m.id}`);
        return Promise.resolve({ ok: true });
      },
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(['a:m1', 'a:m2', 'b:m1', 'b:m2', 'c:m1', 'c:m2']);
  });

  it('stops on the first failure and names that chat', async () => {
    const sendOne = vi.fn((t: string, m: ThreadMessage) =>
      Promise.resolve(
        t === 'b' && m.id === 'm1' ? { ok: false as const, message: 'x' } : { ok: true as const },
      ),
    );
    const result = await runForward({ targets, messages, sendOne });
    expect(result).toEqual({ ok: false, failed: 'b', message: 'x' });
    expect(sendOne).toHaveBeenCalledTimes(3);
  });
});
