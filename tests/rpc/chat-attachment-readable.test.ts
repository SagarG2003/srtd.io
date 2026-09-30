// chat_attachment_readable(p_asset_version_id, p_user_id)
// (20260930160000_assets_origin_chat_private.sql). Service-role only: EXECUTE
// is revoked from anon and authenticated. True for the uploader, or for a member
// of a chat holding a live message that carries the version, sent after the
// member's clear point. Seeds through the service role; each case uses its own
// chat-origin asset so the cases do not share a message.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  createAnonClient,
  insertRow,
  loadRlsEnv,
  partitionTimestamp,
  seedAsset,
  seedDmChannel,
  seedMember,
  seedUser,
  seedWorkspace,
  type GenericClient,
  type SeededAsset,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RPC_SUITE = process.env.RPC_SUITE === '1';

describe.runIf(RPC_SUITE)('chat_attachment_readable', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let uploader: SeededUser;
  let peer: SeededUser;
  let outsider: SeededUser;
  let ws: SeededWorkspace;
  let dmChannelId: string;

  async function readable(versionId: string, userId: string): Promise<boolean> {
    // chat_attachment_readable is a read check whose live signature takes no
    // trace parameter; sending one would break the PostgREST function lookup
    // (same exemption as chat_unread_counts in tests/rls/chat.test.ts).
    // eslint-disable-next-line no-restricted-syntax
    const res = await admin.rpc('chat_attachment_readable', {
      p_asset_version_id: versionId,
      p_user_id: userId,
    });
    if (res.error) throw new Error(`chat_attachment_readable failed: ${res.error.message}`);
    return res.data;
  }

  // A chat-origin asset uploaded by `uploader` and one DM message carrying it.
  async function seedChatFile(
    createdAt: string = new Date().toISOString(),
  ): Promise<SeededAsset & { messageId: string }> {
    const asset = await seedAsset(g, ws.id, uploader.id, 'chat');
    const messageId = crypto.randomUUID();
    await insertRow(g, 'chat_messages', {
      id: messageId,
      channel_id: dmChannelId,
      workspace_id: ws.id,
      sender_user_id: uploader.id,
      body: 'file',
      attachment_asset_ids: [asset.versionId],
      agora_event_id: null,
      created_at: createdAt,
    });
    return { ...asset, messageId };
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    uploader = await seedUser(env, admin);
    peer = await seedUser(env, admin);
    outsider = await seedUser(env, admin);
    ws = await seedWorkspace(admin, uploader, `Readable ${uploader.email}`);
    await seedMember(g, ws, peer, 'agency');
    await seedMember(g, ws, outsider, 'agency');
    dmChannelId = await seedDmChannel(g, ws.id, uploader, peer);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [ws], [uploader, peer, outsider]);
  });

  it('is not executable by authenticated (or anon)', async () => {
    const file = await seedChatFile();
    const args = { p_asset_version_id: file.versionId, p_user_id: peer.id };
    const asUser = await clientFor(peer.id).rpc('chat_attachment_readable', args);
    expect(asUser.error?.code).toBe('42501');
    expect(asUser.data).toBeNull();
    const asAnon = await createAnonClient(loadRlsEnv()).rpc('chat_attachment_readable', args);
    expect(asAnon.error?.code).toBe('42501');
    expect(asAnon.data).toBeNull();
  });

  it('service role: true for the uploader, even with no message', async () => {
    const asset = await seedAsset(g, ws.id, uploader.id, 'chat');
    expect(await readable(asset.versionId, uploader.id)).toBe(true);
  });

  it('service role: true for a channel member with a live message', async () => {
    const file = await seedChatFile();
    expect(await readable(file.versionId, peer.id)).toBe(true);
  });

  it('service role: false for a workspace member outside the chat', async () => {
    const file = await seedChatFile();
    expect(await readable(file.versionId, outsider.id)).toBe(false);
  });

  it('service role: false once the message is deleted', async () => {
    const file = await seedChatFile();
    expect(await readable(file.versionId, peer.id)).toBe(true);
    const res = await g
      .from('chat_messages')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', file.messageId);
    expect(res.error).toBeNull();
    expect(await readable(file.versionId, peer.id)).toBe(false);
  });

  it("service role: false for a message at or before the user's clear point", async () => {
    // The message sits in an old partition; the clear lands one day later, so
    // it hides only this message and none of the other cases' (sent now).
    const file = await seedChatFile(partitionTimestamp);
    expect(await readable(file.versionId, peer.id)).toBe(true);
    const cleared = new Date(Date.parse(partitionTimestamp) + 86_400_000).toISOString();
    await insertRow(g, 'chat_channel_clears', {
      channel_id: dmChannelId,
      workspace_id: ws.id,
      user_id: peer.id,
      cleared_at: cleared,
    });
    expect(await readable(file.versionId, peer.id)).toBe(false);
  });
});
