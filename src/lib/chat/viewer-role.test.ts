import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  peekViewerSide,
  resetViewerSideCache,
  resolveViewerSide,
  actsOnBehalfOfClient,
  sideForRole,
} from '@/lib/chat/viewer-role';

// A workspace_members read that yields `role` (or an error) and counts calls.
function makeClient(result: { data: { role: string | null } | null; error: unknown }) {
  const from = vi.fn(() => {
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'eq']) b[method] = () => b;
    b.maybeSingle = () => Promise.resolve(result);
    return b;
  });
  return { client: { from } as unknown as Client, from };
}

beforeEach(() => resetViewerSideCache());

describe('sideForRole', () => {
  it('maps client to client, owner/admin/agency to agency, null to unknown', () => {
    expect(sideForRole('client')).toBe('client');
    expect(sideForRole('owner')).toBe('agency');
    expect(sideForRole('admin')).toBe('agency');
    expect(sideForRole('agency')).toBe('agency');
    expect(sideForRole(null)).toBe('unknown');
  });
});

describe('resolveViewerSide', () => {
  it('reads the role once per workspace and user, sharing the in-flight read', async () => {
    const { client, from } = makeClient({ data: { role: 'client' }, error: null });
    const [a, b] = await Promise.all([
      resolveViewerSide(client, 'ws1', 'u1'),
      resolveViewerSide(client, 'ws1', 'u1'),
    ]);
    expect([a, b]).toEqual(['client', 'client']);
    expect(await resolveViewerSide(client, 'ws1', 'u1')).toBe('client');
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('workspace_members');
    expect(peekViewerSide('ws1', 'u1')).toBe('client');
  });

  it('caches per workspace', async () => {
    const { client, from } = makeClient({ data: { role: 'agency' }, error: null });
    await resolveViewerSide(client, 'ws1', 'u1');
    await resolveViewerSide(client, 'ws2', 'u1');
    expect(from).toHaveBeenCalledTimes(2);
    expect(peekViewerSide('ws2', 'u1')).toBe('agency');
  });

  it('does not cache a failed read (unknown), so the next mount retries', async () => {
    const { client, from } = makeClient({ data: null, error: { message: 'boom' } });
    expect(await resolveViewerSide(client, 'ws1', 'u1')).toBe('unknown');
    expect(peekViewerSide('ws1', 'u1')).toBeUndefined();
    await resolveViewerSide(client, 'ws1', 'u1');
    expect(from).toHaveBeenCalledTimes(2);
  });
});

describe('actsOnBehalfOfClient', () => {
  it('is true for the agency side only', () => {
    expect(actsOnBehalfOfClient('agency')).toBe(true);
    expect(actsOnBehalfOfClient('client')).toBe(false);
    expect(actsOnBehalfOfClient('unknown')).toBe(false);
  });
});
