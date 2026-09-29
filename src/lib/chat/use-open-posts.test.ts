import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import { POST_CHANGED_EVENT, REFETCH_AFTER_MS } from '@/components/chat/post-card';
import {
  fetchOpenPosts,
  watchOpenPosts,
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

  it('a failed count falls back to the rows; a failed list is null; never throws', async () => {
    const fail = { ok: false as const, error: { code: 'unknown' as const, message: 'x' } };
    const a = await fetchOpenPosts({} as Client, WS, {
      list: async () => ({ ok: true, data: [row(), row({ id: 'p2' })] }),
      count: async () => fail,
    });
    expect(a).toEqual({ posts: [row(), row({ id: 'p2' })], count: 2 });
    const b = await fetchOpenPosts({} as Client, WS, {
      list: async () => {
        throw new Error('network');
      },
      count: async () => fail,
    });
    expect(b).toEqual({ posts: null, count: null });
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
