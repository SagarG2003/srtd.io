import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import { POST_CHANGED_EVENT, REFETCH_AFTER_MS } from '@/components/chat/post-card';
import {
  createOpenPostsRunner,
  fetchOpenPosts,
  mergeOpenPosts,
  watchOpenPosts,
  type OpenPostsData,
  type OpenPostRow,
  type OpenPostsReads,
} from '@/lib/chat/use-open-posts';

const WS = 'ws-1';

function row(over: Partial<OpenPostRow> = {}): OpenPostRow {
  return {
    id: 'p1',
    number: 7,
    title: 'Teaser',
    format: 'image',
    target_date: '2026-10-02',
    stage_entered_at: '2026-09-20T00:00:00Z',
    thumbnailAssetVersionId: null,
    ...over,
  };
}

// Recording PostgREST-ish client: logs from() tables and chained calls per read.
function recordingClient(results: Record<string, { data: unknown; count?: number }>) {
  const reads: Array<{ table: string; calls: Array<[string, unknown[]]> }> = [];
  const from = vi.fn((table: string) => {
    const read = { table, calls: [] as Array<[string, unknown[]]> };
    reads.push(read);
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'in', 'like', 'order', 'limit']) {
      b[m] = (...args: unknown[]) => {
        read.calls.push([m, args]);
        return b;
      };
    }
    const head = (): boolean =>
      read.calls.some(
        ([m, a]) => m === 'select' && (a[1] as { head?: boolean } | undefined)?.head === true,
      );
    b.then = (resolve: (v: unknown) => unknown) => {
      const key = table === 'posts' ? (head() ? 'count' : 'list') : table;
      const r = results[key] ?? { data: [] };
      return Promise.resolve({ data: r.data, error: null, count: r.count ?? null }).then(resolve);
    };
    return b;
  });
  return { client: { from } as unknown as Client, reads };
}

describe('fetchOpenPosts: query plan', () => {
  it('one thread open is exactly two posts reads: the list and the head-only count', async () => {
    const { client, reads } = recordingClient({
      list: { data: [{ id: 'p1', number: 1, title: 't', format: 'image' }] },
      count: { data: null, count: 1 },
      asset_attachments: { data: [] },
    });
    const data = await fetchOpenPosts(client, WS);
    const posts = reads.filter((r) => r.table === 'posts');
    expect(posts).toHaveLength(2);
    const list = posts.find((r) => r.calls.some(([m]) => m === 'limit'));
    const count = posts.find((r) => r !== list);
    expect(list?.calls).toContainEqual(['eq', ['stage', 'review']]);
    expect(list?.calls).toContainEqual(['order', ['stage_entered_at', { ascending: true }]]);
    expect(list?.calls).toContainEqual(['limit', [100]]);
    expect(count?.calls).toContainEqual(['select', ['id', { count: 'exact', head: true }]]);
    expect(count?.calls).toContainEqual(['eq', ['stage', 'review']]);
    // The thumbnails resolve in one batched attachments read, never per row.
    expect(reads.filter((r) => r.table === 'asset_attachments')).toHaveLength(1);
    expect(data.count).toBe(1);
    expect(data.posts).toHaveLength(1);
  });

  it('calls each injected read once and returns both', async () => {
    const reads: OpenPostsReads = {
      list: vi.fn(async () => ({ ok: true as const, data: [row()] })),
      count: vi.fn(async () => ({ ok: true as const, data: 140 })),
    };
    const data = await fetchOpenPosts({} as Client, WS, reads);
    expect(reads.list).toHaveBeenCalledTimes(1);
    expect(reads.count).toHaveBeenCalledTimes(1);
    expect(reads.list).toHaveBeenCalledWith({}, { workspaceId: WS });
    expect(data).toEqual({ posts: [row()], count: 140 });
  });

  it('a failed read is null on its side; never throws', async () => {
    const fail = { ok: false as const, error: { code: 'unknown' as const, message: 'x' } };
    const a = await fetchOpenPosts({} as Client, WS, {
      list: async () => ({ ok: true, data: [row()] }),
      count: async () => fail,
    });
    expect(a).toEqual({ posts: [row()], count: null });
    const b = await fetchOpenPosts({} as Client, WS, {
      list: async () => {
        throw new Error('network');
      },
      count: async () => ({ ok: true, data: 4 }),
    });
    expect(b).toEqual({ posts: null, count: 4 });
  });
});

describe('mergeOpenPosts: failed reads (B5)', () => {
  const good = { posts: [row()], count: 3, failed: false };

  it('a good list replaces; a failed count falls back to the rows', () => {
    expect(mergeOpenPosts(null, { posts: [row()], count: 9 })).toEqual({
      posts: [row()],
      count: 9,
      failed: false,
    });
    expect(mergeOpenPosts(good, { posts: [], count: null })).toEqual({
      posts: [],
      count: 0,
      failed: false,
    });
  });

  it('failed first list read is failed (never a known zero), with or without a count', () => {
    expect(mergeOpenPosts(null, { posts: null, count: null })).toEqual({
      posts: null,
      count: null,
      failed: true,
    });
    expect(mergeOpenPosts(null, { posts: null, count: 0 }).failed).toBe(true);
  });

  it('a refetch whose list fails keeps the old list and takes a good count', () => {
    expect(mergeOpenPosts(good, { posts: null, count: 5 })).toEqual({
      posts: [row()],
      count: 5,
      failed: false,
    });
    expect(mergeOpenPosts(good, { posts: null, count: null })).toEqual(good);
  });
});

/** A fetch whose rounds settle only when the test says so. */
function deferredFetch() {
  const pending: Array<{ key: string; resolve: (d: OpenPostsData) => void }> = [];
  let active = 0;
  let maxActive = 0;
  const fetch = vi.fn(
    (key: string) =>
      new Promise<OpenPostsData>((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        pending.push({
          key,
          resolve: (d) => {
            active -= 1;
            resolve(d);
          },
        });
      }),
  );
  const settleNext = async (data: OpenPostsData = { posts: [], count: 0 }): Promise<void> => {
    pending.shift()?.resolve(data);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { fetch, pending, settleNext, maxActive: () => maxActive };
}

describe('createOpenPostsRunner: one round in flight (B2)', () => {
  it('three triggers in a burst produce two rounds total, never concurrent', async () => {
    const d = deferredFetch();
    const onSettle = vi.fn();
    const runner = createOpenPostsRunner({ fetch: d.fetch, onSettle, now: () => 5 });
    runner.request('a');
    runner.request('a');
    runner.request('a');
    expect(d.fetch).toHaveBeenCalledTimes(1);
    await d.settleNext();
    expect(d.fetch).toHaveBeenCalledTimes(2);
    await d.settleNext();
    expect(d.fetch).toHaveBeenCalledTimes(2);
    expect(d.maxActive()).toBe(1);
    expect(onSettle).toHaveBeenCalledTimes(2);
  });

  it('fetchedAt is null before the first round and the start time after', () => {
    const d = deferredFetch();
    let now = 42;
    const runner = createOpenPostsRunner({ fetch: d.fetch, onSettle: vi.fn(), now: () => now });
    expect(runner.fetchedAt()).toBeNull();
    runner.request('a');
    now = 99;
    expect(runner.fetchedAt()).toBe(42);
  });

  it('a visibility change during the first fetch does not start a second round', async () => {
    const d = deferredFetch();
    const runner = createOpenPostsRunner({ fetch: d.fetch, onSettle: vi.fn(), now: () => 1_000 });
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const stop = watchOpenPosts(
      { window: win, document: doc },
      { fetchedAt: runner.fetchedAt, now: () => 1_500, refetch: () => runner.request('a') },
    );
    runner.request('a');
    doc.dispatchEvent(new Event('visibilitychange'));
    await d.settleNext();
    expect(d.fetch).toHaveBeenCalledTimes(1);
    stop();
  });

  it('a thread switch mid-round waits, drops the old result, then reads the new key', async () => {
    const d = deferredFetch();
    const onSettle = vi.fn();
    const runner = createOpenPostsRunner({ fetch: d.fetch, onSettle, now: () => 0 });
    runner.request('a');
    runner.request('b');
    expect(d.fetch).toHaveBeenCalledTimes(1);
    await d.settleNext();
    expect(onSettle).not.toHaveBeenCalled();
    expect(d.fetch).toHaveBeenLastCalledWith('b');
    await d.settleNext();
    expect(onSettle).toHaveBeenCalledWith('b', { posts: [], count: 0 });
    expect(d.maxActive()).toBe(1);
  });

  it('dispose drops results and stops follow-up rounds', async () => {
    const d = deferredFetch();
    const onSettle = vi.fn();
    const runner = createOpenPostsRunner({ fetch: d.fetch, onSettle, now: () => 0 });
    runner.request('a');
    runner.request('a');
    runner.dispose();
    await d.settleNext();
    expect(onSettle).not.toHaveBeenCalled();
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('watchOpenPosts: refetch rules', () => {
  function targets() {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    return { window: win, document: doc };
  }

  it('refetches on any sorted:post-changed event', () => {
    const t = targets();
    const refetch = vi.fn();
    const stop = watchOpenPosts(t, { fetchedAt: () => 0, now: () => 0, refetch });
    t.window.dispatchEvent(new CustomEvent(POST_CHANGED_EVENT, { detail: { postId: 'any' } }));
    t.window.dispatchEvent(new CustomEvent(POST_CHANGED_EVENT));
    expect(refetch).toHaveBeenCalledTimes(2);
    stop();
    t.window.dispatchEvent(new CustomEvent(POST_CHANGED_EVENT));
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it('no visibility refetch before any round has started', () => {
    const t = targets();
    const refetch = vi.fn();
    const stop = watchOpenPosts(t, { fetchedAt: () => null, now: () => 1e12, refetch });
    t.document.dispatchEvent(new Event('visibilitychange'));
    expect(refetch).not.toHaveBeenCalled();
    stop();
  });

  it('refetches on visible only after more than 60 s since the last fetch', () => {
    const t = targets();
    const refetch = vi.fn();
    let now = 1_000;
    const stop = watchOpenPosts(t, { fetchedAt: () => 1_000, now: () => now, refetch });
    now = 1_000 + REFETCH_AFTER_MS;
    t.document.dispatchEvent(new Event('visibilitychange'));
    expect(refetch).not.toHaveBeenCalled();
    now = 1_001 + REFETCH_AFTER_MS;
    t.document.visibilityState = 'hidden';
    t.document.dispatchEvent(new Event('visibilitychange'));
    expect(refetch).not.toHaveBeenCalled();
    t.document.visibilityState = 'visible';
    t.document.dispatchEvent(new Event('visibilitychange'));
    expect(refetch).toHaveBeenCalledTimes(1);
    stop();
  });
});
