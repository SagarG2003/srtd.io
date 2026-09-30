import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgoraChat } from 'agora-chat';
import type { Client, DomainError, Result } from '@srtdio/rpc';

// The action layer's wrappers are mocked: the roster command must follow a
// successful RPC only, and nothing it does may reach the RPC result.
vi.mock('@srtdio/rpc', () => ({
  dmChannelEnsure: vi.fn(),
  groupCreate: vi.fn(),
  groupRename: vi.fn(),
  groupMemberAdd: vi.fn(),
  groupMemberRemove: vi.fn(),
  groupLeave: vi.fn(),
}));
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  groupCreate,
  groupLeave,
  groupMemberAdd,
  groupMemberRemove,
  groupRename,
} from '@srtdio/rpc';
import {
  addGroupMember,
  createGroupChannel,
  leaveGroupChannel,
  removeGroupMember,
  renameGroupChannel,
  setGroupAvatar,
} from '@/components/chat/chat-actions';
import {
  ROSTER_ACTION,
  rosterSignalTargets,
  sendRosterSignal,
  withRosterSignal,
  type RosterChange,
  type RosterKind,
} from '@/lib/chat/roster-signal';
import { fanoutTarget, type ChannelTarget, type LiveSendConnection } from '@/lib/chat/thread';
import type { CreateCmdMessage } from '@/lib/chat/typing';
import { toAgoraUsername } from '@/lib/chat/agora-identity';

const ME = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';
const CHANNEL = 'c0000000-0000-4000-8000-000000000001';
const GROUP_ID = 'g0000000-0000-4000-8000-000000000001';
const SYNCED: ChannelTarget = { targetId: 'agora-group-1', chatType: 'groupChat' };
const single = (id: string): ChannelTarget => ({
  targetId: toAgoraUsername(id),
  chatType: 'singleChat',
});

const fail: Result<never> = {
  ok: false,
  error: { code: 'forbidden_role', message: 'nope' } satisfies DomainError,
};
const createCmd: CreateCmdMessage = (options) => options as unknown as AgoraChat.MessageBody;

function connection(send = vi.fn().mockResolvedValue({})): LiveSendConnection & {
  send: ReturnType<typeof vi.fn>;
} {
  return { send };
}

/** The actor's wiring: after the RPC succeeds, send the change to its targets. */
function signalWith(
  conn: LiveSendConnection,
  change: RosterChange,
  groupTarget: ChannelTarget | null,
  onError = vi.fn(),
): () => Promise<void> {
  return () =>
    sendRosterSignal({
      connection: conn,
      createCmd,
      targets: rosterSignalTargets(change, groupTarget, ME),
      channelId: CHANNEL,
      kind: change.kind as RosterKind,
      onError,
    });
}

function sent(conn: { send: ReturnType<typeof vi.fn> }): Array<{
  to: string;
  chatType: string;
  action: string;
  ext: unknown;
}> {
  return conn.send.mock.calls.map(
    ([m]) => m as { to: string; chatType: string; action: string; ext: unknown },
  );
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('L2 roster targets per action', () => {
  it('group_create: singleChat to each member, not self', () => {
    expect(rosterSignalTargets({ kind: 'created', memberUserIds: [ME, A, B] }, null, ME)).toEqual([
      single(A),
      single(B),
    ]);
  });

  it('rename / photo: to the group (groupChat when synced, per member when not)', () => {
    expect(rosterSignalTargets({ kind: 'renamed' }, SYNCED, ME)).toEqual([SYNCED]);
    const fan = fanoutTarget(CHANNEL, [ME, A, B], ME);
    expect(rosterSignalTargets({ kind: 'photo' }, fan, ME)).toEqual([fan]);
    expect(rosterSignalTargets({ kind: 'renamed' }, null, ME)).toEqual([]);
  });

  it('member add / remove: singleChat to the user + to the group, never twice', () => {
    expect(rosterSignalTargets({ kind: 'members', added: [A] }, SYNCED, ME)).toEqual([
      single(A),
      SYNCED,
    ]);
    const fan = fanoutTarget(CHANNEL, [ME, A, B], ME);
    expect(rosterSignalTargets({ kind: 'members', removed: [A] }, fan, ME)).toEqual([
      single(A),
      { ...fan, fanout: [toAgoraUsername(B)] },
    ]);
  });
});

describe('L2 actor sends after a successful RPC only', () => {
  it('rename success sends one roster cmd with {sorted_channel_id, kind}', async () => {
    vi.mocked(groupRename).mockResolvedValue({ ok: true, data: undefined } as never);
    const conn = connection();
    const onDone = vi.fn();
    const failure = await renameGroupChannel(
      {} as Client,
      { groupId: GROUP_ID, name: 'New', traceId: 't' },
      withRosterSignal(onDone, signalWith(conn, { kind: 'renamed' }, SYNCED), vi.fn()),
    );
    await flush();
    expect(failure).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(sent(conn)).toEqual([
      {
        chatType: 'groupChat',
        type: 'cmd',
        to: 'agora-group-1',
        action: ROSTER_ACTION,
        ext: { sorted_channel_id: CHANNEL, kind: 'renamed' },
      },
    ]);
  });

  it('group_create, add, remove and photo each reach their targets', async () => {
    vi.mocked(groupCreate).mockResolvedValue({ ok: true, data: GROUP_ID });
    vi.mocked(groupMemberAdd).mockResolvedValue({ ok: true, data: undefined } as never);
    vi.mocked(groupMemberRemove).mockResolvedValue({ ok: true, data: undefined } as never);
    const rpcClient = { rpc: vi.fn().mockResolvedValue({ error: null }) } as unknown as Client;

    const created = connection();
    await createGroupChannel(
      rpcClient,
      { workspaceId: 'w', name: 'G', memberUserIds: [A, B], traceId: 't' },
      withRosterSignal(
        () => {},
        signalWith(created, { kind: 'created', memberUserIds: [A, B] }, null),
        vi.fn(),
      ),
    );
    const added = connection();
    await addGroupMember(
      rpcClient,
      { groupId: GROUP_ID, userId: A, traceId: 't' },
      withRosterSignal(
        () => {},
        signalWith(added, { kind: 'members', added: [A] }, SYNCED),
        vi.fn(),
      ),
    );
    const removed = connection();
    await removeGroupMember(
      rpcClient,
      { groupId: GROUP_ID, userId: B, traceId: 't' },
      withRosterSignal(
        () => {},
        signalWith(removed, { kind: 'members', removed: [B] }, SYNCED),
        vi.fn(),
      ),
    );
    const photo = connection();
    await setGroupAvatar(
      rpcClient,
      { groupId: GROUP_ID, avatarUrl: null, traceId: 't' },
      withRosterSignal(() => {}, signalWith(photo, { kind: 'photo' }, SYNCED), vi.fn()),
    );
    await flush();
    expect(sent(created).map((m) => [m.to, m.chatType])).toEqual([
      [toAgoraUsername(A), 'singleChat'],
      [toAgoraUsername(B), 'singleChat'],
    ]);
    expect(sent(added).map((m) => [m.to, m.chatType])).toEqual([
      [toAgoraUsername(A), 'singleChat'],
      ['agora-group-1', 'groupChat'],
    ]);
    expect(sent(removed).map((m) => [m.to, m.chatType])).toEqual([
      [toAgoraUsername(B), 'singleChat'],
      ['agora-group-1', 'groupChat'],
    ]);
    expect(sent(photo).map((m) => (m.ext as { kind: string }).kind)).toEqual(['photo']);
  });

  it('an RPC failure sends nothing', async () => {
    vi.mocked(groupRename).mockResolvedValue(fail);
    vi.mocked(groupMemberAdd).mockResolvedValue(fail);
    const conn = connection();
    const a = await renameGroupChannel(
      {} as Client,
      { groupId: GROUP_ID, name: 'X', traceId: 't' },
      withRosterSignal(() => {}, signalWith(conn, { kind: 'renamed' }, SYNCED), vi.fn()),
    );
    const b = await addGroupMember(
      {} as Client,
      { groupId: GROUP_ID, userId: A, traceId: 't' },
      withRosterSignal(
        () => {},
        signalWith(conn, { kind: 'members', added: [A] }, SYNCED),
        vi.fn(),
      ),
    );
    await flush();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(conn.send).not.toHaveBeenCalled();
  });

  it('a cmd failure (reject, throw, hang) does not affect the RPC result', async () => {
    vi.mocked(groupRename).mockResolvedValue({ ok: true, data: undefined } as never);
    const onError = vi.fn();
    const rejecting = connection(vi.fn().mockRejectedValue(new Error('agora down')));
    const onDone = vi.fn();
    const result = await renameGroupChannel(
      {} as Client,
      { groupId: GROUP_ID, name: 'New', traceId: 't' },
      withRosterSignal(
        onDone,
        signalWith(rejecting, { kind: 'renamed' }, SYNCED, onError),
        vi.fn(),
      ),
    );
    expect(result).toBeNull();
    expect(onDone).toHaveBeenCalledTimes(1);
    await flush();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'renamed' }));

    const throwing = await renameGroupChannel(
      {} as Client,
      { groupId: GROUP_ID, name: 'New', traceId: 't' },
      withRosterSignal(
        () => {},
        () => {
          throw new Error('sync throw');
        },
        vi.fn(),
      ),
    );
    expect(throwing).toBeNull();

    vi.useFakeTimers();
    try {
      const hanging = connection(vi.fn(() => new Promise(() => {})));
      const timedOut = vi.fn();
      const pending = sendRosterSignal({
        connection: hanging,
        createCmd,
        targets: [SYNCED],
        channelId: CHANNEL,
        kind: 'renamed',
        onError: timedOut,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toBeUndefined();
      expect(timedOut).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('timed out') }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('J4 group_leave tells the group', () => {
  it('leave success sends a members cmd to the group (not to self); failure sends nothing', async () => {
    vi.mocked(groupLeave).mockResolvedValue({ ok: true, data: undefined } as never);
    const conn = connection();
    const onLeft = vi.fn();
    const change: RosterChange = { kind: 'members', removed: [ME] };
    const ok = await leaveGroupChannel(
      {} as Client,
      { groupId: GROUP_ID, traceId: 't' },
      withRosterSignal(onLeft, signalWith(conn, change, SYNCED), vi.fn()),
    );
    await flush();
    expect(ok).toBeNull();
    expect(onLeft).toHaveBeenCalledTimes(1);
    expect(sent(conn).map((m) => [m.to, m.chatType, (m.ext as { kind: string }).kind])).toEqual([
      ['agora-group-1', 'groupChat', 'members'],
    ]);

    vi.mocked(groupLeave).mockResolvedValue(fail);
    const none = connection();
    const failed = await leaveGroupChannel(
      {} as Client,
      { groupId: GROUP_ID, traceId: 't' },
      withRosterSignal(vi.fn(), signalWith(none, change, SYNCED), vi.fn()),
    );
    await flush();
    expect(failed).not.toBeNull();
    expect(none.send).not.toHaveBeenCalled();
  });
});
