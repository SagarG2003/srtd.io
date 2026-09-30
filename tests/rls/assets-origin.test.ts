// assets.origin read scoping (20260930160000_assets_origin_chat_private.sql).
// Chat files are private to their chat: an authenticated workspace member must
// not read a chat-origin asset or any of its versions through RLS, while a
// library asset and its version stay readable. Service-role counts are the
// ground truth that each seeded row exists, so a 0 is a real RLS deny.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  countWhere,
  createAdminClient,
  loadRlsEnv,
  seedAsset,
  seedMember,
  seedUser,
  seedWorkspace,
  visibleRowCount,
  type GenericClient,
  type SeededAsset,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

describe.runIf(RLS_SUITE)(
  'assets.origin: chat assets are hidden, library assets are visible',
  () => {
    let admin: SupabaseClient<Database>;
    let g: GenericClient;
    let owner: SeededUser;
    let member: SeededUser;
    let ws: SeededWorkspace;
    let library: SeededAsset;
    let chat: SeededAsset;

    beforeAll(async () => {
      const env = loadRlsEnv();
      admin = createAdminClient(env);
      g = asGeneric(admin);
      owner = await seedUser(env, admin);
      member = await seedUser(env, admin);
      ws = await seedWorkspace(admin, owner, `Origin ${owner.email}`);
      await seedMember(g, ws, member, 'client');
      library = await seedAsset(g, ws.id, owner.id, 'library');
      chat = await seedAsset(g, ws.id, owner.id, 'chat');
    });

    afterAll(async () => {
      await cleanupWorkspaces(admin, [ws], [owner, member]);
    });

    it('seeds both assets and versions (service-role ground truth)', async () => {
      expect(await countWhere(g, 'assets', [['id', library.assetId]])).toBe(1);
      expect(await countWhere(g, 'assets', [['id', chat.assetId]])).toBe(1);
      expect(await countWhere(g, 'asset_versions', [['id', library.versionId]])).toBe(1);
      expect(await countWhere(g, 'asset_versions', [['id', chat.versionId]])).toBe(1);
    });

    it('a workspace member can SELECT a library asset and its version', async () => {
      const client = asGeneric(clientFor(member.id));
      expect(await visibleRowCount(client, 'assets', [['id', library.assetId]])).toBe(1);
      expect(await visibleRowCount(client, 'asset_versions', [['id', library.versionId]])).toBe(1);
    });

    it('a workspace member cannot SELECT a chat-origin asset or its version', async () => {
      const client = asGeneric(clientFor(member.id));
      expect(await visibleRowCount(client, 'assets', [['id', chat.assetId]])).toBe(0);
      expect(await visibleRowCount(client, 'asset_versions', [['id', chat.versionId]])).toBe(0);
    });

    it('the uploader cannot SELECT its own chat-origin asset through RLS either', async () => {
      const client = asGeneric(clientFor(owner.id));
      expect(await visibleRowCount(client, 'assets', [['id', library.assetId]])).toBe(1);
      expect(await visibleRowCount(client, 'assets', [['id', chat.assetId]])).toBe(0);
      expect(await visibleRowCount(client, 'asset_versions', [['id', chat.versionId]])).toBe(0);
    });

    it('a workspace-wide listing returns library assets only', async () => {
      const client = asGeneric(clientFor(member.id));
      const res = await client.from('assets').select('id,origin').eq('workspace_id', ws.id);
      expect(res.error).toBeNull();
      const rows = res.data as Array<{ id: string; origin: string }>;
      expect(rows.map((r) => r.id)).toEqual([library.assetId]);
      expect(rows.every((r) => r.origin === 'library')).toBe(true);
    });
  },
);
