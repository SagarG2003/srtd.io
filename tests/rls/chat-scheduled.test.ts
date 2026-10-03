// Chat scheduled send (20261003130000_chat_scheduled_send.sql):
//
//   T1. The owner reads their own chat_scheduled_messages rows.
//   T2. Another member of the same workspace (the DM partner) reads none of them.
//   T3. A user from another workspace reads none.
//   T4. authenticated cannot INSERT / UPDATE / DELETE the table directly.
//   T5. chat_message_schedule works for a channel the caller belongs to and is
//       refused for one they do not.
//   T6. send_at outside [now() + 1 minute, now() + 365 days] is refused.
//   T7. chat_scheduled_update / cancel / send_now by a non-owner are refused.
//   T8. authenticated cannot EXECUTE chat_scheduled_due, chat_scheduled_dispatch,
//       chat_scheduled_outcome_entry, chat_scheduled_clear_failed.
//
// Rows are seeded through chat_message_schedule as the owner: service_role has
// no CRUD grant on chat_scheduled_messages (only the SECURITY DEFINER procs
// write it), so the privileged-insert path used by other suites is not
// available here. Ground truth for "unchanged" reads goes through psql as the
// container superuser.

import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  authInsert,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  deleteRowCount,
  generateTraceId,
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
type ScheduleArgs = Database['public']['Functions']['chat_message_schedule']['Args'];
type UpdateArgs = Database['public']['Functions']['chat_scheduled_update']['Args'];
type IdTraceArgs = Database['public']['Functions']['chat_scheduled_cancel']['Args'];
type ScheduledRow = Database['public']['Tables']['chat_scheduled_messages']['Row'];

const TABLE = 'chat_scheduled_messages';
const WINDOW_ERROR = 'send time must be between 1 minute and 1 year from now';
const NOT_FOUND = 'scheduled message not found';

/** An ISO timestamp `ms` milliseconds from now. */
function fromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function scheduleArgs(channelId: string, sendAt: string): ScheduleArgs {
  return {
    p_id: crypto.randomUUID(),
    p_channel_id: channelId,
    p_send_at: sendAt,
    p_trace_id: generateTraceId(),
    p_body: `scheduled ${randomSuffix()}`,
  };
}

function updateArgs(id: string, sendAt: string, body: string): UpdateArgs {
  return {
    p_id: id,
    p_send_at: sendAt,
    p_body: body,
    p_mentions: null,
    p_trace_id: generateTraceId(),
  };
}

function idTraceArgs(id: string): IdTraceArgs {
  return { p_id: id, p_trace_id: generateTraceId() };
}

/** Run one scalar query as the container superuser. */
function psqlScalar(dbUrl: string, sql: string): string {
  return execFileSync('psql', [dbUrl, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
  }).trim();
}

describe.runIf(RLS_SUITE)('chat scheduled send: owner-only rows and proc gates', () => {
  let admin: Client;
  let adminGeneric: GenericClient;
  let dbUrl: string;
  // owner and partner share a DM; bystander is an active member of the same
  // workspace outside the DM; foreigner belongs to a different workspace.
  let owner: SeededUser;
  let partner: SeededUser;
  let bystander: SeededUser;
  let foreigner: SeededUser;
  let ws: SeededWorkspace;
  let otherWs: SeededWorkspace;
  let dmChannelId: string;
  let scheduled: ScheduledRow[];

  async function schedule(user: SeededUser, args: ScheduleArgs): Promise<ScheduledRow> {
    const res = await clientFor(user.id).rpc('chat_message_schedule', args);
    if (res.error) throw new Error(`chat_message_schedule failed: ${res.error.message}`);
    return res.data;
  }

  function statusOf(id: string): string {
    return psqlScalar(dbUrl, `select status from public.${TABLE} where id = '${id}';`);
  }

  beforeAll(async () => {
    const env = loadRlsEnv();
    dbUrl = env.dbUrl;
    admin = createAdminClient(env);
    adminGeneric = asGeneric(admin);
    owner = await seedUser(env, admin);
    partner = await seedUser(env, admin);
    bystander = await seedUser(env, admin);
    foreigner = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Scheduled ${owner.email}`);
    otherWs = await seedWorkspace(admin, foreigner, `Scheduled other ${foreigner.email}`);
    await seedMember(adminGeneric, ws, partner, 'agency');
    await seedMember(adminGeneric, ws, bystander, 'client');
    dmChannelId = await seedDmChannel(adminGeneric, ws.id, owner, partner);
    scheduled = [
      await schedule(owner, scheduleArgs(dmChannelId, fromNow(HOUR))),
      await schedule(owner, scheduleArgs(dmChannelId, fromNow(2 * HOUR))),
    ];
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [ws, otherWs], [owner, partner, bystander, foreigner]);
  });

  it('T1. the owner reads their own scheduled rows', async () => {
    const client = asGeneric(clientFor(owner.id));
    for (const row of scheduled) {
      expect(await ownReadCount(client, TABLE, [['id', row.id]])).toBe(1);
    }
    expect(await ownReadCount(client, TABLE, [['channel_id', dmChannelId]])).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('T2. another member of the same workspace reads none of them', async () => {
    for (const user of [partner, bystander]) {
      const client = asGeneric(clientFor(user.id));
      expect(await ownReadCount(client, TABLE, [['channel_id', dmChannelId]])).toBe(0);
      expect(await visibleRowCount(client, TABLE, [['workspace_id', ws.id]])).toBe(0);
    }
  });

  it('T3. a user from another workspace reads none', async () => {
    const client = asGeneric(clientFor(foreigner.id));
    expect(await ownReadCount(client, TABLE, [['workspace_id', ws.id]])).toBe(0);
    for (const row of scheduled) {
      expect(await visibleRowCount(client, TABLE, [['id', row.id]])).toBe(0);
    }
  });

  it('T4. authenticated cannot INSERT, UPDATE or DELETE the table directly', async () => {
    const client = asGeneric(clientFor(owner.id));
    const insertId = crypto.randomUUID();
    const insert = await authInsert(client, TABLE, {
      id: insertId,
      channel_id: dmChannelId,
      workspace_id: ws.id,
      sender_user_id: owner.id,
      body: 'direct insert',
      send_at: fromNow(HOUR),
    });
    expect(insert.ok).toBe(false);
    expect(insert.count).toBe(0);
    expect(
      psqlScalar(dbUrl, `select count(*) from public.${TABLE} where id = '${insertId}';`),
    ).toBe('0');

    const target = scheduled[0];
    if (!target) throw new Error('no seeded scheduled row');
    expect(await updateRowCount(client, TABLE, [['id', target.id]], { status: 'sent' })).toBe(0);
    expect(await deleteRowCount(client, TABLE, [['id', target.id]])).toBe(0);
    expect(statusOf(target.id)).toBe('scheduled');
  });

  it('T5. chat_message_schedule works for a member channel and is refused otherwise', async () => {
    const row = await schedule(owner, scheduleArgs(dmChannelId, fromNow(3 * HOUR)));
    expect(row.sender_user_id).toBe(owner.id);
    expect(row.workspace_id).toBe(ws.id);
    expect(row.status).toBe('scheduled');

    for (const user of [bystander, foreigner]) {
      const args = scheduleArgs(dmChannelId, fromNow(HOUR));
      const res = await clientFor(user.id).rpc('chat_message_schedule', args);
      expect(res.error?.message).toBe('not a member of this chat');
      expect(
        psqlScalar(dbUrl, `select count(*) from public.${TABLE} where id = '${args.p_id}';`),
      ).toBe('0');
    }
  });

  it('T6. send_at outside the 1 minute to 365 day window is refused', async () => {
    const tooSoon = [fromNow(-HOUR), fromNow(0), fromNow(30 * 1000)];
    const tooLate = [fromNow(366 * DAY), fromNow(2 * 365 * DAY)];
    for (const sendAt of [...tooSoon, ...tooLate]) {
      const args = scheduleArgs(dmChannelId, sendAt);
      const res = await clientFor(owner.id).rpc('chat_message_schedule', args);
      expect(res.error?.message, sendAt).toBe(WINDOW_ERROR);
    }

    const target = scheduled[1];
    if (!target) throw new Error('no seeded scheduled row');
    for (const sendAt of [fromNow(30 * 1000), fromNow(366 * DAY)]) {
      const res = await clientFor(owner.id).rpc(
        'chat_scheduled_update',
        updateArgs(target.id, sendAt, target.body ?? 'body'),
      );
      expect(res.error?.message, sendAt).toBe(WINDOW_ERROR);
    }

    // Inside the window on both edges is accepted.
    await schedule(owner, scheduleArgs(dmChannelId, fromNow(5 * 60 * 1000)));
    await schedule(owner, scheduleArgs(dmChannelId, fromNow(364 * DAY)));
  });

  it('T7. update, cancel and send_now by a non-owner are refused', async () => {
    const target = scheduled[0];
    if (!target) throw new Error('no seeded scheduled row');
    for (const user of [partner, bystander, foreigner]) {
      const client = clientFor(user.id);
      const update = await client.rpc(
        'chat_scheduled_update',
        updateArgs(target.id, fromNow(4 * HOUR), 'hijacked'),
      );
      expect(update.error?.message).toBe(NOT_FOUND);
      const cancel = await client.rpc('chat_scheduled_cancel', idTraceArgs(target.id));
      expect(cancel.error?.message).toBe(NOT_FOUND);
      const sendNow = await client.rpc('chat_scheduled_send_now', idTraceArgs(target.id));
      expect(sendNow.error?.message).toBe(NOT_FOUND);
    }
    expect(statusOf(target.id)).toBe('scheduled');
    expect(psqlScalar(dbUrl, `select body from public.${TABLE} where id = '${target.id}';`)).toBe(
      target.body ?? '',
    );
    expect(
      psqlScalar(dbUrl, `select count(*) from public.chat_messages where id = '${target.id}';`),
    ).toBe('0');
  });

  it('T8. authenticated cannot EXECUTE the dispatcher and internal procs', async () => {
    const signatures = [
      'public.chat_scheduled_due(integer)',
      'public.chat_scheduled_dispatch(uuid, uuid)',
      'public.chat_scheduled_outcome_entry(public.chat_scheduled_messages, text, jsonb)',
      'public.chat_scheduled_clear_failed(uuid, uuid)',
    ];
    for (const sig of signatures) {
      expect(
        psqlScalar(dbUrl, `select has_function_privilege('authenticated', '${sig}', 'EXECUTE');`),
        sig,
      ).toBe('f');
      expect(
        psqlScalar(dbUrl, `select has_function_privilege('anon', '${sig}', 'EXECUTE');`),
        sig,
      ).toBe('f');
    }

    const target = scheduled[0];
    if (!target) throw new Error('no seeded scheduled row');
    const client = clientFor(owner.id);
    const dueArgs: Database['public']['Functions']['chat_scheduled_due']['Args'] = { p_limit: 10 };
    const due = await client.rpc('chat_scheduled_due', dueArgs);
    expect(due.error).not.toBeNull();
    const dispatch = await client.rpc('chat_scheduled_dispatch', idTraceArgs(target.id));
    expect(dispatch.error).not.toBeNull();
    const outcomeArgs: Database['public']['Functions']['chat_scheduled_outcome_entry']['Args'] = {
      s: target,
      p_event: 'scheduled_sent',
      p_payload: { scheduled_id: target.id },
    };
    const outcome = await client.rpc('chat_scheduled_outcome_entry', outcomeArgs);
    expect(outcome.error).not.toBeNull();
    const clearArgs: Database['public']['Functions']['chat_scheduled_clear_failed']['Args'] = {
      p_user_id: owner.id,
      p_scheduled_id: target.id,
    };
    const clear = await client.rpc('chat_scheduled_clear_failed', clearArgs);
    expect(clear.error).not.toBeNull();

    expect(statusOf(target.id)).toBe('scheduled');
    expect(
      psqlScalar(
        dbUrl,
        `select count(*) from public.inbox_entries where payload ->> 'scheduled_id' = '${target.id}';`,
      ),
    ).toBe('0');
  });
});
