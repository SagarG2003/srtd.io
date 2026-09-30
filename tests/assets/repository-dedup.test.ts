// The service-role findVersionBySha must scope dedup by the parent asset's
// origin (and, for chat, its uploader) through the asset_versions -> assets FK.
// supabase-js is mocked so the recorded query chain is asserted without a DB.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ ops: [] as Array<[string, ...unknown[]]> }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      calls.ops.push(['from', table]);
      const builder = {
        select: (cols: string) => {
          calls.ops.push(['select', cols]);
          return builder;
        },
        eq: (col: string, value: unknown) => {
          calls.ops.push(['eq', col, value]);
          return builder;
        },
        update: (values: unknown) => {
          calls.ops.push(['update', values]);
          return builder;
        },
        in: (col: string, values: unknown) => {
          calls.ops.push(['in', col, values]);
          return builder;
        },
        is: (col: string, value: unknown) => {
          calls.ops.push(['is', col, value]);
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        insert: () => Promise.resolve({ error: null }),
        then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
          resolve({ data: [], error: null }),
      };
      return builder;
    },
  }),
}));

import { createSupabaseAssetRepository } from '@/server/assets';

const WORKSPACE = '11111111-1111-7111-8111-111111111111';
const USER = '33333333-3333-7333-8333-333333333333';
const SHA = 'a'.repeat(64);

function repo(): ReturnType<typeof createSupabaseAssetRepository> {
  return createSupabaseAssetRepository({
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SECRET_KEY: 'service-role-key',
  });
}

beforeEach(() => {
  calls.ops = [];
});

describe('createSupabaseAssetRepository.findVersionBySha', () => {
  it('inner-joins the parent asset via the asset_id FK', async () => {
    await repo().findVersionBySha({
      workspaceId: WORKSPACE,
      sha256: SHA,
      origin: 'library',
      uploadedBy: USER,
    });
    const select = calls.ops.find((op) => op[0] === 'select');
    expect(select?.[1]).toContain('assets!asset_versions_asset_id_fkey!inner(origin,uploaded_by)');
  });

  it('library dedup filters to library assets only, any uploader', async () => {
    await repo().findVersionBySha({
      workspaceId: WORKSPACE,
      sha256: SHA,
      origin: 'library',
      uploadedBy: USER,
    });
    expect(calls.ops).toContainEqual(['eq', 'workspace_id', WORKSPACE]);
    expect(calls.ops).toContainEqual(['eq', 'sha256', SHA]);
    expect(calls.ops).toContainEqual(['eq', 'assets.origin', 'library']);
    expect(calls.ops.some((op) => op[1] === 'assets.uploaded_by')).toBe(false);
  });

  it('chat dedup filters to the caller own chat assets, ignoring deleted_at', async () => {
    await repo().findVersionBySha({
      workspaceId: WORKSPACE,
      sha256: SHA,
      origin: 'chat',
      uploadedBy: USER,
    });
    expect(calls.ops).toContainEqual(['eq', 'assets.origin', 'chat']);
    expect(calls.ops).toContainEqual(['eq', 'assets.uploaded_by', USER]);
    expect(calls.ops.some((op) => op[0] === 'is' && op[1] === 'assets.deleted_at')).toBe(false);
  });
});

describe('createSupabaseAssetRepository.moveAssetsToFolder', () => {
  it('only moves library assets (a chat file never goes into a folder)', async () => {
    await repo().moveAssetsToFolder({
      workspaceId: WORKSPACE,
      assetIds: ['a1'],
      targetFolderId: null,
      actorUserId: USER,
      traceId: 'trace-1',
    });
    expect(calls.ops).toContainEqual(['eq', 'origin', 'library']);
  });
});
