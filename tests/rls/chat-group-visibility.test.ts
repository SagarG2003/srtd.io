// Chat and group list visibility (20260927235627_chat_group_visibility_participants_only.sql).
// chat_channels, groups and group_members SELECT used to be workspace-wide, so
// every active member saw every DM and group in the workspace. They are now
// participant-only:
//
//   a. An active member cannot SELECT a DM between two other members.
//   b. A DM participant can SELECT their own DM.
//   c. groups / group_members rows are readable only by that group's members.
//   d. A deactivated workspace member (active = false) cannot SELECT a group
//      they are still listed in.
//   e. plan_period channels stay visible to every active member.
//   f. Deleting the last group_members row archives the group (deleted_at set);
//      deleting a non-last row does not.
//   g. Cross-tenant: a member of workspace X reads zero chat_channels / groups /
//      group_members rows of workspace Y.
//
// Seeding goes through the service role (the privileged path), following the
// rationale in packages/test-utils/rls.ts.

import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asGeneric,
  cleanupWorkspaces,
  clientFor,
  countWhere,
  createAdminClient,
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
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

type Client = SupabaseClient<Database>;

interface SeededGroup {
  groupId: string;
  channelId: string;
}

/** Seed a group, its group chat channel, and one group_members row per member. */
async function seedGroup(
  admin: GenericClient,
  ws: SeededWorkspace,
  members: readonly SeededUser[],
): Promise<SeededGroup> {
  const group = await insertRow(admin, 'groups', {
    workspace_id: ws.id,
    name: `Grp ${randomSuffix()}`,
    created_by: ws.ownerId,
  });
  const groupId = String(group.id);
  const channelId = `group__${ws.id}__${groupId}`;
  await insertRow(admin, 'chat_channels', {
    channel_id: channelId,
    workspace_id: ws.id,
    channel_type: 'group',
    entity_id: groupId,
  });
  for (const user of members) {
    await insertRow(admin, 'group_members', {
      group_id: groupId,
      user_id: user.id,
      workspace_id: ws.id,
    });
  }
  return { groupId, channelId };
}

/** groups.deleted_at read through the service role (ground truth, RLS bypassed). */
async function groupDeletedAt(admin: GenericClient, groupId: string): Promise<string | null> {
  const res = await admin.from('groups').select('deleted_at').eq('id', groupId);
  if (res.error) throw new Error(`groups read failed: ${res.error.message}`);
  const rows = res.data as { deleted_at: string | null }[] | null;
  const row = rows?.[0];
  if (!row) throw new Error(`group ${groupId} not found`);
  return row.deleted_at;
}

/** Delete one group_members row through the service role. */
async function removeMember(admin: GenericClient, groupId: string, userId: string): Promise<void> {
  const res = await admin
    .from('group_members')
    .delete()
    .eq('group_id', groupId)
    .eq('user_id', userId);
  if (res.error) throw new Error(`group_members delete failed: ${res.error.message}`);
}

/**
 * chat_channels rows `userIds` can each see for a plan_period channel, read via
 * psql in a transaction that is always rolled back. The live schema's
 * channel_type / channel_id CHECKs no longer admit plan_period rows, so the
 * transaction lifts them just long enough to seed one, then evaluates the real
 * chat_channels_select_member policy as the authenticated role with each
 * user's JWT claims. Nothing persists.
 */
function planPeriodVisibility(
  dbUrl: string,
  workspaceId: string,
  userIds: readonly string[],
): Map<string, number> {
  const entityId = crypto.randomUUID();
  const channelId = `plan__${workspaceId}__${entityId}`;
  const reads = userIds
    .map((uid) => {
      const claims = JSON.stringify({ sub: uid, role: 'authenticated' });
      return (
        `select set_config('request.jwt.claims', '${claims}', true);\n` +
        `select 'visible:${uid}:' || count(*) from public.chat_channels ` +
        `where channel_id = '${channelId}';`
      );
    })
    .join('\n');
  const sql = [
    'begin;',
    'alter table public.chat_channels drop constraint chat_channels_channel_type_check;',
    'alter table public.chat_channels drop constraint chat_channels_channel_id_check;',
    'insert into public.chat_channels (channel_id, workspace_id, channel_type, entity_id) ' +
      `values ('${channelId}', '${workspaceId}', 'plan_period', '${entityId}');`,
    "select set_config('role', 'authenticated', true);",
    reads,
    'rollback;',
  ].join('\n');
  const out = execFileSync('psql', [dbUrl, '-At', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    input: sql,
    encoding: 'utf8',
  });
  const counts = new Map<string, number>();
  for (const line of out.split('\n')) {
    const match = /^visible:([0-9a-f-]{36}):(\d+)$/.exec(line.trim());
    if (match?.[1] && match[2]) counts.set(match[1], Number(match[2]));
  }
  return counts;
}

describe.runIf(RLS_SUITE)('chat_channels / groups / group_members: participants only', () => {
  let admin: Client;
  let adminGeneric: GenericClient;
  let dbUrl: string;
  // Workspace X: owner, A, B, C, D all active at seed time; D is deactivated in
  // beforeAll. Workspace Y: ownerY and memberY.
  let owner: SeededUser;
  let userA: SeededUser;
  let userB: SeededUser;
  let userC: SeededUser;
  let userD: SeededUser;
  let ownerY: SeededUser;
  let memberY: SeededUser;
  let wsX: SeededWorkspace;
  let wsY: SeededWorkspace;
  let dmAB: string;
  let dmBC: string;
  let groupBC: SeededGroup;
  let groupAB: SeededGroup;
  let groupD: SeededGroup;
  let aClient: GenericClient;
  let dClient: GenericClient;

  beforeAll(async () => {
    const env = loadRlsEnv();
    dbUrl = env.dbUrl;
    admin = createAdminClient(env);
    adminGeneric = asGeneric(admin);

    owner = await seedUser(env, admin);
    userA = await seedUser(env, admin);
    userB = await seedUser(env, admin);
    userC = await seedUser(env, admin);
    userD = await seedUser(env, admin);
    ownerY = await seedUser(env, admin);
    memberY = await seedUser(env, admin);
    wsX = await seedWorkspace(admin, owner, `Vis X ${owner.email}`);
    wsY = await seedWorkspace(admin, ownerY, `Vis Y ${ownerY.email}`);
    for (const user of [userA, userB, userC, userD]) {
      await seedMember(adminGeneric, wsX, user, 'agency');
    }
    await seedMember(adminGeneric, wsY, memberY, 'agency');

    dmAB = await seedDmChannel(adminGeneric, wsX.id, userA, userB);
    dmBC = await seedDmChannel(adminGeneric, wsX.id, userB, userC);
    groupBC = await seedGroup(adminGeneric, wsX, [userB, userC]);
    groupAB = await seedGroup(adminGeneric, wsX, [userA, userB]);
    groupD = await seedGroup(adminGeneric, wsX, [userD, userB]);

    // Workspace Y: a DM and a group, neither involving anyone from workspace X.
    await seedDmChannel(adminGeneric, wsY.id, ownerY, memberY);
    await seedGroup(adminGeneric, wsY, [ownerY, memberY]);

    // D leaves the workspace but keeps the group_members row.
    const deactivate = await adminGeneric
      .from('workspace_members')
      .update({ active: false })
      .eq('workspace_id', wsX.id)
      .eq('user_id', userD.id);
    if (deactivate.error) throw new Error(`deactivate failed: ${deactivate.error.message}`);

    aClient = asGeneric(clientFor(userA.id));
    dClient = asGeneric(clientFor(userD.id));
  });

  afterAll(async () => {
    await cleanupWorkspaces(
      admin,
      [wsX, wsY],
      [owner, userA, userB, userC, userD, ownerY, memberY],
    );
  });

  it('a. an active member cannot SELECT a DM between two other members', async () => {
    const match = [['channel_id', dmBC]] as const;
    expect(await countWhere(adminGeneric, 'chat_channels', match)).toBe(1);
    expect(await visibleRowCount(aClient, 'chat_channels', match)).toBe(0);
  });

  it('b. a DM participant can SELECT their own DM', async () => {
    expect(await ownReadCount(aClient, 'chat_channels', [['channel_id', dmAB]])).toBe(1);
  });

  it('c. groups / group_members are readable only by that group`s members', async () => {
    // Not a member of groupBC.
    expect(await countWhere(adminGeneric, 'groups', [['id', groupBC.groupId]])).toBe(1);
    expect(await visibleRowCount(aClient, 'groups', [['id', groupBC.groupId]])).toBe(0);
    expect(await countWhere(adminGeneric, 'group_members', [['group_id', groupBC.groupId]])).toBe(
      2,
    );
    expect(await visibleRowCount(aClient, 'group_members', [['group_id', groupBC.groupId]])).toBe(
      0,
    );
    expect(
      await visibleRowCount(aClient, 'chat_channels', [['channel_id', groupBC.channelId]]),
    ).toBe(0);

    // Member of groupAB: sees the group, every member row, and the channel.
    expect(await ownReadCount(aClient, 'groups', [['id', groupAB.groupId]])).toBe(1);
    expect(await ownReadCount(aClient, 'group_members', [['group_id', groupAB.groupId]])).toBe(2);
    expect(await ownReadCount(aClient, 'chat_channels', [['channel_id', groupAB.channelId]])).toBe(
      1,
    );
  });

  it('d. a deactivated workspace member cannot SELECT a group they are still listed in', async () => {
    const memberRow = [
      ['group_id', groupD.groupId],
      ['user_id', userD.id],
    ] as const;
    expect(await countWhere(adminGeneric, 'group_members', memberRow)).toBe(1);
    expect(await visibleRowCount(dClient, 'groups', [['id', groupD.groupId]])).toBe(0);
    expect(await visibleRowCount(dClient, 'group_members', [['group_id', groupD.groupId]])).toBe(0);
    expect(
      await visibleRowCount(dClient, 'chat_channels', [['channel_id', groupD.channelId]]),
    ).toBe(0);
  });

  it('e. plan_period channels stay visible to every active member, and only them', () => {
    const counts = planPeriodVisibility(dbUrl, wsX.id, [userA.id, userC.id, userD.id, ownerY.id]);
    expect(counts.get(userA.id)).toBe(1);
    expect(counts.get(userC.id)).toBe(1);
    // Deactivated in workspace X, and a member of another workspace entirely.
    expect(counts.get(userD.id)).toBe(0);
    expect(counts.get(ownerY.id)).toBe(0);
  });

  it('f. deleting the last group_members row archives the group; a non-last row does not', async () => {
    const group = await seedGroup(adminGeneric, wsX, [userA, userC]);
    expect(await groupDeletedAt(adminGeneric, group.groupId)).toBeNull();

    await removeMember(adminGeneric, group.groupId, userC.id);
    expect(await groupDeletedAt(adminGeneric, group.groupId)).toBeNull();
    expect(await ownReadCount(aClient, 'groups', [['id', group.groupId]])).toBe(1);

    await removeMember(adminGeneric, group.groupId, userA.id);
    expect(await groupDeletedAt(adminGeneric, group.groupId)).not.toBeNull();
  });

  it('g. cross-tenant: a member of X reads zero chat_channels / groups / group_members of Y', async () => {
    const inY = [['workspace_id', wsY.id]] as const;
    expect(await countWhere(adminGeneric, 'chat_channels', inY)).toBe(2);
    expect(await countWhere(adminGeneric, 'groups', inY)).toBe(1);
    expect(await countWhere(adminGeneric, 'group_members', inY)).toBe(2);
    for (const table of ['chat_channels', 'groups', 'group_members']) {
      expect(await visibleRowCount(aClient, table, inY)).toBe(0);
    }
  });
});
