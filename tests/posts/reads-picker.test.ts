// Query-shape coverage for the chat share picker reads: listPostsForPickerPage
// (sections and keyset-paged search) and countPostsForPicker (head-only count).
// Each call is one posts read; the spec pins its filters, order and paging.

import { describe, expect, it, vi } from 'vitest';
import type { Client } from '../../packages/posts/src/index';
import {
  POST_PICKER_PAGE_COLUMNS,
  countPostsForPicker,
  listPostsForPickerPage,
  pickerCursorOr,
  pickerSearchOr,
} from '../../packages/posts/src/reads';

const WS = 'ws-1';

interface Call {
  method: string;
  args: unknown[];
}

interface Result {
  data: unknown;
  error: { message: string } | null;
  count?: number | null;
}

// A recording PostgREST-ish builder: every chained method logs and returns self;
// awaiting yields the configured result.
function makeClient(result: Result) {
  const calls: Call[] = [];
  const b: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'neq', 'is', 'gte', 'lt', 'or', 'order', 'limit']) {
    b[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return b;
    };
  }
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  const from = vi.fn((table: string) => {
    calls.push({ method: 'from', args: [table] });
    return b;
  });
  return { client: { from } as unknown as Client, from, calls };
}

describe('listPostsForPickerPage: section shape', () => {
  it('filters workspace, live rows, stage and stage_entered_at; newest first, id tiebreak', async () => {
    const { client, from, calls } = makeClient({ data: [], error: null });
    await listPostsForPickerPage(client, {
      workspaceId: WS,
      stage: 'approved',
      enteredSince: '2026-08-29T00:00:00.000Z',
    });
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('posts');
    expect(calls).toContainEqual({ method: 'select', args: [POST_PICKER_PAGE_COLUMNS, {}] });
    expect(calls).toContainEqual({ method: 'eq', args: ['workspace_id', WS] });
    expect(calls).toContainEqual({ method: 'is', args: ['deleted_at', null] });
    expect(calls).toContainEqual({ method: 'eq', args: ['stage', 'approved'] });
    expect(calls).toContainEqual({
      method: 'gte',
      args: ['stage_entered_at', '2026-08-29T00:00:00.000Z'],
    });
    const orders = calls.filter((c) => c.method === 'order');
    expect(orders).toEqual([
      { method: 'order', args: ['created_at', { ascending: false }] },
      { method: 'order', args: ['id', { ascending: false }] },
    ]);
    expect(calls).toContainEqual({ method: 'limit', args: [50] });
    expect(calls.some((c) => c.method === 'or')).toBe(false);
  });

  it('selects the picker columns plus created_at (the cursor key)', () => {
    expect(POST_PICKER_PAGE_COLUMNS).toBe(
      'id, title, platform, format, stage, number, caption, target_date, created_at',
    );
  });
});

describe('listPostsForPickerPage: search shape', () => {
  it('ORs title and caption ILIKE with an exact number, asks for an exact count', async () => {
    const { client, calls } = makeClient({ data: [{ id: 'p1' }], error: null, count: 7 });
    const result = await listPostsForPickerPage(client, {
      workspaceId: WS,
      text: '14',
      number: 14,
      excludeStage: 'draft',
      withCount: true,
    });
    expect(calls).toContainEqual({
      method: 'select',
      args: [POST_PICKER_PAGE_COLUMNS, { count: 'exact' }],
    });
    expect(calls).toContainEqual({
      method: 'or',
      args: ['title.ilike."%14%",caption.ilike."%14%",number.eq.14'],
    });
    expect(calls).toContainEqual({ method: 'neq', args: ['stage', 'draft'] });
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'stage')).toBe(false);
    expect(result).toEqual({ ok: true, data: { rows: [{ id: 'p1' }], count: 7 } });
  });

  it('escapes LIKE metacharacters and PostgREST quoting', () => {
    expect(pickerSearchOr('50%_off, "x"', undefined)).toBe(
      'title.ilike."%50\\\\%\\\\_off, \\"x\\"%",caption.ilike."%50\\\\%\\\\_off, \\"x\\"%"',
    );
    expect(pickerSearchOr('  ', undefined)).toBeNull();
    expect(pickerSearchOr(undefined, 3)).toBe('number.eq.3');
  });

  it('pages by keyset: rows strictly after (created_at, id), no count', async () => {
    const { client, calls } = makeClient({ data: [], error: null, count: 99 });
    const cursor = { createdAt: '2026-09-01T10:00:00.5+00:00', id: 'p9' };
    const result = await listPostsForPickerPage(client, {
      workspaceId: WS,
      text: 'holi',
      cursor,
    });
    const ors = calls.filter((c) => c.method === 'or').map((c) => c.args[0]);
    expect(ors).toEqual(['title.ilike."%holi%",caption.ilike."%holi%"', pickerCursorOr(cursor)]);
    expect(pickerCursorOr(cursor)).toBe(
      'created_at.lt."2026-09-01T10:00:00.5+00:00",and(created_at.eq."2026-09-01T10:00:00.5+00:00",id.lt."p9")',
    );
    expect(result.ok && result.data.count).toBeNull();
  });

  it('caps the page size and surfaces a failure as a Result error', async () => {
    const big = makeClient({ data: [], error: null });
    await listPostsForPickerPage(big.client, { workspaceId: WS, limit: 10_000 });
    expect(big.calls).toContainEqual({ method: 'limit', args: [500] });

    const bad = makeClient({ data: null, error: { message: 'boom' } });
    expect((await listPostsForPickerPage(bad.client, { workspaceId: WS })).ok).toBe(false);
  });
});

describe('countPostsForPicker', () => {
  it('is head-only with an exact count on older approved posts', async () => {
    const { client, from, calls } = makeClient({ data: null, error: null, count: 212 });
    const result = await countPostsForPicker(client, {
      workspaceId: WS,
      stage: 'approved',
      enteredBefore: '2026-08-29T00:00:00.000Z',
    });
    expect(from).toHaveBeenCalledTimes(1);
    expect(calls).toContainEqual({
      method: 'select',
      args: ['id', { count: 'exact', head: true }],
    });
    expect(calls).toContainEqual({ method: 'eq', args: ['stage', 'approved'] });
    expect(calls).toContainEqual({
      method: 'lt',
      args: ['stage_entered_at', '2026-08-29T00:00:00.000Z'],
    });
    expect(calls.some((c) => c.method === 'order' || c.method === 'limit')).toBe(false);
    expect(result).toEqual({ ok: true, data: 212 });
  });

  it('surfaces a failure as a Result error', async () => {
    const { client } = makeClient({ data: null, error: { message: 'boom' } });
    expect((await countPostsForPicker(client, { workspaceId: WS })).ok).toBe(false);
  });
});
