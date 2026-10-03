// Chat message stars (20261004050000_chat_message_stars.sql):
//
//   T1. A member stars a visible message and reads the row back; a second
//       identical call adds no row and no second audit_log row.
//   T2. Another member of the same chat reads none of the first user's rows
//       and their chat_message_starred_list returns none of them.
//   T3. A non-member gets 'not a member of this chat' and reads 0 rows.
//   T4. Starring a deleted message raises 'message not found'; deleting a
//       starred message (chat_message_delete) removes its star (trigger).
//   T5. After chat_channel_clear the starred list no longer returns a pre-clear
//       star, and starring a pre-clear message raises 'message not found'.
//   T6. Multi-select: 3 ids -> 3 rows and 1 audit row (count 3); unstar 2 ->
//       1 left and a chat_message_unstar audit row; 0 ids, 101 ids, null
//       p_trace_id and null p_starred are refused.
//   T7. chat_message_starred_list: newest first, p_channel_id filter, prefix
//       p_query, a 1-char query returns 0, keyset paging has no overlap, and
//       stars from another workspace never appear.
//   T8. authenticated cannot INSERT, UPDATE or DELETE chat_message_stars
//       directly; anon reads nothing and cannot execute either function.
//   T9. The owner can star a message in their notes channel; another member
//       cannot.
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
  createAnonClient,
  deleteRowCount,
  insertRow,
  loadRlsEnv,
  ownReadCount,
  randomSuffix,
  seedDmChannel,
  seedMember,
  seedUser,
  seedWorkspace,
  updateRowCount,
  visibleRowCount,
  type GenericClient,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

type Client = SupabaseClient<Database>;
type StarArgs = Database['public']['Functions']['chat_message_star_set']['Args'];
type ListArgs = Database['public']['Functions']['chat_message_starred_list']['Args'];
type ListRow = Database['public']['Functions']['chat_message_starred_list']['Returns'][number];
type DeleteArgs = Database['public']['Functions']['chat_message_delete']['Args'];
type ClearArgs = Database['public']['Functions']['chat_channel_clear']['Args'];
type EnsureArgs = Database['public']['Functions']['notes_channel_ensure']['Args'];

/** A fresh uuid_v7 trace id (48-bit ms timestamp, version 7, RFC 4122 variant). */
function traceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let ms = Date.now();
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function starArgs(
  messageIds: string[],
  channelId: string,
  starred: boolean,
  trace: string = traceId(),
): StarArgs {
  return {
    p_message_ids: messageIds,
    p_channel_id: channelId,
    p_starred: starred,
    p_trace_id: trace,
  };
}

function listArgs(
  workspaceId: string,
  extra: {
    channelId?: string;
    query?: string;
    beforeCreatedAt?: string;
    beforeId?: string;
    limit?: number;
  } = {},
): ListArgs {
  const args: ListArgs = { p_workspace_id: workspaceId, p_trace_id: traceId() };
  if (extra.channelId !== undefined) args.p_channel_id = extra.channelId;
  if (extra.query !== undefined) args.p_query = extra.query;
  if (extra.beforeCreatedAt !== undefined) args.p_before_created_at = extra.beforeCreatedAt;
  if (extra.beforeId !== undefined) args.p_before_id = extra.beforeId;
  if (extra.limit !== undefined) args.p_limit = extra.limit;
  return args;
}

function deleteArgs(messageIds: string[], channelId: string): DeleteArgs {
  return { p_message_ids: messageIds, p_channel_id: channelId, p_trace_id: traceId() };
}

/** chat_message_star_set as `userId`; returns the error message or null. */
async function star(userId: string, args: StarArgs): Promise<string | null> {
  const res = await clientFor(userId).rpc('chat_message_star_set', args);
  return res.error?.message ?? null;
}

/** chat_message_starred_list as `userId`; throws on an RPC error. */
async function list(userId: string, args: ListArgs): Promise<ListRow[]> {
  const res = await clientFor(userId).rpc('chat_message_starred_list', args);
  if (res.error) throw new Error(`chat_message_starred_list failed: ${res.error.message}`);
  return res.data ?? [];
}

interface AuditRow {
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  payload: unknown;
}

/** ISO timestamp `minutes` before now. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe.runIf(RLS_SUITE)('chat message stars: own rows, proc gates and starred list', () => {
  let admin: Client;
  let adminGeneric: GenericClient;
  // Workspace A: alice (owner, does the starring), bob (shares dm with alice),
  // carol (shares a second DM with alice; not in alice-bob), dave (shares a
  // third DM with alice, cleared in T5). Workspace B: olga (owner); alice is
  // also a member there and shares a DM with olga.
  let alice: SeededUser;
  let bob: SeededUser;
  let carol: SeededUser;
  let dave: SeededUser;
  let olga: SeededUser;
  let wsA: SeededWorkspace;
  let wsB: SeededWorkspace;
  let dmBob: string;
  let dmCarol: string;
  let dmDave: string;
  let dmOlga: string;
  let aliceClient: GenericClient;
  let bobClient: GenericClient;
  let carolClient: GenericClient;

  /** Seed one live chat_messages row through the service role and return its id. */
  async function seedMessage(
    channelId: string,
    workspaceId: string,
    sender: SeededUser,
    opts: { createdAt?: string; body?: string } = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    await insertRow(adminGeneric, 'chat_messages', {
      id,
      channel_id: channelId,
      workspace_id: workspaceId,
      sender_user_id: sender.id,
      body: opts.body ?? `star ${randomSuffix()}`,
      agora_event_id: null,
      created_at: opts.createdAt ?? minutesAgo(1),
    });
    return id;
  }

  async function starCount(userId: string, messageId: string): Promise<number> {
    return countWhere(adminGeneric, 'chat_message_stars', [
      ['user_id', userId],
      ['message_id', messageId],
    ]);
  }

  async function auditRows(trace: string): Promise<AuditRow[]> {
    const res = await adminGeneric
      .from('audit_log')
      .select('action, entity_type, entity_id, payload')
      .eq('trace_id', trace);
    if (res.error) throw new Error(`audit_log read failed: ${res.error.message}`);
    return (res.data as AuditRow[] | null) ?? [];
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    adminGeneric = asGeneric(admin);

    alice = await seedUser(env, admin);
    bob = await seedUser(env, admin);
    carol = await seedUser(env, admin);
    dave = await seedUser(env, admin);
    olga = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, alice, `Stars A ${alice.email}`);
    wsB = await seedWorkspace(admin, olga, `Stars B ${olga.email}`);
    await seedMember(adminGeneric, wsA, bob, 'agency');
    await seedMember(adminGeneric, wsA, carol, 'agency');
    await seedMember(adminGeneric, wsA, dave, 'agency');
    await seedMember(adminGeneric, wsB, alice, 'agency');

    dmBob = await seedDmChannel(adminGeneric, wsA.id, alice, bob);
    dmCarol = await seedDmChannel(adminGeneric, wsA.id, alice, carol);
    dmDave = await seedDmChannel(adminGeneric, wsA.id, alice, dave);
    dmOlga = await seedDmChannel(adminGeneric, wsB.id, alice, olga);

    aliceClient = asGeneric(clientFor(alice.id));
    bobClient = asGeneric(clientFor(bob.id));
    carolClient = asGeneric(clientFor(carol.id));
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA, wsB], [alice, bob, carol, dave, olga]);
  });

  it('T1: a member stars a visible message; a repeat call is a no-op', async () => {
    const msg = await seedMessage(dmBob, wsA.id, bob);
    const firstTrace = traceId();
    expect(await star(alice.id, starArgs([msg], dmBob, true, firstTrace))).toBeNull();
    expect(
      await ownReadCount(aliceClient, 'chat_message_stars', [
        ['user_id', alice.id],
        ['message_id', msg],
      ]),
    ).toBe(1);

    const secondTrace = traceId();
    expect(await star(alice.id, starArgs([msg], dmBob, true, secondTrace))).toBeNull();
    expect(await starCount(alice.id, msg)).toBe(1);

    const first = await auditRows(firstTrace);
    expect(first).toEqual([
      {
        action: 'chat_message_star',
        entity_type: 'chat_channel',
        entity_id: dmBob,
        payload: { count: 1 },
      },
    ]);
    expect(await auditRows(secondTrace)).toHaveLength(0);
  });

  it('T2: another member of the same chat sees none of the stars', async () => {
    const msg = await seedMessage(dmBob, wsA.id, alice);
    expect(await star(alice.id, starArgs([msg], dmBob, true))).toBeNull();
    // Ground truth: the row exists.
    expect(await starCount(alice.id, msg)).toBe(1);

    expect(await visibleRowCount(bobClient, 'chat_message_stars', [['user_id', alice.id]])).toBe(0);
    expect(await visibleRowCount(bobClient, 'chat_message_stars', [['message_id', msg]])).toBe(0);
    const bobList = await list(bob.id, listArgs(wsA.id));
    expect(bobList.map((r) => r.id)).not.toContain(msg);
    expect(await list(bob.id, listArgs(wsA.id, { channelId: dmBob }))).toHaveLength(0);

    // Control: bob reads the message itself, and alice's list has it.
    expect(await ownReadCount(bobClient, 'chat_messages', [['id', msg]])).toBe(1);
    const aliceList = await list(alice.id, listArgs(wsA.id, { channelId: dmBob }));
    expect(aliceList.map((r) => r.id)).toContain(msg);
  });

  it('T3: a non-member is refused and reads nothing', async () => {
    const msg = await seedMessage(dmBob, wsA.id, bob);
    expect(await star(carol.id, starArgs([msg], dmBob, true))).toBe('not a member of this chat');
    expect(await starCount(carol.id, msg)).toBe(0);
    expect(await visibleRowCount(carolClient, 'chat_message_stars', [['channel_id', dmBob]])).toBe(
      0,
    );
    expect(await star(olga.id, starArgs([msg], dmBob, true))).toBe('not a member of this chat');
  });

  it('T4: deleted messages cannot be starred; deleting removes the star', async () => {
    const gone = await seedMessage(dmBob, wsA.id, alice);
    const del = await clientFor(alice.id).rpc('chat_message_delete', deleteArgs([gone], dmBob));
    expect(del.error).toBeNull();
    expect(await star(alice.id, starArgs([gone], dmBob, true))).toBe('message not found');
    expect(await starCount(alice.id, gone)).toBe(0);

    const msg = await seedMessage(dmBob, wsA.id, alice);
    expect(await star(alice.id, starArgs([msg], dmBob, true))).toBeNull();
    expect(await starCount(alice.id, msg)).toBe(1);
    const res = await clientFor(alice.id).rpc('chat_message_delete', deleteArgs([msg], dmBob));
    expect(res.error).toBeNull();
    expect(await starCount(alice.id, msg)).toBe(0);
  });

  it('T5: a cleared chat hides its stars and refuses pre-clear messages', async () => {
    const starred = await seedMessage(dmDave, wsA.id, dave, { createdAt: minutesAgo(2) });
    const unstarred = await seedMessage(dmDave, wsA.id, dave, { createdAt: minutesAgo(2) });
    expect(await star(alice.id, starArgs([starred], dmDave, true))).toBeNull();
    const before = await list(alice.id, listArgs(wsA.id, { channelId: dmDave }));
    expect(before.map((r) => r.id)).toEqual([starred]);

    const clearArgs: ClearArgs = { p_channel_id: dmDave, p_trace_id: traceId() };
    const cleared = await clientFor(alice.id).rpc('chat_channel_clear', clearArgs);
    expect(cleared.error).toBeNull();

    expect(await list(alice.id, listArgs(wsA.id, { channelId: dmDave }))).toHaveLength(0);
    expect((await list(alice.id, listArgs(wsA.id))).map((r) => r.id)).not.toContain(starred);
    expect(await star(alice.id, starArgs([unstarred], dmDave, true))).toBe('message not found');
    expect(await starCount(alice.id, unstarred)).toBe(0);

    // Control: dave did not clear, so dave can still star the same message.
    expect(await star(dave.id, starArgs([unstarred], dmDave, true))).toBeNull();
  });

  it('T6: multi-select stars and unstars in one call; bad input is refused', async () => {
    const ids = [
      await seedMessage(dmBob, wsA.id, bob),
      await seedMessage(dmBob, wsA.id, bob),
      await seedMessage(dmBob, wsA.id, alice),
    ];
    const starTrace = traceId();
    expect(await star(alice.id, starArgs(ids, dmBob, true, starTrace))).toBeNull();
    for (const id of ids) expect(await starCount(alice.id, id)).toBe(1);
    const starAudit = await auditRows(starTrace);
    expect(starAudit).toHaveLength(1);
    expect(starAudit[0]?.action).toBe('chat_message_star');
    expect(starAudit[0]?.payload).toEqual({ count: 3 });

    const unstarTrace = traceId();
    expect(await star(alice.id, starArgs(ids.slice(0, 2), dmBob, false, unstarTrace))).toBeNull();
    expect(await starCount(alice.id, ids[0] ?? '')).toBe(0);
    expect(await starCount(alice.id, ids[1] ?? '')).toBe(0);
    expect(await starCount(alice.id, ids[2] ?? '')).toBe(1);
    const unstarAudit = await auditRows(unstarTrace);
    expect(unstarAudit).toHaveLength(1);
    expect(unstarAudit[0]?.action).toBe('chat_message_unstar');
    expect(unstarAudit[0]?.payload).toEqual({ count: 2 });

    expect(await star(alice.id, starArgs([], dmBob, true))).toBe(
      'select between 1 and 100 messages',
    );
    const tooMany = Array.from({ length: 101 }, () => crypto.randomUUID());
    expect(await star(alice.id, starArgs(tooMany, dmBob, true))).toBe(
      'select between 1 and 100 messages',
    );

    // Nulls are sent as SQL null; the generated Args types mark them required.
    const noTrace: StarArgs = {
      ...starArgs([ids[2] ?? ''], dmBob, false),
      p_trace_id: null as unknown as string,
    };
    expect(await star(alice.id, noTrace)).toBe('trace id required');
    const noFlag: StarArgs = {
      ...starArgs([ids[2] ?? ''], dmBob, false),
      p_starred: null as unknown as boolean,
    };
    expect(await star(alice.id, noFlag)).toBe('starred flag required');
    // The refused calls changed nothing.
    expect(await starCount(alice.id, ids[2] ?? '')).toBe(1);
  });

  it('T7: starred list order, filters, prefix search, keyset paging and workspace scope', async () => {
    // m2 and m3 share created_at so the page boundary exercises the id tiebreak.
    const tie = minutesAgo(9);
    const m1 = await seedMessage(dmCarol, wsA.id, carol, {
      createdAt: minutesAgo(10),
      body: 'kiwifruit alpha',
    });
    const m2 = await seedMessage(dmCarol, wsA.id, carol, { createdAt: tie, body: 'mango beta' });
    const m3 = await seedMessage(dmCarol, wsA.id, alice, { createdAt: tie, body: 'mango gamma' });
    const m4 = await seedMessage(dmCarol, wsA.id, carol, {
      createdAt: minutesAgo(8),
      body: 'kiwifruit delta',
    });
    expect(await star(alice.id, starArgs([m1, m2, m3, m4], dmCarol, true))).toBeNull();

    const [tieHi, tieLo] = m2 > m3 ? [m2, m3] : [m3, m2];
    const all = await list(alice.id, listArgs(wsA.id, { channelId: dmCarol }));
    expect(all.map((r) => r.id)).toEqual([m4, tieHi, tieLo, m1]);

    // Without the channel filter, stars in other channels appear too.
    const elsewhere = await seedMessage(dmBob, wsA.id, bob, { body: 'kiwifruit elsewhere' });
    expect(await star(alice.id, starArgs([elsewhere], dmBob, true))).toBeNull();
    const unfiltered = (await list(alice.id, listArgs(wsA.id))).map((r) => r.id);
    expect(unfiltered).toEqual(expect.arrayContaining([m1, m2, m3, m4, elsewhere]));
    const filtered = (await list(alice.id, listArgs(wsA.id, { channelId: dmCarol }))).map(
      (r) => r.id,
    );
    expect(filtered).not.toContain(elsewhere);

    expect(
      (await list(alice.id, listArgs(wsA.id, { channelId: dmCarol, query: 'kiw' }))).map(
        (r) => r.id,
      ),
    ).toEqual([m4, m1]);
    expect(
      (await list(alice.id, listArgs(wsA.id, { channelId: dmCarol, query: 'man gam' }))).map(
        (r) => r.id,
      ),
    ).toEqual([m3]);
    expect(await list(alice.id, listArgs(wsA.id, { channelId: dmCarol, query: 'k' }))).toHaveLength(
      0,
    );

    const page1 = await list(alice.id, listArgs(wsA.id, { channelId: dmCarol, limit: 2 }));
    expect(page1.map((r) => r.id)).toEqual([m4, tieHi]);
    const last = page1[page1.length - 1];
    if (!last) throw new Error('page 1 is empty');
    const page2 = await list(
      alice.id,
      listArgs(wsA.id, {
        channelId: dmCarol,
        limit: 2,
        beforeCreatedAt: last.created_at,
        beforeId: last.id,
      }),
    );
    expect(page2.map((r) => r.id)).toEqual([tieLo, m1]);
    const overlap = page2.filter((r) => page1.some((p) => p.id === r.id));
    expect(overlap).toHaveLength(0);

    // Another workspace: alice stars in wsB; it never shows in wsA, only in wsB.
    const foreign = await seedMessage(dmOlga, wsB.id, olga, { body: 'kiwifruit foreign' });
    expect(await star(alice.id, starArgs([foreign], dmOlga, true))).toBeNull();
    expect((await list(alice.id, listArgs(wsA.id))).map((r) => r.id)).not.toContain(foreign);
    expect(
      (await list(alice.id, listArgs(wsA.id, { query: 'kiwifruit' }))).map((r) => r.id),
    ).not.toContain(foreign);
    expect(await list(alice.id, listArgs(wsA.id, { channelId: dmOlga }))).toHaveLength(0);
    expect((await list(alice.id, listArgs(wsB.id))).map((r) => r.id)).toEqual([foreign]);
  });

  it('T8: no direct writes for authenticated; anon gets nothing', async () => {
    const msg = await seedMessage(dmBob, wsA.id, bob);
    expect(await star(alice.id, starArgs([msg], dmBob, true))).toBeNull();
    const match: [string, string][] = [
      ['user_id', alice.id],
      ['message_id', msg],
    ];

    const other = await seedMessage(dmBob, wsA.id, bob);
    const ins = await authInsert(aliceClient, 'chat_message_stars', {
      user_id: alice.id,
      message_id: other,
      message_created_at: minutesAgo(1),
      channel_id: dmBob,
      workspace_id: wsA.id,
    });
    expect(ins.ok && ins.count > 0).toBe(false);
    expect(await starCount(alice.id, other)).toBe(0);

    expect(
      await updateRowCount(aliceClient, 'chat_message_stars', match, {
        starred_at: minutesAgo(60),
      }),
    ).toBe(0);
    expect(await deleteRowCount(aliceClient, 'chat_message_stars', match)).toBe(0);
    expect(await countWhere(adminGeneric, 'chat_message_stars', match)).toBe(1);

    const env = loadRlsEnv();
    const anon: Client = createAnonClient(env);
    expect(await visibleRowCount(asGeneric(anon), 'chat_message_stars', match)).toBe(0);
    const anonSet = await anon.rpc('chat_message_star_set', starArgs([msg], dmBob, false));
    expect(anonSet.error).not.toBeNull();
    expect(await starCount(alice.id, msg)).toBe(1);
    const anonList = await anon.rpc('chat_message_starred_list', listArgs(wsA.id));
    expect(anonList.error).not.toBeNull();
  });

  it('T9: the owner can star in their notes channel; another member cannot', async () => {
    const ensureArgs: EnsureArgs = { p_workspace_id: wsA.id, p_trace_id: traceId() };
    const ensured = await clientFor(alice.id).rpc('notes_channel_ensure', ensureArgs);
    expect(ensured.error).toBeNull();
    const notesId = ensured.data;
    if (!notesId) throw new Error('notes_channel_ensure returned no id');

    const msg = await seedMessage(notesId, wsA.id, alice);
    expect(await star(alice.id, starArgs([msg], notesId, true))).toBeNull();
    expect(await starCount(alice.id, msg)).toBe(1);
    const own = await list(alice.id, listArgs(wsA.id, { channelId: notesId }));
    expect(own.map((r) => r.id)).toEqual([msg]);

    expect(await star(bob.id, starArgs([msg], notesId, true))).toBe('not a member of this chat');
    expect(await starCount(bob.id, msg)).toBe(0);
  });
});
