import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client, Result } from '@srtdio/rpc';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  LATE_READ_GRACE_MS,
  READ_TIMEOUT_MS,
  listChannelSummaries,
  withLinkedSignal,
  type ChatProfile,
} from '@/lib/chat-reads';
import { CARD_READ_TRIES, createSharedCardCache } from '@/lib/chat/shared-cards';
import { createLiveVerifier } from '@/lib/chat/live-verify';

afterEach(() => {
  vi.useRealTimers();
});

interface Post {
  id: string;
  approved_by: string | null;
}

function readersWith(over: {
  readPosts?: (ids: string[], signal: AbortSignal) => Promise<Result<Post[]>>;
  readNames?: (ids: string[], signal: AbortSignal) => Promise<Result<ChatProfile[]>>;
}) {
  return {
    readPosts: vi.fn(
      over.readPosts ??
        (async (ids: string[]) => ({
          ok: true as const,
          data: ids.map((id) => ({ id, approved_by: null })),
        })),
    ),
    readBriefs: async () => ({ ok: true as const, data: [] }),
    readNames: vi.fn(over.readNames ?? (async () => ({ ok: true as const, data: [] }))),
    postId: (p: Post) => p.id,
    briefId: (b: { id: string }) => b.id,
    approverIds: (posts: readonly Post[]) =>
      posts.map((p) => p.approved_by).filter((id): id is string => id !== null),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('StrictMode: a disposed-then-resumed card cache still reads', () => {
  it('asks made while disposed go out on resume', async () => {
    const readers = readersWith({});
    const cache = createSharedCardCache(readers);
    cache.dispose();
    cache.request({ postIds: ['p1'] });
    cache.resume();
    await tick();
    await tick();
    expect(readers.readPosts).toHaveBeenCalledTimes(1);
    expect(cache.posts(['p1'])).toMatchObject({ loading: false });
  });
});

describe('online/connected revive cards that gave up', () => {
  it('a plain trigger does not; a recovery trigger does', async () => {
    vi.useFakeTimers();
    const fail: Result<Post[]> = { ok: false, error: { code: 'unknown', message: 'x' } };
    const readers = readersWith({ readPosts: async () => fail });
    const cache = createSharedCardCache(readers, { schedule: (f) => f() });
    cache.request({ postIds: ['p1'] });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS * CARD_READ_TRIES);
    expect(cache.posts(['p1']).failed).toEqual(['p1']);
    cache.retryFailed();
    await vi.advanceTimersByTimeAsync(0);
    expect(readers.readPosts).toHaveBeenCalledTimes(CARD_READ_TRIES);
    cache.retryFailed(undefined, { revive: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(readers.readPosts).toHaveBeenCalledTimes(CARD_READ_TRIES + 1);
    cache.dispose();
  });
});

describe('overlapping batches wait for an approver name in flight', () => {
  it('the second batch paints only once the shared name read lands', async () => {
    let resolveNames: (r: Result<ChatProfile[]>) => void = () => {};
    const readers = readersWith({
      readPosts: async (ids) => ({ ok: true, data: ids.map((id) => ({ id, approved_by: 'u1' })) }),
      readNames: () =>
        new Promise((r) => {
          resolveNames = r;
        }),
    });
    const cache = createSharedCardCache(readers);
    cache.request({ postIds: ['p1'] });
    await tick();
    cache.request({ postIds: ['p2'] });
    await tick();
    // p2 is read, but waits on p1's name read: still loading, no nameless paint.
    const versionBefore = cache.version();
    expect(readers.readNames).toHaveBeenCalledTimes(1);
    resolveNames({ ok: true, data: [{ userId: 'u1', displayName: 'Ana', avatarUrl: null }] });
    await tick();
    await tick();
    expect(cache.version()).toBeGreaterThan(versionBefore);
    expect(cache.posts(['p2']).names.get('u1')).toBe('Ana');
  });
});

describe('the first-load roster may land late', () => {
  it('with the grace as trip deadline, a 7s registry answer is not cancelled', async () => {
    vi.useFakeTimers();
    const from = (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'in', 'is']) b[m] = () => b;
      b.then = (resolve: (v: unknown) => unknown) =>
        new Promise((r) =>
          setTimeout(() => r({ data: [], error: null }), table === 'chat_channels' ? 7_000 : 0),
        ).then(resolve);
      return b;
    };
    let result: Result<unknown> | null = null;
    void listChannelSummaries(
      { from } as unknown as Client,
      { workspaceId: 'w', currentUserId: 'me' },
      undefined,
      LATE_READ_GRACE_MS,
    ).then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(7_000);
    expect(result).toEqual({ ok: true, data: [] });
  });
});

describe('withLinkedSignal', () => {
  it('fires on either signal and removes its listeners when done', async () => {
    const a = new AbortController();
    const b = new AbortController();
    const add = vi.spyOn(b.signal, 'addEventListener');
    const remove = vi.spyOn(b.signal, 'removeEventListener');
    await withLinkedSignal(a.signal, b.signal, async () => 1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    let seen: AbortSignal | null = null;
    const pending = withLinkedSignal(a.signal, b.signal, (s) => {
      seen = s;
      return new Promise<void>((r) => s.addEventListener('abort', () => r()));
    });
    b.abort();
    await pending;
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
  });
});

describe('a live verify retry waiting across a switch is dropped', () => {
  it('cancelRetries: no second read, no give-up', async () => {
    vi.useFakeTimers();
    const lookup = vi.fn().mockResolvedValue({ error: 'read timed out' });
    const onGiveUp = vi.fn();
    const verifier = createLiveVerifier({ lookup, warn: vi.fn(), retryDelayMs: 5_000, onGiveUp });
    const pending = verifier.verify('m1');
    await vi.advanceTimersByTimeAsync(0);
    verifier.cancelRetries?.();
    await expect(pending).resolves.toEqual({ found: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(onGiveUp).not.toHaveBeenCalled();
  });
});
