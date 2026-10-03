// Personal notes channel and search kind (20261003170000_notes_channel_and_search_kind.sql):
//
//   T1. notes_channel_ensure returns notes__<workspace>__<caller>; a second call
//       returns the same id and writes no second audit_log row.
//   T2. A user outside the workspace gets 'workspace_member_only'.
//   T3. The owner sends to their notes channel (chat_message_send) and reads the
//       channel row and the message.
//   T4. Another member of the same workspace cannot read the notes channel row
//       or its messages, cannot send to it, and chat_message_search returns
//       none of its rows.
//   T5. A user from another workspace gets nothing (channel, messages, search).
//   T6. chat_message_delete has no time window in notes (a 31 minute old notes
//       message deletes); a 31 minute old DM message is still refused.
//   T7. chat_message_search p_kind photo / voice / file / link returns only
//       matching messages, with an empty query and with a narrowing query.
//   T8. An unknown p_kind returns no rows; no query and no kind returns no rows.
//   T9. authenticated cannot INSERT into chat_channels directly.
//  T10. chat_channels_shape rejects a notes row with no owner_user_id or with a
//       channel_id that does not match its workspace and owner.
//
// Seeding goes through the service role (the privileged path), following the
// rationale in packages/test-utils/rls.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  authInsert,
  cleanupWorkspaces,
  clientFor,
  countWhere,
  createAdminClient,
  generateTraceId,
  insertRow,
  loadRlsEnv,
  ownReadCount,
  randomSuffix,
  seedDmChannel,
  seedMember,
  seedUser,
  seedWorkspace,
  visibleRowCount,
  type GenericClient,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

type Client = SupabaseClient<Database>;
type EnsureArgs = Database['public']['Functions']['notes_channel_ensure']['Args'];
type SendArgs = Database['public']['Functions']['chat_message_send']['Args'];
type DeleteArgs = Database['public']['Functions']['chat_message_delete']['Args'];
type SearchArgs = Database['public']['Functions']['chat_message_search']['Args'];
type SearchRow = Database['public']['Functions']['chat_message_search']['Returns'][number];

function ensureArgs(workspaceId: string, traceId: string = generateTraceId()): EnsureArgs {
  return { p_workspace_id: workspaceId, p_trace_id: traceId };
}

function sendArgs(channelId: string, body: string): SendArgs {
  return {
    p_id: crypto.randomUUID(),
    p_channel_id: channelId,
    p_trace_id: generateTraceId(),
    p_body: body,
  };
}

function deleteArgs(messageIds: string[], channelId: string): DeleteArgs {
  return { p_message_ids: messageIds, p_channel_id: channelId, p_trace_id: generateTraceId() };
}

/**
 * Build chat_message_search args. `query` null sends SQL null (p_query is
 * nullable in SQL; the generated Args type marks it a required string).
 */
function searchArgs(
  workspaceId: string,
  query: string | null,
  extra: { kind?: string; channelId?: string } = {},
): SearchArgs {
  const args: SearchArgs = {
    p_workspace_id: workspaceId,
    p_query: query as string,
    p_trace_id: generateTraceId(),
  };
  if (extra.kind !== undefined) args.p_kind = extra.kind;
  if (extra.channelId !== undefined) args.p_channel_id = extra.channelId;
  return args;
}

/** chat_message_search as `userId`; throws on an RPC error. */
async function search(userId: string, args: SearchArgs): Promise<SearchRow[]> {
  const res = await clientFor(userId).rpc('chat_message_search', args);
  if (res.error) throw new Error(`chat_message_search failed: ${res.error.message}`);
  return res.data ?? [];
}

/** ISO timestamp `minutes` before now (for the delete window). */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/** Seed one chat_messages row through the service role and return its id. */
async function seedMessage(
  admin: GenericClient,
  channelId: string,
  workspaceId: string,
  senderId: string,
  opts: { createdAt?: string; body?: string | null; attachmentMeta?: Json } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await insertRow(admin, 'chat_messages', {
    id,
    channel_id: channelId,
    workspace_id: workspaceId,
    sender_user_id: senderId,
    body: opts.body === undefined ? `seeded ${randomSuffix()}` : opts.body,
    attachment_meta: opts.attachmentMeta ?? null,
    agora_event_id: null,
    created_at: opts.createdAt ?? minutesAgo(1),
  });
  return id;
}

/** attachment_meta keyed by asset id, the shape the app persists. */
function metaFor(mime: string): Json {
  const assetId = crypto.randomUUID();
  return { [assetId]: { assetId, name: `f-${randomSuffix()}`, mime } };
}

describe.runIf(RLS_SUITE)('chat notes channel and search kind', () => {
  let admin: Client;
  let adminGeneric: GenericClient;
  // Workspace A: owner (notes owner), member (same workspace, DM partner),
  // spare (same workspace, used only for the shape-constraint control).
  let owner: SeededUser;
  let member: SeededUser;
  let spare: SeededUser;
  // Owner of an unrelated workspace: not a member of workspace A at all.
  let outsider: SeededUser;
  let wsA: SeededWorkspace;
  let wsOther: SeededWorkspace;
  let notesId: string;
  let dmChannelId: string;
  let ownerClient: GenericClient;
  let memberClient: GenericClient;
  let outsiderClient: GenericClient;

  async function ensureNotes(): Promise<string> {
    const res = await clientFor(owner.id).rpc('notes_channel_ensure', ensureArgs(wsA.id));
    if (res.error) throw new Error(`notes_channel_ensure failed: ${res.error.message}`);
    return res.data;
  }

  async function deletedAt(id: string): Promise<string | null> {
    const res = await adminGeneric.from('chat_messages').select('deleted_at').eq('id', id);
    if (res.error) throw new Error(`chat_messages read failed: ${res.error.message}`);
    const rows = (res.data as { deleted_at: string | null }[] | null) ?? [];
    if (rows.length !== 1) throw new Error(`expected one chat_messages row for ${id}`);
    return rows[0]?.deleted_at ?? null;
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    adminGeneric = asGeneric(admin);

    owner = await seedUser(env, admin);
    member = await seedUser(env, admin);
    spare = await seedUser(env, admin);
    outsider = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, owner, `Notes A ${owner.email}`);
    wsOther = await seedWorkspace(admin, outsider, `Notes O ${outsider.email}`);
    await seedMember(adminGeneric, wsA, member, 'agency');
    await seedMember(adminGeneric, wsA, spare, 'agency');

    notesId = `notes__${wsA.id}__${owner.id}`;
    dmChannelId = await seedDmChannel(adminGeneric, wsA.id, owner, member);

    ownerClient = asGeneric(clientFor(owner.id));
    memberClient = asGeneric(clientFor(member.id));
    outsiderClient = asGeneric(clientFor(outsider.id));
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA, wsOther], [owner, member, spare, outsider]);
  });

  it('T1: ensure returns the per-person id, is idempotent, and audits only the create', async () => {
    const firstTrace = generateTraceId();
    const first = await clientFor(owner.id).rpc(
      'notes_channel_ensure',
      ensureArgs(wsA.id, firstTrace),
    );
    expect(first.error).toBeNull();
    expect(first.data).toBe(notesId);

    const secondTrace = generateTraceId();
    const second = await clientFor(owner.id).rpc(
      'notes_channel_ensure',
      ensureArgs(wsA.id, secondTrace),
    );
    expect(second.error).toBeNull();
    expect(second.data).toBe(notesId);

    expect(await countWhere(adminGeneric, 'chat_channels', [['channel_id', notesId]])).toBe(1);
    const row = await adminGeneric
      .from('chat_channels')
      .select('channel_type, owner_user_id, entity_id, dm_user_a, dm_user_b')
      .eq('channel_id', notesId);
    expect(row.error).toBeNull();
    expect(row.data).toEqual([
      {
        channel_type: 'notes',
        owner_user_id: owner.id,
        entity_id: null,
        dm_user_a: null,
        dm_user_b: null,
      },
    ]);

    const audit: [string, string][] = [
      ['action', 'notes_channel_ensure'],
      ['entity_id', notesId],
    ];
    expect(await countWhere(adminGeneric, 'audit_log', audit)).toBe(1);
    expect(await countWhere(adminGeneric, 'audit_log', [['trace_id', firstTrace]])).toBe(1);
    expect(await countWhere(adminGeneric, 'audit_log', [['trace_id', secondTrace]])).toBe(0);
  });

  it('T2: a non-member of the workspace gets workspace_member_only', async () => {
    const res = await clientFor(outsider.id).rpc('notes_channel_ensure', ensureArgs(wsA.id));
    expect(res.error?.message).toBe('workspace_member_only');
    const theirs = `notes__${wsA.id}__${outsider.id}`;
    expect(await countWhere(adminGeneric, 'chat_channels', [['channel_id', theirs]])).toBe(0);
  });

  it('T3: the owner sends to notes and reads the channel row and the message', async () => {
    const channelId = await ensureNotes();
    const args = sendArgs(channelId, `note ${randomSuffix()}`);
    const sent = await clientFor(owner.id).rpc('chat_message_send', args);
    expect(sent.error).toBeNull();
    expect(await ownReadCount(ownerClient, 'chat_channels', [['channel_id', channelId]])).toBe(1);
    expect(await ownReadCount(ownerClient, 'chat_messages', [['id', args.p_id]])).toBe(1);
  });

  it('T4: another member of the same workspace sees, sends and finds nothing', async () => {
    const channelId = await ensureNotes();
    const body = `alpha secret ${randomSuffix()}`;
    const photo = await seedMessage(adminGeneric, channelId, wsA.id, owner.id, {
      body,
      attachmentMeta: metaFor('image/png'),
    });
    // Ground truth: the rows exist.
    expect(await countWhere(adminGeneric, 'chat_messages', [['id', photo]])).toBe(1);

    expect(await visibleRowCount(memberClient, 'chat_channels', [['channel_id', channelId]])).toBe(
      0,
    );
    expect(await visibleRowCount(memberClient, 'chat_messages', [['channel_id', channelId]])).toBe(
      0,
    );

    const sent = await clientFor(member.id).rpc('chat_message_send', sendArgs(channelId, 'hi'));
    expect(sent.error?.message).toBe('not a member of this chat');

    const queries: SearchArgs[] = [
      searchArgs(wsA.id, 'alpha'),
      searchArgs(wsA.id, 'secret'),
      searchArgs(wsA.id, '', { kind: 'photo' }),
      searchArgs(wsA.id, 'alpha', { kind: 'photo' }),
      searchArgs(wsA.id, '', { kind: 'photo', channelId }),
    ];
    for (const q of queries) {
      const rows = await search(member.id, q);
      expect(rows.filter((r) => r.channel_id === channelId)).toHaveLength(0);
    }
    // Control: the owner finds the same message with the same query.
    const own = await search(owner.id, searchArgs(wsA.id, '', { kind: 'photo', channelId }));
    expect(own.map((r) => r.id)).toContain(photo);
  });

  it('T5: a user from another workspace gets nothing', async () => {
    const channelId = await ensureNotes();
    const id = await seedMessage(adminGeneric, channelId, wsA.id, owner.id, {
      body: `alpha outsider ${randomSuffix()}`,
      attachmentMeta: metaFor('image/jpeg'),
    });
    expect(await countWhere(adminGeneric, 'chat_messages', [['id', id]])).toBe(1);

    expect(
      await visibleRowCount(outsiderClient, 'chat_channels', [['channel_id', channelId]]),
    ).toBe(0);
    expect(
      await visibleRowCount(outsiderClient, 'chat_messages', [['channel_id', channelId]]),
    ).toBe(0);
    const sent = await clientFor(outsider.id).rpc('chat_message_send', sendArgs(channelId, 'x'));
    expect(sent.error?.message).toBe('not a member of this chat');

    expect(await search(outsider.id, searchArgs(wsA.id, 'alpha'))).toHaveLength(0);
    expect(await search(outsider.id, searchArgs(wsA.id, '', { kind: 'photo' }))).toHaveLength(0);
    expect(
      await search(outsider.id, searchArgs(wsA.id, '', { kind: 'photo', channelId })),
    ).toHaveLength(0);
  });

  it('T6: notes messages delete with no window; DM keeps 30 minutes', async () => {
    const channelId = await ensureNotes();
    const oldNote = await seedMessage(adminGeneric, channelId, wsA.id, owner.id, {
      createdAt: minutesAgo(31),
    });
    const res = await clientFor(owner.id).rpc(
      'chat_message_delete',
      deleteArgs([oldNote], channelId),
    );
    expect(res.error).toBeNull();
    expect(await deletedAt(oldNote)).not.toBeNull();

    const oldDm = await seedMessage(adminGeneric, dmChannelId, wsA.id, owner.id, {
      createdAt: minutesAgo(31),
    });
    const dm = await clientFor(owner.id).rpc(
      'chat_message_delete',
      deleteArgs([oldDm], dmChannelId),
    );
    expect(dm.error?.message).toBe(
      'only your own messages from the last 30 minutes can be deleted',
    );
    expect(await deletedAt(oldDm)).toBeNull();
  });

  describe('search p_kind', () => {
    // One alpha and one beta message per kind, plus a plain alpha message with
    // no attachment and no link, all in the owner's notes channel.
    const ids: Record<'photo' | 'voice' | 'file' | 'link', { alpha: string; beta: string }> = {
      photo: { alpha: '', beta: '' },
      voice: { alpha: '', beta: '' },
      file: { alpha: '', beta: '' },
      link: { alpha: '', beta: '' },
    };
    let plain = '';
    const seeded = new Set<string>();
    let channelId = '';
    const kinds = ['photo', 'voice', 'file', 'link'] as const;

    beforeAll(async () => {
      channelId = await ensureNotes();
      const mimes = { photo: 'image/png', voice: 'audio/webm', file: 'application/pdf' } as const;
      for (const word of ['alpha', 'beta'] as const) {
        for (const kind of ['photo', 'voice', 'file'] as const) {
          ids[kind][word] = await seedMessage(adminGeneric, channelId, wsA.id, owner.id, {
            body: `${word} ${kind} kindcase`,
            attachmentMeta: metaFor(mimes[kind]),
          });
        }
        ids.link[word] = await seedMessage(adminGeneric, channelId, wsA.id, owner.id, {
          body: `${word} link kindcase https://${word}.example.test/page`,
        });
      }
      plain = await seedMessage(adminGeneric, channelId, wsA.id, owner.id, {
        body: 'alpha plain kindcase',
      });
      for (const kind of kinds) {
        seeded.add(ids[kind].alpha);
        seeded.add(ids[kind].beta);
      }
      seeded.add(plain);
    });

    it('T7: each kind returns only matching messages; a query narrows', async () => {
      for (const kind of kinds) {
        // Restricted to this block's fixtures: earlier tests also seed photos in this channel.
        const all = await search(owner.id, searchArgs(wsA.id, '', { kind, channelId }));
        const found = all.map((r) => r.id).filter((id) => seeded.has(id));
        expect(new Set(found)).toEqual(new Set([ids[kind].alpha, ids[kind].beta]));

        const narrowed = await search(owner.id, searchArgs(wsA.id, 'alpha', { kind, channelId }));
        expect(narrowed.map((r) => r.id)).toEqual([ids[kind].alpha]);
      }
      // Control: the query alone matches every alpha message, so the kind filter did the work.
      const byQuery = await search(owner.id, searchArgs(wsA.id, 'alpha kindcase', { channelId }));
      expect(new Set(byQuery.map((r) => r.id))).toEqual(
        new Set([...kinds.map((k) => ids[k].alpha), plain]),
      );
    });

    it('T8: unknown kind and no query with no kind return zero rows', async () => {
      expect(
        await search(owner.id, searchArgs(wsA.id, '', { kind: 'banana', channelId })),
      ).toHaveLength(0);
      expect(
        await search(owner.id, searchArgs(wsA.id, 'alpha', { kind: 'banana', channelId })),
      ).toHaveLength(0);
      expect(await search(owner.id, searchArgs(wsA.id, null, { channelId }))).toHaveLength(0);
      expect(await search(owner.id, searchArgs(wsA.id, '', { channelId }))).toHaveLength(0);
    });
  });

  it('T9: authenticated cannot INSERT into chat_channels directly', async () => {
    const channelId = `notes__${wsOther.id}__${outsider.id}`;
    const res = await authInsert(outsiderClient, 'chat_channels', {
      channel_id: channelId,
      workspace_id: wsOther.id,
      channel_type: 'notes',
      owner_user_id: outsider.id,
    });
    expect(res.ok && res.count > 0).toBe(false);
    expect(await countWhere(adminGeneric, 'chat_channels', [['channel_id', channelId]])).toBe(0);
  });

  it('T10: chat_channels_shape rejects a notes row without an owner or with a mismatched id', async () => {
    const insert = (values: Record<string, unknown>) =>
      adminGeneric.from('chat_channels').insert(values);

    const noOwner = await insert({
      channel_id: `notes__${wsA.id}__${spare.id}`,
      workspace_id: wsA.id,
      channel_type: 'notes',
      owner_user_id: null,
    });
    expect(noOwner.error?.message).toContain('chat_channels_shape');

    const mismatched = await insert({
      channel_id: `notes__${wsA.id}__${spare.id}`,
      workspace_id: wsA.id,
      channel_type: 'notes',
      owner_user_id: member.id,
    });
    expect(mismatched.error?.message).toContain('chat_channels_shape');

    const otherWorkspace = await insert({
      channel_id: `notes__${wsOther.id}__${spare.id}`,
      workspace_id: wsA.id,
      channel_type: 'notes',
      owner_user_id: spare.id,
    });
    expect(otherWorkspace.error?.message).toContain('chat_channels_shape');

    expect(
      await countWhere(adminGeneric, 'chat_channels', [
        ['workspace_id', wsA.id],
        ['channel_type', 'notes'],
        ['owner_user_id', spare.id],
      ]),
    ).toBe(0);

    // Control: the well-formed row is accepted, so the rejections above are the shape check.
    const ok = await insert({
      channel_id: `notes__${wsA.id}__${spare.id}`,
      workspace_id: wsA.id,
      channel_type: 'notes',
      owner_user_id: spare.id,
    });
    expect(ok.error).toBeNull();
  });
});
