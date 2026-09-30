import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client, Result } from '@srtdio/rpc';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { READ_TIMEOUT_MS, listChannelSummaries, type ChatProfile } from '@/lib/chat-reads';
import { CARD_READ_TRIES, createSharedCardCache } from '@/lib/chat/shared-cards';

afterEach(() => {
  vi.useRealTimers();
});

function tableClient(
  results: Record<string, { data: unknown; error: { message: string } | null }>,
) {
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'in', 'is']) b[m] = () => b;
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(results[table] ?? { data: [], error: null }).then(resolve);
    return b;
  };
  return { from } as unknown as Client;
}

describe('a failed DM names read never fails the list', () => {
  it('the users read errors: the list is still read, the DM row keeps its neutral title', async () => {
    const client = tableClient({
      chat_channels: {
        data: [
          {
            channel_id: 'd1',
            channel_type: 'dm',
            entity_id: null,
            agora_group_id: null,
            dm_user_a: 'me',
            dm_user_b: 'peer',
            created_at: '2026-09-01T00:00:00Z',
          },
        ],
        error: null,
      },
      users: { data: null, error: { message: 'boom' } },
    });
    const result = await listChannelSummaries(client, { workspaceId: 'w', currentUserId: 'me' });
    expect(result.ok).toBe(true);
    expect(result.ok && result.data.map((c) => c.channelId)).toEqual(['d1']);
  });
});

interface Post {
  id: string;
}
const failure: Result<Post[]> = { ok: false, error: { code: 'unknown', message: 'x' } };

function cache(readPosts: (ids: string[], signal: AbortSignal) => Promise<Result<Post[]>>) {
  const read = vi.fn(readPosts);
  return {
    read,
    cache: createSharedCardCache<Post, { id: string }>(
      {
        readPosts: read,
        readBriefs: async () => ({ ok: true, data: [] }),
        readNames: async (): Promise<Result<ChatProfile[]>> => ({ ok: true, data: [] }),
        postId: (p) => p.id,
        briefId: (b) => b.id,
        approverIds: () => [],
      },
      { schedule: (flush) => flush() },
    ),
  };
}

describe('a failed card on screen with no trigger still settles', () => {
  it('retries on its own every 5s, then shows "Couldn\'t load"', async () => {
    vi.useFakeTimers();
    const { cache: c, read } = cache(async () => failure);
    c.request({ postIds: ['p1'] });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.posts(['p1']).loading).toBe(true);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS * CARD_READ_TRIES);
    expect(read).toHaveBeenCalledTimes(CARD_READ_TRIES);
    expect(c.posts(['p1'])).toMatchObject({ loading: false, failed: ['p1'] });
    c.dispose();
  });

  it('dispose aborts the reads in flight and stops the retry timer', async () => {
    vi.useFakeTimers();
    const seen: { signal?: AbortSignal } = {};
    const { cache: c, read } = cache(
      (_ids, signal) =>
        new Promise<Result<Post[]>>(() => {
          seen.signal = signal;
        }),
    );
    c.request({ postIds: ['p1'] });
    await vi.advanceTimersByTimeAsync(0);
    c.dispose();
    expect(seen.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS * 4);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
