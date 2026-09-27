import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  briefRoute,
  briefStatusLabel,
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
