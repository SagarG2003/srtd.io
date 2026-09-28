// Chat marks: resolve any type, reopen, hidden by clear
// (20260928090548_chat_marks_resolve_all_reopen.sql):
//
//   a. A member who cleared a channel cannot SELECT marks set at or before their
//      cleared_at, and can SELECT marks set after it.
//   b. A non-member cannot SELECT the channel's marks.
//   c. chat_mark_reopen by a non-member raises.
//   d. chat_mark_resolve on a commitment succeeds (the pending-only CHECK is
//      gone), and chat_mark_reopen by a member returns it to open.
//
// Seeding goes through the service role (the privileged path), following the
// rationale in packages/test-utils/rls.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  generateTraceId,
  insertRow,
  loadRlsEnv,
  partitionTimestamp,
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
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

type Client = SupabaseClient<Database>;
type MarkArgs = Database['public']['Functions']['chat_mark_reopen']['Args'];
type ClearArgs = Database['public']['Functions']['chat_channel_clear']['Args'];

// chat_mark_resolve and chat_mark_reopen share one argument shape; each call
// carries a fresh trace id the way the app's record layer does.
function markArgs(messageId: string, channelId: string): MarkArgs {
  return { p_message_id: messageId, p_channel_id: channelId, p_trace_id: generateTraceId() };
}

function clearArgs(channelId: string): ClearArgs {
  return { p_channel_id: channelId, p_trace_id: generateTraceId() };
}

interface MarkRow {
  resolved_by: string | null;
  resolved_at: string | null;
}

describe.runIf(RLS_SUITE)('chat marks: resolve any type, reopen, hidden by clear', () => {
  let admin: Client;
  let adminGeneric: GenericClient;
  // A DM between owner and member; outsider is an active workspace member who
  // is not a participant.
  let owner: SeededUser;
  let member: SeededUser;
  let outsider: SeededUser;
  let ws: SeededWorkspace;
  let dmChannelId: string;

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    adminGeneric = asGeneric(admin);
    owner = await seedUser(env, admin);
    member = await seedUser(env, admin);
    outsider = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Marks ${owner.email}`);
    await seedMember(adminGeneric, ws, member, 'agency');
    await seedMember(adminGeneric, ws, outsider, 'client');
    dmChannelId = await seedDmChannel(adminGeneric, ws.id, owner, member);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [ws], [owner, member, outsider]);
  });

  /** Seed one DM message and a mark on it (optionally at a given marked_at). */
  async function seedMark(
    markType: 'commitment' | 'decision' | 'pending',
    markedAt?: string,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await insertRow(adminGeneric, 'chat_messages', {
      id,
      channel_id: dmChannelId,
      workspace_id: ws.id,
      sender_user_id: owner.id,
      body: `mark ${randomSuffix()}`,
      agora_event_id: null,
      created_at: partitionTimestamp,
    });
    await insertRow(adminGeneric, 'chat_message_marks', {
      message_id: id,
      channel_id: dmChannelId,
      workspace_id: ws.id,
      mark_type: markType,
      marked_by: owner.id,
      ...(markedAt !== undefined ? { marked_at: markedAt } : {}),
    });
    return id;
  }

  async function markRow(messageId: string): Promise<MarkRow | undefined> {
    const res = await adminGeneric
      .from('chat_message_marks')
      .select('resolved_by, resolved_at')
      .eq('message_id', messageId);
    if (res.error) throw new Error(`chat_message_marks read failed: ${res.error.message}`);
    return ((res.data as MarkRow[] | null) ?? [])[0];
  }

  it('chat_mark_resolve on a commitment succeeds; chat_mark_reopen returns it to open', async () => {
    const id = await seedMark('commitment');
    const resolve = await clientFor(member.id).rpc('chat_mark_resolve', markArgs(id, dmChannelId));
    expect(resolve.error).toBeNull();
    const stamped = await markRow(id);
    expect(stamped?.resolved_by).toBe(member.id);
    expect(stamped?.resolved_at).not.toBeNull();

    const reopen = await clientFor(owner.id).rpc('chat_mark_reopen', markArgs(id, dmChannelId));
    expect(reopen.error).toBeNull();
    expect(await markRow(id)).toEqual({ resolved_by: null, resolved_at: null });

    const again = await clientFor(owner.id).rpc('chat_mark_reopen', markArgs(id, dmChannelId));
    expect(again.error?.message).toBe('no resolved mark on this message');
  });

  it('chat_mark_reopen by a non-member raises and leaves the mark resolved', async () => {
    const id = await seedMark('decision');
    const resolve = await clientFor(owner.id).rpc('chat_mark_resolve', markArgs(id, dmChannelId));
    expect(resolve.error).toBeNull();
    const res = await clientFor(outsider.id).rpc('chat_mark_reopen', markArgs(id, dmChannelId));
    expect(res.error?.message).toBe('not a member of this chat');
    expect((await markRow(id))?.resolved_at).not.toBeNull();
  });

  it('a non-member cannot SELECT the channel marks', async () => {
    const id = await seedMark('pending');
    const client = asGeneric(clientFor(outsider.id));
    expect(await visibleRowCount(client, 'chat_message_marks', [['message_id', id]])).toBe(0);
    expect(await visibleRowCount(client, 'chat_message_marks', [['channel_id', dmChannelId]])).toBe(
      0,
    );
  });

  it('a member who cleared the channel sees only marks set after cleared_at', async () => {
    const before = await seedMark('commitment');
    const clear = await clientFor(member.id).rpc('chat_channel_clear', clearArgs(dmChannelId));
    expect(clear.error).toBeNull();
    const cleared = await adminGeneric
      .from('chat_channel_clears')
      .select('cleared_at')
      .eq('channel_id', dmChannelId)
      .eq('user_id', member.id);
    expect(cleared.error).toBeNull();
    const clearedAt = ((cleared.data as { cleared_at: string }[] | null) ?? [])[0]?.cleared_at;
    expect(clearedAt).toBeDefined();
    const after = await seedMark(
      'decision',
      new Date(Date.parse(clearedAt ?? '') + 60_000).toISOString(),
    );

    const memberClient = asGeneric(clientFor(member.id));
    expect(
      await visibleRowCount(memberClient, 'chat_message_marks', [['message_id', before]]),
    ).toBe(0);
    expect(await visibleRowCount(memberClient, 'chat_message_marks', [['message_id', after]])).toBe(
      1,
    );

    // The other participant did not clear and still sees both.
    const ownerClient = asGeneric(clientFor(owner.id));
    expect(await visibleRowCount(ownerClient, 'chat_message_marks', [['message_id', before]])).toBe(
      1,
    );
    expect(await visibleRowCount(ownerClient, 'chat_message_marks', [['message_id', after]])).toBe(
      1,
    );
  });
});
