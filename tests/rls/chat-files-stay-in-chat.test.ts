// Chat files stay in chat (20261005040000_chat_files_stay_in_chat.sql).
// gallery_set, brief_create, comment_create and comment_batch_create refuse a
// version whose asset is chat-origin or soft-deleted ('attachment not
// available'), while a live library version is accepted and a version from
// another workspace keeps the existing 'invalid_payload'. gallery_set still
// saves an existing gallery whose library asset was soft-deleted after it was
// attached. asset_delete(_many) refuse chat-origin assets. The uploader branch
// of chat_attachment_readable reads asset_versions.uploaded_by.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  countWhere,
  createAdminClient,
  insertRow,
  loadRlsEnv,
  nextEntityNumber,
  randomSha256,
  randomSuffix,
  seedAsset,
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

const RLS_SUITE = process.env.RLS_SUITE === '1';

const NOT_AVAILABLE = 'attachment not available';
const CHAT_DELETE = 'chat files are deleted with their message';

interface RpcResult {
  error: { message: string } | null;
}

function expectRefused(res: RpcResult, message: string): void {
  expect(res.error?.message).toBe(message);
}

/**
 * Typed pass-through for direct .rpc() args. Each proc here takes its own
 * p_trace_id (a uuid v7, set at every call site); chat_attachment_readable is a
 * service-role read with no trace parameter by signature. callRpc() is the app
 * wrapper and does not apply to these direct test calls.
 */
function rpcArgs<T>(args: T): T {
  return args;
}

function expectOk(res: RpcResult): void {
  expect(res.error).toBeNull();
}

describe.runIf(RLS_SUITE)('chat files stay in chat', () => {
  let admin: SupabaseClient<Database>;
  let g: GenericClient;
  let owner: SeededUser;
  let client: SeededUser;
  let outsider: SeededUser;
  let ws: SeededWorkspace;
  let other: SeededWorkspace;
  let library: SeededAsset;
  let chat: SeededAsset;
  let deleted: SeededAsset;
  let foreign: SeededAsset;
  let bucketId: string;

  async function softDelete(assetId: string): Promise<void> {
    const res = await g
      .from('assets')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', assetId);
    if (res.error) throw new Error(`assets soft delete failed: ${res.error.message}`);
  }

  async function seedPost(stage: 'draft' | 'review'): Promise<string> {
    const post = await insertRow(g, 'posts', {
      workspace_id: ws.id,
      number: await nextEntityNumber(g, ws.id),
      title: `Post ${randomSuffix()}`,
      bucket_id: bucketId,
      owner_user_id: owner.id,
      platform: 'linkedin',
      format: 'text',
      stage,
      created_by: owner.id,
    });
    return String(post.id);
  }

  async function gallerySet(postId: string, versionIds: string[]): Promise<RpcResult> {
    return await clientFor(owner.id).rpc(
      'gallery_set',
      rpcArgs({
        p_post_id: postId,
        p_asset_version_ids: versionIds,
        p_trace_id: uuidv7(),
      }),
    );
  }

  // brief.create is a client capability (workspace_role_permissions).
  async function briefCreate(versionIds: string[]): Promise<RpcResult> {
    return await clientFor(client.id).rpc(
      'brief_create',
      rpcArgs({
        p_workspace_id: ws.id,
        p_payload: {
          title: `Brief ${randomSuffix()}`,
          objective: 'Objective',
          attachment_asset_version_ids: versionIds,
        },
        p_trace_id: uuidv7(),
      }),
    );
  }

  async function commentCreate(postId: string, versionIds: string[]): Promise<RpcResult> {
    return await clientFor(owner.id).rpc(
      'comment_create',
      rpcArgs({
        p_workspace_id: ws.id,
        p_entity_type: 'post',
        p_entity_id: postId,
        // The proc takes null for a top-level comment; the generated type says string.
        p_parent_comment_id: null as unknown as string,
        p_body: 'with a file',
        p_mentions: null,
        p_attachment_asset_ids: versionIds,
        p_trace_id: uuidv7(),
      }),
    );
  }

  async function commentBatchCreate(postId: string, versionIds: string[]): Promise<RpcResult> {
    return await clientFor(client.id).rpc(
      'comment_batch_create',
      rpcArgs({
        p_workspace_id: ws.id,
        p_post_id: postId,
        p_points: [{ body: 'please check this', attachment_version_ids: versionIds }],
        p_trace_id: uuidv7(),
      }),
    );
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    g = asGeneric(admin);
    owner = await seedUser(env, admin);
    client = await seedUser(env, admin);
    outsider = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Chat files ${owner.email}`);
    other = await seedWorkspace(admin, outsider, `Chat files other ${outsider.email}`);
    await seedMember(g, ws, client, 'client');
    const bucket = await insertRow(g, 'workspace_buckets', {
      workspace_id: ws.id,
      name: `Bucket ${randomSuffix()}`,
      color_hex: '#112233',
    });
    bucketId = String(bucket.id);
    library = await seedAsset(g, ws.id, owner.id, 'library');
    chat = await seedAsset(g, ws.id, owner.id, 'chat');
    deleted = await seedAsset(g, ws.id, owner.id, 'library');
    await softDelete(deleted.assetId);
    foreign = await seedAsset(g, other.id, outsider.id, 'library');
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [ws, other], [owner, client, outsider]);
  });

  describe('gallery_set', () => {
    it('refuses a chat-origin version', async () => {
      expectRefused(await gallerySet(await seedPost('draft'), [chat.versionId]), NOT_AVAILABLE);
    });

    it('refuses a soft-deleted library version', async () => {
      expectRefused(await gallerySet(await seedPost('draft'), [deleted.versionId]), NOT_AVAILABLE);
    });

    it('accepts a live library version', async () => {
      const postId = await seedPost('draft');
      expectOk(await gallerySet(postId, [library.versionId]));
      expect(
        await countWhere(g, 'asset_attachments', [
          ['entity_type', 'post'],
          ['entity_id', postId],
          ['asset_version_id', library.versionId],
        ]),
      ).toBe(1);
    });

    it('still refuses a version from another workspace with invalid_payload', async () => {
      expectRefused(
        await gallerySet(await seedPost('draft'), [foreign.versionId]),
        'invalid_payload',
      );
    });

    it('saves an existing gallery whose library asset was soft-deleted later, but refuses new ones', async () => {
      const postId = await seedPost('draft');
      const attached = await seedAsset(g, ws.id, owner.id, 'library');
      expectOk(await gallerySet(postId, [attached.versionId]));
      await softDelete(attached.assetId);

      // The unchanged gallery and a reorder with a live library version both save.
      expectOk(await gallerySet(postId, [attached.versionId]));
      expectOk(await gallerySet(postId, [library.versionId, attached.versionId]));

      // Adding a NEW soft-deleted or chat-origin version is refused.
      expectRefused(
        await gallerySet(postId, [library.versionId, attached.versionId, deleted.versionId]),
        NOT_AVAILABLE,
      );
      expectRefused(
        await gallerySet(postId, [library.versionId, attached.versionId, chat.versionId]),
        NOT_AVAILABLE,
      );
    });
  });

  describe('brief_create', () => {
    it('refuses a chat-origin version', async () => {
      expectRefused(await briefCreate([chat.versionId]), NOT_AVAILABLE);
    });

    it('refuses a soft-deleted library version', async () => {
      expectRefused(await briefCreate([deleted.versionId]), NOT_AVAILABLE);
    });

    it('accepts a live library version', async () => {
      expectOk(await briefCreate([library.versionId]));
    });

    it('still refuses a version from another workspace with invalid_payload', async () => {
      expectRefused(await briefCreate([foreign.versionId]), 'invalid_payload');
    });
  });

  describe('comment_create', () => {
    let postId: string;
    beforeAll(async () => {
      postId = await seedPost('review');
    });

    it('refuses a chat-origin version', async () => {
      expectRefused(await commentCreate(postId, [chat.versionId]), NOT_AVAILABLE);
    });

    it('refuses a soft-deleted library version', async () => {
      expectRefused(await commentCreate(postId, [deleted.versionId]), NOT_AVAILABLE);
    });

    it('accepts a live library version', async () => {
      expectOk(await commentCreate(postId, [library.versionId]));
    });

    it('still refuses a version from another workspace with invalid_payload', async () => {
      expectRefused(await commentCreate(postId, [foreign.versionId]), 'invalid_payload');
    });
  });

  describe('comment_batch_create', () => {
    let postId: string;
    beforeAll(async () => {
      postId = await seedPost('review');
    });

    it('refuses a chat-origin version', async () => {
      expectRefused(await commentBatchCreate(postId, [chat.versionId]), NOT_AVAILABLE);
    });

    it('refuses a soft-deleted library version', async () => {
      expectRefused(await commentBatchCreate(postId, [deleted.versionId]), NOT_AVAILABLE);
    });

    it('accepts a live library version', async () => {
      expectOk(await commentBatchCreate(postId, [library.versionId]));
    });

    it('still refuses a version from another workspace with invalid_payload', async () => {
      expectRefused(await commentBatchCreate(postId, [foreign.versionId]), 'invalid_payload');
    });
  });

  describe('asset_delete and asset_delete_many', () => {
    async function isDeleted(assetId: string): Promise<boolean> {
      const res = await g.from('assets').select('deleted_at').eq('id', assetId);
      if (res.error) throw new Error(`assets read failed: ${res.error.message}`);
      const rows = res.data as Array<{ deleted_at: string | null }>;
      return rows[0]?.deleted_at !== null;
    }

    it('asset_delete refuses a chat-origin asset and leaves it live', async () => {
      const res = await clientFor(owner.id).rpc(
        'asset_delete',
        rpcArgs({
          p_asset_id: chat.assetId,
          p_trace_id: uuidv7(),
        }),
      );
      expectRefused(res, CHAT_DELETE);
      expect(await isDeleted(chat.assetId)).toBe(false);
    });

    it('asset_delete still deletes a live library asset', async () => {
      const target = await seedAsset(g, ws.id, owner.id, 'library');
      const res = await clientFor(owner.id).rpc(
        'asset_delete',
        rpcArgs({
          p_asset_id: target.assetId,
          p_trace_id: uuidv7(),
        }),
      );
      expectOk(res);
      expect(await isDeleted(target.assetId)).toBe(true);
    });

    it('asset_delete still refuses a non-member', async () => {
      const target = await seedAsset(g, ws.id, owner.id, 'library');
      const res = await clientFor(outsider.id).rpc(
        'asset_delete',
        rpcArgs({
          p_asset_id: target.assetId,
          p_trace_id: uuidv7(),
        }),
      );
      expectRefused(res, 'workspace_member_only');
      expect(await isDeleted(target.assetId)).toBe(false);
    });

    // asset_delete_many reads max(workspace_id) over uuid before any of its
    // checks; Postgres 17 has no max(uuid), so today every call raises and the
    // proc cannot delete anything (live and local alike). That predates this
    // migration and is out of its scope, so this spec asserts only what holds
    // either way: a set holding a chat-origin asset is refused and nothing in it
    // is deleted.
    it('asset_delete_many refuses a set containing a chat-origin asset and deletes nothing', async () => {
      const target = await seedAsset(g, ws.id, owner.id, 'library');
      const res = await clientFor(owner.id).rpc(
        'asset_delete_many',
        rpcArgs({
          p_asset_ids: [target.assetId, chat.assetId],
          p_trace_id: uuidv7(),
        }),
      );
      expect(res.error).not.toBeNull();
      expect(await isDeleted(target.assetId)).toBe(false);
      expect(await isDeleted(chat.assetId)).toBe(false);
    });
  });

  describe('chat_attachment_readable uploader branch', () => {
    it('grants the version uploader, not the asset row uploader', async () => {
      // A chat asset whose row names the owner while its version was uploaded by
      // the client member; no chat message carries it, so only the uploader
      // branch can grant.
      const asset = await insertRow(g, 'assets', {
        workspace_id: ws.id,
        filename: 'voice.m4a',
        uploaded_by: owner.id,
        origin: 'chat',
      });
      const version = await insertRow(g, 'asset_versions', {
        asset_id: asset.id,
        workspace_id: ws.id,
        version_number: 1,
        kind: 'audio',
        r2_key: `key/${crypto.randomUUID()}`,
        mime_type: 'audio/mp4',
        sha256: randomSha256(),
        size_bytes: 1,
        uploaded_by: client.id,
      });
      const versionId = String(version.id);

      const byVersionUploader = await admin.rpc(
        'chat_attachment_readable',
        rpcArgs({
          p_asset_version_id: versionId,
          p_user_id: client.id,
        }),
      );
      expect(byVersionUploader.error).toBeNull();
      expect(byVersionUploader.data).toBe(true);

      const byAssetUploader = await admin.rpc(
        'chat_attachment_readable',
        rpcArgs({
          p_asset_version_id: versionId,
          p_user_id: owner.id,
        }),
      );
      expect(byAssetUploader.error).toBeNull();
      expect(byAssetUploader.data).toBe(false);

      const byOutsider = await admin.rpc(
        'chat_attachment_readable',
        rpcArgs({
          p_asset_version_id: versionId,
          p_user_id: outsider.id,
        }),
      );
      expect(byOutsider.error).toBeNull();
      expect(byOutsider.data).toBe(false);
    });
  });
});
