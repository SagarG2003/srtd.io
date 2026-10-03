// Chat message reminders (20261003140000_chat_message_reminders.sql):
//
//   T1. A user reads only their own chat_message_reminders rows; another member
//       of the same chat and a user in another workspace read none.
//   T2. chat_reminder_set refuses a non-member, remind_at outside
//       [now() + 1 minute, now() + 365 days], a deleted message and a message
//       from another chat. The same p_id twice is a no-op.
//   T3. Setting again on the same message cancels the earlier pending one; only
//       one pending reminder per person per message.
//   T4. chat_reminder_cancel cancels only the caller's own pending reminder;
//       someone else's id is a silent no-op that leaves it pending.
//   T5. chat_reminders_fire (as postgres) fires a due reminder into exactly one
//       'reminder' inbox entry, writes nothing more on a second call, and marks
//       reminders whose owner left the chat or whose message was deleted fired
//       with no entry.
//   T6. Soft-deleting a message via chat_message_delete cancels its pending
//       reminders.
//   T7. authenticated and anon cannot EXECUTE chat_reminders_fire or
//       chat_messages_reminders_on_delete; anon cannot EXECUTE chat_reminder_set
//       or chat_reminder_cancel.
//
// Rows are seeded through chat_reminder_set as the owner: no role but the
// SECURITY DEFINER procs writes chat_message_reminders. Making a reminder due
// and calling the cron-only chat_reminders_fire go through psql as the
// container superuser.

import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  createAdminClient,
  createAnonClient,
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
  type RlsEnv,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

type Client = SupabaseClient<Database>;
type SetArgs = Database['public']['Functions']['chat_reminder_set']['Args'];
type CancelArgs = Database['public']['Functions']['chat_reminder_cancel']['Args'];
type FireArgs = Database['public']['Functions']['chat_reminders_fire']['Args'];
type DeleteArgs = Database['public']['Functions']['chat_message_delete']['Args'];

const TABLE = 'chat_message_reminders';
const WINDOW_ERROR = 'reminder must be between 1 minute and 1 year from now';
const NOT_FOUND = 'message not found';
const NOT_MEMBER = 'not a member of this chat';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** An ISO timestamp `ms` milliseconds from now. */
function fromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function setArgs(messageId: string, channelId: string, remindAt: string): SetArgs {
  return {
    p_id: crypto.randomUUID(),
    p_message_id: messageId,
    p_channel_id: channelId,
    p_remind_at: remindAt,
    p_trace_id: generateTraceId(),
  };
}

function cancelArgs(id: string): CancelArgs {
  return { p_id: id, p_trace_id: generateTraceId() };
}

/** Run one scalar query as the container superuser. */
function psqlScalar(dbUrl: string, sql: string): string {
  return execFileSync('psql', [dbUrl, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
  }).trim();
}

describe.runIf(RLS_SUITE)('chat message reminders: own rows, proc gates and cron fire', () => {
  let env: RlsEnv;
  let admin: Client;
  let adminGeneric: GenericClient;
  let dbUrl: string;
  // owner and partner share a DM; bystander is an active member of the same
  // workspace outside that DM (owner and bystander share a second DM); leaver
  // shares a third DM with owner and leaves the workspace in T5; foreigner
  // belongs to a different workspace.
  let owner: SeededUser;
  let partner: SeededUser;
  let bystander: SeededUser;
  let leaver: SeededUser;
  let foreigner: SeededUser;
  let ws: SeededWorkspace;
  let otherWs: SeededWorkspace;
  let dmChannelId: string;
  let otherDmChannelId: string;
  let leaverDmChannelId: string;

  /** Seed one live message from `sender` in `channelId` and return its id. */
  async function seedMessage(
    channelId: string,
    sender: SeededUser,
    deletedAt: string | null = null,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await insertRow(adminGeneric, 'chat_messages', {
      id,
      channel_id: channelId,
      workspace_id: ws.id,
      sender_user_id: sender.id,
      body: `reminder ${randomSuffix()}`,
      agora_event_id: null,
      created_at: new Date().toISOString(),
      deleted_at: deletedAt,
    });
    return id;
  }

  async function setReminder(user: SeededUser, args: SetArgs): Promise<string> {
    const res = await clientFor(user.id).rpc('chat_reminder_set', args);
    if (res.error) throw new Error(`chat_reminder_set failed: ${res.error.message}`);
    return args.p_id;
  }

  /** 'pending', 'fired' or 'cancelled' for a reminder id, read as superuser. */
  function stateOf(id: string): string {
    return psqlScalar(
      dbUrl,
      `select case when cancelled_at is not null then 'cancelled' ` +
        `when fired_at is not null then 'fired' else 'pending' end ` +
        `from public.${TABLE} where id = '${id}';`,
    );
  }

  function makeDue(id: string): void {
    psqlScalar(
      dbUrl,
      `update public.${TABLE} set remind_at = now() - interval '1 second' where id = '${id}';`,
    );
  }

  function fire(): void {
    psqlScalar(dbUrl, 'select public.chat_reminders_fire(500);');
  }

  function entryCount(reminderId: string): number {
    return Number(
      psqlScalar(
        dbUrl,
        `select count(*) from public.inbox_entries where event_type = 'reminder' ` +
          `and payload ->> 'reminder_id' = '${reminderId}';`,
      ),
    );
  }

  beforeAll(async () => {
    env = loadRlsEnv();
    dbUrl = env.dbUrl;
    admin = createAdminClient(env);
    adminGeneric = asGeneric(admin);
    owner = await seedUser(env, admin);
    partner = await seedUser(env, admin);
    bystander = await seedUser(env, admin);
    leaver = await seedUser(env, admin);
    foreigner = await seedUser(env, admin);
    ws = await seedWorkspace(admin, owner, `Reminders ${owner.email}`);
    otherWs = await seedWorkspace(admin, foreigner, `Reminders other ${foreigner.email}`);
    await seedMember(adminGeneric, ws, partner, 'agency');
    await seedMember(adminGeneric, ws, bystander, 'client');
    await seedMember(adminGeneric, ws, leaver, 'agency');
    dmChannelId = await seedDmChannel(adminGeneric, ws.id, owner, partner);
    otherDmChannelId = await seedDmChannel(adminGeneric, ws.id, owner, bystander);
    leaverDmChannelId = await seedDmChannel(adminGeneric, ws.id, owner, leaver);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [ws, otherWs], [owner, partner, bystander, leaver, foreigner]);
  });

  it('T1. a user reads only their own reminder rows', async () => {
    const messageId = await seedMessage(dmChannelId, partner);
    const ownerReminder = await setReminder(owner, setArgs(messageId, dmChannelId, fromNow(HOUR)));
    const partnerReminder = await setReminder(
      partner,
      setArgs(messageId, dmChannelId, fromNow(HOUR)),
    );

    const ownerClient = asGeneric(clientFor(owner.id));
    const partnerClient = asGeneric(clientFor(partner.id));
    expect(await ownReadCount(ownerClient, TABLE, [['id', ownerReminder]])).toBe(1);
    expect(await ownReadCount(partnerClient, TABLE, [['id', partnerReminder]])).toBe(1);
    expect(await ownReadCount(ownerClient, TABLE, [['id', partnerReminder]])).toBe(0);
    expect(await ownReadCount(partnerClient, TABLE, [['id', ownerReminder]])).toBe(0);
    expect(await ownReadCount(partnerClient, TABLE, [['user_id', owner.id]])).toBe(0);

    const foreignClient = asGeneric(clientFor(foreigner.id));
    expect(await ownReadCount(foreignClient, TABLE, [['workspace_id', ws.id]])).toBe(0);
    for (const id of [ownerReminder, partnerReminder]) {
      expect(await visibleRowCount(foreignClient, TABLE, [['id', id]])).toBe(0);
    }
  });

  it('T2. chat_reminder_set refuses bad input and is idempotent on p_id', async () => {
    const messageId = await seedMessage(dmChannelId, partner);
    const client = clientFor(owner.id);

    const nonMember = await clientFor(bystander.id).rpc(
      'chat_reminder_set',
      setArgs(messageId, dmChannelId, fromNow(HOUR)),
    );
    expect(nonMember.error?.message).toBe(NOT_MEMBER);

    for (const remindAt of [fromNow(-HOUR), fromNow(30 * 1000), fromNow(366 * DAY)]) {
      const res = await client.rpc('chat_reminder_set', setArgs(messageId, dmChannelId, remindAt));
      expect(res.error?.message, remindAt).toBe(WINDOW_ERROR);
    }

    const deletedId = await seedMessage(dmChannelId, partner, new Date().toISOString());
    const deleted = await client.rpc(
      'chat_reminder_set',
      setArgs(deletedId, dmChannelId, fromNow(HOUR)),
    );
    expect(deleted.error?.message).toBe(NOT_FOUND);

    const otherChatId = await seedMessage(otherDmChannelId, bystander);
    const otherChat = await client.rpc(
      'chat_reminder_set',
      setArgs(otherChatId, dmChannelId, fromNow(HOUR)),
    );
    expect(otherChat.error?.message).toBe(NOT_FOUND);

    expect(
      psqlScalar(
        dbUrl,
        `select count(*) from public.${TABLE} ` +
          `where message_id in ('${messageId}', '${deletedId}', '${otherChatId}');`,
      ),
    ).toBe('0');

    // The same p_id twice: the second call is a no-op, not a reschedule.
    const first = setArgs(messageId, dmChannelId, fromNow(HOUR));
    await setReminder(owner, first);
    const before = psqlScalar(
      dbUrl,
      `select remind_at from public.${TABLE} where id = '${first.p_id}';`,
    );
    const repeat: SetArgs = { ...first, p_remind_at: fromNow(2 * HOUR) };
    const again = await client.rpc('chat_reminder_set', repeat);
    expect(again.error).toBeNull();
    expect(
      psqlScalar(dbUrl, `select count(*) from public.${TABLE} where id = '${first.p_id}';`),
    ).toBe('1');
    expect(
      psqlScalar(dbUrl, `select remind_at from public.${TABLE} where id = '${first.p_id}';`),
    ).toBe(before);
    expect(stateOf(first.p_id)).toBe('pending');
  });

  it('T3. setting again on the same message replaces the pending reminder', async () => {
    const messageId = await seedMessage(dmChannelId, partner);
    const earlier = await setReminder(owner, setArgs(messageId, dmChannelId, fromNow(HOUR)));
    const later = await setReminder(owner, setArgs(messageId, dmChannelId, fromNow(3 * HOUR)));

    expect(stateOf(earlier)).toBe('cancelled');
    expect(stateOf(later)).toBe('pending');
    expect(
      psqlScalar(
        dbUrl,
        `select count(*) from public.${TABLE} where user_id = '${owner.id}' ` +
          `and message_id = '${messageId}' and fired_at is null and cancelled_at is null;`,
      ),
    ).toBe('1');
  });

  it("T4. chat_reminder_cancel cancels only the caller's own pending reminder", async () => {
    const messageId = await seedMessage(dmChannelId, partner);
    const reminder = await setReminder(owner, setArgs(messageId, dmChannelId, fromNow(HOUR)));

    for (const user of [partner, bystander, foreigner]) {
      const res = await clientFor(user.id).rpc('chat_reminder_cancel', cancelArgs(reminder));
      expect(res.error).toBeNull();
    }
    expect(stateOf(reminder)).toBe('pending');

    const own = await clientFor(owner.id).rpc('chat_reminder_cancel', cancelArgs(reminder));
    expect(own.error).toBeNull();
    expect(stateOf(reminder)).toBe('cancelled');
  });

  it('T5. chat_reminders_fire writes one reminder entry and skips leavers and deleted messages', async () => {
    const messageId = await seedMessage(dmChannelId, partner);
    const due = await setReminder(owner, setArgs(messageId, dmChannelId, fromNow(HOUR)));
    makeDue(due);

    fire();
    expect(stateOf(due)).toBe('fired');
    expect(entryCount(due)).toBe(1);
    const entry = psqlScalar(
      dbUrl,
      `select json_build_object('user_id', user_id, 'workspace_id', workspace_id, ` +
        `'tier', tier, 'entity_type', entity_type, 'entity_id', entity_id, 'payload', payload) ` +
        `from public.inbox_entries where event_type = 'reminder' ` +
        `and payload ->> 'reminder_id' = '${due}';`,
    );
    expect(JSON.parse(entry)).toEqual({
      user_id: owner.id,
      workspace_id: ws.id,
      tier: 'urgent',
      entity_type: 'chat_channel',
      entity_id: dmChannelId,
      payload: { message_id: messageId, reminder_id: due },
    });

    fire();
    expect(entryCount(due)).toBe(1);

    // A reminder whose message was deleted after it was set (the delete trigger
    // is bypassed here so the fire-time check is what is exercised).
    const goneMessage = await seedMessage(dmChannelId, partner);
    const goneReminder = await setReminder(owner, setArgs(goneMessage, dmChannelId, fromNow(HOUR)));
    psqlScalar(
      dbUrl,
      `set session_replication_role = replica; ` +
        `update public.chat_messages set deleted_at = now() where id = '${goneMessage}';`,
    );
    expect(stateOf(goneReminder)).toBe('pending');
    makeDue(goneReminder);

    // A reminder whose owner left the chat (left the workspace, so the DM no
    // longer counts them as a member).
    const leaverMessage = await seedMessage(leaverDmChannelId, owner);
    const leaverReminder = await setReminder(
      leaver,
      setArgs(leaverMessage, leaverDmChannelId, fromNow(HOUR)),
    );
    psqlScalar(
      dbUrl,
      `update public.workspace_members set active = false ` +
        `where workspace_id = '${ws.id}' and user_id = '${leaver.id}';`,
    );
    makeDue(leaverReminder);

    fire();
    for (const id of [goneReminder, leaverReminder]) {
      expect(stateOf(id), id).toBe('fired');
      expect(entryCount(id), id).toBe(0);
    }
  });

  it('T6. deleting a message via chat_message_delete cancels its pending reminders', async () => {
    const messageId = await seedMessage(dmChannelId, owner);
    const ownerReminder = await setReminder(owner, setArgs(messageId, dmChannelId, fromNow(HOUR)));
    const partnerReminder = await setReminder(
      partner,
      setArgs(messageId, dmChannelId, fromNow(HOUR)),
    );

    const deleteArgs: DeleteArgs = {
      p_message_ids: [messageId],
      p_channel_id: dmChannelId,
      p_trace_id: generateTraceId(),
    };
    const res = await clientFor(owner.id).rpc('chat_message_delete', deleteArgs);
    expect(res.error).toBeNull();
    expect(stateOf(ownerReminder)).toBe('cancelled');
    expect(stateOf(partnerReminder)).toBe('cancelled');
  });

  it('T7. cron and trigger procs are not executable by clients; anon cannot set or cancel', async () => {
    const internal = [
      'public.chat_reminders_fire(integer)',
      'public.chat_messages_reminders_on_delete()',
    ];
    for (const sig of internal) {
      for (const role of ['authenticated', 'anon']) {
        expect(
          psqlScalar(dbUrl, `select has_function_privilege('${role}', '${sig}', 'EXECUTE');`),
          `${role} ${sig}`,
        ).toBe('f');
      }
    }
    const member = [
      'public.chat_reminder_set(uuid, text, text, timestamptz, uuid)',
      'public.chat_reminder_cancel(uuid, uuid)',
    ];
    for (const sig of member) {
      expect(
        psqlScalar(dbUrl, `select has_function_privilege('anon', '${sig}', 'EXECUTE');`),
        sig,
      ).toBe('f');
      expect(
        psqlScalar(dbUrl, `select has_function_privilege('authenticated', '${sig}', 'EXECUTE');`),
        sig,
      ).toBe('t');
    }

    const messageId = await seedMessage(dmChannelId, partner);
    const reminder = await setReminder(owner, setArgs(messageId, dmChannelId, fromNow(HOUR)));
    makeDue(reminder);

    const fireArgs: FireArgs = { p_limit: 10 };
    const authFire = await clientFor(owner.id).rpc('chat_reminders_fire', fireArgs);
    expect(authFire.error).not.toBeNull();

    const anon: Client = createAnonClient(env);
    const anonFire = await anon.rpc('chat_reminders_fire', fireArgs);
    expect(anonFire.error).not.toBeNull();
    const anonSet = await anon.rpc(
      'chat_reminder_set',
      setArgs(messageId, dmChannelId, fromNow(HOUR)),
    );
    expect(anonSet.error).not.toBeNull();
    const anonCancel = await anon.rpc('chat_reminder_cancel', cancelArgs(reminder));
    expect(anonCancel.error).not.toBeNull();

    expect(stateOf(reminder)).toBe('pending');
    expect(entryCount(reminder)).toBe(0);
    psqlScalar(dbUrl, `update public.${TABLE} set cancelled_at = now() where id = '${reminder}';`);
  });
});
