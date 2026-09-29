// Query-shape coverage for the chat open-loops reads: listOpenPosts (review
// posts, longest waiting first, capped, one batched thumbnail read) and
// countOpenPosts (head-only count on the same filter).

import { describe, expect, it, vi } from 'vitest';
import type { Client } from '../../packages/posts/src/index';
import {
  OPEN_POST_COLUMNS,
  OPEN_POSTS_LIMIT,
  countOpenPosts,
  listOpenPosts,
} from '../../packages/posts/src/reads';

const WS = 'ws-1';

interface Call {
  table: string;
  method: string;
  args: unknown[];
}

function makeClient(
  results: Record<
    string,
    { data: unknown; error?: { message: string } | null; count?: number | null }
  >,
) {
  const calls: Call[] = [];
  const from = vi.fn((table: string) => {
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'in', 'like', 'order', 'limit']) {
      b[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown) => {
      const r = results[table] ?? { data: [] };
      return Promise.resolve({ data: r.data, error: r.error ?? null, count: r.count ?? null }).then(
        resolve,
      );
    };
    return b;
  });
  return { client: { from } as unknown as Client, from, calls };
}

describe('listOpenPosts', () => {
  it('reads review posts in the workspace, live only, stage_entered_at asc, limit 100', async () => {
    const { client, calls } = makeClient({ posts: { data: [] } });
    await listOpenPosts(client, { workspaceId: WS });
    const posts = calls.filter((c) => c.table === 'posts');
    expect(posts).toEqual([
      { table: 'posts', method: 'select', args: [OPEN_POST_COLUMNS] },
      { table: 'posts', method: 'eq', args: ['workspace_id', WS] },
      { table: 'posts', method: 'eq', args: ['stage', 'review'] },
      { table: 'posts', method: 'is', args: ['deleted_at', null] },
      { table: 'posts', method: 'order', args: ['stage_entered_at', { ascending: true }] },
      { table: 'posts', method: 'limit', args: [OPEN_POSTS_LIMIT] },
    ]);
    expect(OPEN_POSTS_LIMIT).toBe(100);
    expect(OPEN_POST_COLUMNS).toBe('id, number, title, format, target_date, stage_entered_at');
  });

  it('skips the thumbnail read when no post came back', async () => {
    const { client, from } = makeClient({ posts: { data: [] } });
    const result = await listOpenPosts(client, { workspaceId: WS });
    expect(result).toEqual({ ok: true, data: [] });
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('resolves thumbnails in ONE batched attachments read over every row', async () => {
    const base = { title: 't', format: 'image', target_date: null, stage_entered_at: 'x' };
    const { client, from, calls } = makeClient({
      posts: {
        data: [
          { id: 'a', number: 1, ...base },
          { id: 'b', number: 2, ...base },
        ],
      },
      asset_attachments: {
        data: [
          { entity_id: 'a', asset_version_id: 'v1', asset_versions: { mime_type: 'image/png' } },
          { entity_id: 'a', asset_version_id: 'v2', asset_versions: { mime_type: 'image/png' } },
        ],
      },
    });
    const result = await listOpenPosts(client, { workspaceId: WS });
    expect(from).toHaveBeenCalledTimes(2);
    expect(calls).toContainEqual({
      table: 'asset_attachments',
      method: 'in',
      args: ['entity_id', ['a', 'b']],
    });
    expect(result.ok && result.data.map((p) => p.thumbnailAssetVersionId)).toEqual(['v1', null]);
  });

  it('surfaces a transport error', async () => {
    const { client } = makeClient({ posts: { data: null, error: { message: 'boom' } } });
    expect(await listOpenPosts(client, { workspaceId: WS })).toEqual({
      ok: false,
      error: { code: 'unknown', message: 'boom' },
    });
  });
});

describe('countOpenPosts', () => {
  it('head-only exact count on the same filter', async () => {
    const { client, calls } = makeClient({ posts: { data: null, count: 12 } });
    const result = await countOpenPosts(client, { workspaceId: WS });
    expect(result).toEqual({ ok: true, data: 12 });
    expect(calls).toEqual([
      { table: 'posts', method: 'select', args: ['id', { count: 'exact', head: true }] },
      { table: 'posts', method: 'eq', args: ['workspace_id', WS] },
      { table: 'posts', method: 'eq', args: ['stage', 'review'] },
      { table: 'posts', method: 'is', args: ['deleted_at', null] },
    ]);
  });

  it('a null count reads as zero; an error is a failure', async () => {
    expect(
      await countOpenPosts(makeClient({ posts: { data: null } }).client, { workspaceId: WS }),
    ).toEqual({ ok: true, data: 0 });
    const failed = await countOpenPosts(
      makeClient({ posts: { data: null, error: { message: 'no' } } }).client,
      { workspaceId: WS },
    );
    expect(failed.ok).toBe(false);
  });
});
