import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { deepLinkAfterRefresh } from '@/components/chat/ChatConnected';
import { ROSTER_READ_BUDGET_MS } from '@/components/chat/ChatStoreProvider';
import { stripLoops } from '@/components/chat/MessageThread';
import { READ_TIMEOUT_MS, type ChannelSummary } from '@/lib/chat-reads';

afterEach(() => {
  vi.useRealTimers();
});

describe('the deep-link re-read waits as long as the roster reload may take', () => {
  it('a reload answering at 7s opens the chat (no "unavailable" toast first)', async () => {
    vi.useFakeTimers();
    const b: ChannelSummary = {
      channelId: 'B',
      channelType: 'dm',
      title: 'B',
      avatarUrl: null,
      agoraGroupId: null,
      groupId: null,
      peerUserId: 'p',
      createdAt: '2026-09-01T00:00:00Z',
    };
    let step: Awaited<ReturnType<typeof deepLinkAfterRefresh>> | null = null;
    void deepLinkAfterRefresh(
      new URLSearchParams('channel=B'),
      [],
      () => new Promise((r) => setTimeout(() => r([b]), 7_000)),
      ROSTER_READ_BUDGET_MS,
    ).then((s) => {
      step = s;
    });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 2_000);
    expect(step).toMatchObject({ open: { channelId: 'B' }, unavailable: false });
  });
});

describe('a failed marks read keeps the strip slot empty (no jump, never "Nothing open")', () => {
  it('not loaded is not ready: the strip holds its empty 44px body', () => {
    const loops = stripLoops({
      openPosts: { ready: true, count: 0, failed: false },
      side: { side: 'client', ready: true },
      marksLoaded: false,
    });
    expect(loops.ready).toBe(false);
  });
});
