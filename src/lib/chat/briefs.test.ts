import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  BRIEF_FILTERS,
  DEFAULT_BRIEF_FILTER,
  briefPostCountLabel,
  briefRoute,
  countPostsByBrief,
  embedPostCount,
  filterBriefStatus,
  listBriefsForPicker,
  toPickerRow,
  briefStatusLabel,
  readBriefIdsByNumbers,
  readBriefsByIds,
  sharedBriefViews,
  toggleBrief,
  type BriefCardFields,
} from '@/lib/chat/briefs';

const BRIEF: BriefCardFields = { id: 'b1', title: 'Autumn launch', status: 'open', createdAt: 't' };

describe('shared briefs', () => {
  it('renders one view per id, unavailable when the read did not return it', () => {
    expect(sharedBriefViews(['b1', 'gone'], [BRIEF])).toEqual([
      { kind: 'brief', briefId: 'b1', title: 'Autumn launch', status: 'open' },
      { kind: 'unavailable', briefId: 'gone' },
    ]);
  });

  it('labels status, routes to the brief, and toggles selection', () => {
    expect(briefStatusLabel('open')).toBe('Open');
    expect(briefStatusLabel('closed')).toBe('Closed');
    expect(briefRoute('b1')).toBe('/briefs/b1');
    expect(toggleBrief([], BRIEF)).toEqual([BRIEF]);
    expect(toggleBrief([BRIEF], BRIEF)).toEqual([]);
  });

  it('reads by ids in one workspace-scoped IN query; empty in, no round trip', async () => {
    const is = vi.fn(() =>
      Promise.resolve({
        data: [{ id: 'b1', title: 'Autumn launch', status: 'closed', created_at: 't' }],
        error: null,
      }),
    );
    const inFn = vi.fn(() => ({ is }));
    const eq = vi.fn(() => ({ in: inFn }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Client;
    expect(await readBriefsByIds(client, { workspaceId: 'w', ids: [] })).toEqual({
      ok: true,
      data: [],
    });
    expect(from).not.toHaveBeenCalled();
    const result = await readBriefsByIds(client, { workspaceId: 'w', ids: ['b1'] });
    expect(eq).toHaveBeenCalledWith('workspace_id', 'w');
    expect(inFn).toHaveBeenCalledWith('id', ['b1']);
    expect(result).toEqual({
      ok: true,
      data: [{ id: 'b1', title: 'Autumn launch', status: 'closed', createdAt: 't' }],
    });
  });
});

describe('readBriefIdsByNumbers', () => {
  it('reads ids by number in one workspace-scoped IN query over live briefs', async () => {
    const is = vi.fn(() => Promise.resolve({ data: [{ id: 'b1', number: 7 }], error: null }));
    const inFn = vi.fn(() => ({ is }));
    const eq = vi.fn(() => ({ in: inFn }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const client = { from } as unknown as Client;
    expect(await readBriefIdsByNumbers(client, { workspaceId: 'w', numbers: [] })).toEqual({
      ok: true,
      data: [],
    });
    expect(from).not.toHaveBeenCalled();
    const result = await readBriefIdsByNumbers(client, { workspaceId: 'w', numbers: [7, 8] });
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('briefs');
    expect(select).toHaveBeenCalledWith('id, number');
    expect(eq).toHaveBeenCalledWith('workspace_id', 'w');
    expect(inFn).toHaveBeenCalledWith('number', [7, 8]);
    expect(is).toHaveBeenCalledWith('deleted_at', null);
    expect(result).toEqual({ ok: true, data: [{ id: 'b1', number: 7 }] });
  });

  it('surfaces a read failure as a Result error', async () => {
    const is = vi.fn(() => Promise.resolve({ data: null, error: { message: 'boom' } }));
    const client = {
      from: () => ({ select: () => ({ eq: () => ({ in: () => ({ is }) }) }) }),
    } as unknown as Client;
    const result = await readBriefIdsByNumbers(client, { workspaceId: 'w', numbers: [1] });
    expect(result.ok).toBe(false);
  });
});

interface Call {
  table: string;
  method: string;
  args: unknown[];
}

// A recording builder per table: every chained method returns self and logs;
// awaiting yields that table's configured result.
function makeClient(results: Record<string, { data: unknown; error: { message: string } | null }>) {
  const calls: Call[] = [];
  const from = vi.fn((table: string) => {
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'in', 'ilike', 'order', 'limit']) {
      b[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(results[table] ?? { data: [], error: null }).then(resolve);
    return b;
  });
  return { client: { from } as unknown as Client, from, calls };
}

const DB_ROW = {
  id: 'b1',
  number: 7,
  title: 'Autumn launch',
  objective: 'Drive signups',
  format_requested: 'reel',
  target_date: '2026-10-02',
  status: 'open',
  created_at: '2026-09-20T10:00:00Z',
};

describe('listBriefsForPicker', () => {
  it('filters by status and title, newest first, then counts posts in ONE second query', async () => {
    const { client, from, calls } = makeClient({
      briefs: { data: [DB_ROW, { ...DB_ROW, id: 'b2', number: 8 }], error: null },
      posts: { data: [{ brief_id: 'b1' }, { brief_id: 'b1' }], error: null },
    });
    const result = await listBriefsForPicker(client, {
      workspaceId: 'w',
      titleQuery: ' launch ',
      status: 'open',
    });
    expect(from).toHaveBeenCalledTimes(2);
    expect(calls).toContainEqual({
      table: 'briefs',
      method: 'select',
      args: ['id, number, title, objective, format_requested, target_date, status, created_at'],
    });
    expect(calls).toContainEqual({ table: 'briefs', method: 'eq', args: ['workspace_id', 'w'] });
    expect(calls).toContainEqual({ table: 'briefs', method: 'eq', args: ['status', 'open'] });
    expect(calls).toContainEqual({ table: 'briefs', method: 'is', args: ['deleted_at', null] });
    expect(calls).toContainEqual({ table: 'briefs', method: 'ilike', args: ['title', '%launch%'] });
    expect(calls).toContainEqual({ table: 'posts', method: 'select', args: ['brief_id'] });
    expect(calls).toContainEqual({ table: 'posts', method: 'eq', args: ['workspace_id', 'w'] });
    expect(calls).toContainEqual({
      table: 'posts',
      method: 'in',
      args: ['brief_id', ['b1', 'b2']],
    });
    expect(calls).toContainEqual({ table: 'posts', method: 'is', args: ['deleted_at', null] });
    expect(result.ok && result.data.map((b) => [b.id, b.postCount])).toEqual([
      ['b1', 2],
      ['b2', 0],
    ]);
  });

  it('passes no status for All briefs and skips the count query for an empty page', async () => {
    const { client, from, calls } = makeClient({ briefs: { data: [], error: null } });
    const result = await listBriefsForPicker(client, { workspaceId: 'w', titleQuery: '' });
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'status')).toBe(false);
    expect(from).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, data: [] });
  });

  it('surfaces either read failing as a Result error', async () => {
    const a = makeClient({ briefs: { data: null, error: { message: 'boom' } } });
    expect((await listBriefsForPicker(a.client, { workspaceId: 'w', titleQuery: '' })).ok).toBe(
      false,
    );
    const b = makeClient({
      briefs: { data: [DB_ROW], error: null },
      posts: { data: null, error: { message: 'boom' } },
    });
    expect((await listBriefsForPicker(b.client, { workspaceId: 'w', titleQuery: '' })).ok).toBe(
      false,
    );
  });
});

describe('brief picker helpers', () => {
  it('maps the aggregate embed shape to a count', () => {
    expect(embedPostCount([{ count: 3 }])).toBe(3);
    expect(embedPostCount([])).toBe(0);
    expect(embedPostCount(null)).toBe(0);
  });

  it('maps the fallback shape (one brief_id per live post) to counts', () => {
    const counts = countPostsByBrief([
      { brief_id: 'b1' },
      { brief_id: 'b2' },
      { brief_id: 'b1' },
      { brief_id: null },
    ]);
    expect(counts.get('b1')).toBe(2);
    expect(counts.get('b2')).toBe(1);
    expect(counts.has('b3')).toBe(false);
  });

  it('maps a DB row to a picker row', () => {
    expect(toPickerRow(DB_ROW, 4)).toEqual({
      id: 'b1',
      number: 7,
      title: 'Autumn launch',
      objective: 'Drive signups',
      formatRequested: 'reel',
      targetDate: '2026-10-02',
      status: 'open',
      createdAt: '2026-09-20T10:00:00Z',
      postCount: 4,
    });
  });

  it('labels the post count', () => {
    expect(briefPostCountLabel(0)).toBe('No posts yet');
    expect(briefPostCountLabel(1)).toBe('1 post');
    expect(briefPostCountLabel(5)).toBe('5 posts');
  });

  it('describes the status filter chips, Open by default', () => {
    expect(BRIEF_FILTERS.map((f) => f.label)).toEqual(['Open', 'Closed', 'All briefs']);
    expect(DEFAULT_BRIEF_FILTER).toBe('open');
    expect(filterBriefStatus('open')).toBe('open');
    expect(filterBriefStatus('closed')).toBe('closed');
    expect(filterBriefStatus('all')).toBeUndefined();
  });
});
