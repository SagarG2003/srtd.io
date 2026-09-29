import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  channelMemberIds,
  loadChannelMembers,
  type ChannelMemberReaders,
} from '@/components/chat/use-channel-members';

const ME = 'me';
const PEER = 'peer';

function readers(groupIds: string[]): ChannelMemberReaders & {
  members: ReturnType<typeof vi.fn>;
} {
  return {
    groupMemberIds: vi.fn(async () => ({ ok: true as const, data: groupIds })),
    members: vi.fn(async (_ws: string, ids: string[]) => ({
      ok: true as const,
      data: ids.map((id) => ({ userId: id, displayName: id, avatarUrl: null, role: 'agency' })),
    })),
  };
}

describe('channelMemberIds', () => {
  it('a group lists its members except me', async () => {
    const ids = await channelMemberIds(
      { workspaceId: 'w', currentUserId: ME, groupId: 'g', peerUserId: null },
      readers([ME, 'a', 'b']),
    );
    expect(ids).toEqual(['a', 'b']);
  });

  it('a DM lists only the other person', async () => {
    const r = readers([]);
    const ids = await channelMemberIds(
      { workspaceId: 'w', currentUserId: ME, groupId: null, peerUserId: PEER },
      r,
    );
    expect(ids).toEqual([PEER]);
    expect(r.groupMemberIds).not.toHaveBeenCalled();
  });
});

describe('loadChannelMembers', () => {
  it('reads profiles and roles in one batched call', async () => {
    const r = readers([ME, 'a', 'b']);
    const members = await loadChannelMembers(
      { workspaceId: 'w', currentUserId: ME, groupId: 'g', peerUserId: null },
      r,
    );
    expect(members.map((m) => m.userId)).toEqual(['a', 'b']);
    expect(r.members).toHaveBeenCalledTimes(1);
    expect(r.members).toHaveBeenCalledWith('w', ['a', 'b']);
  });

  it('a failed read yields no rows', async () => {
    const members = await loadChannelMembers(
      { workspaceId: 'w', currentUserId: ME, groupId: 'g', peerUserId: null },
      {
        groupMemberIds: async () => ({ ok: false, error: { code: 'unknown', message: 'x' } }),
        members: async () => ({ ok: true, data: [] }),
      },
    );
    expect(members).toEqual([]);
  });
});
