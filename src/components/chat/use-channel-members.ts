// The people the mention picker offers in one chat: a group's current members
// or a DM's other person, never the viewer. Two reads at most, both batched: the
// group's member ids (listGroupMemberIds, groups only) and one readChatMembers
// (users IN + workspace_members IN, active only). Loaded once per chat open;
// the names also go to the mention registry so the chat list's "Draft:" line
// resolves a draft's tokens.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { listGroupMemberIds, readChatMembers, type ChatMember } from '@/lib/chat-reads';
import type { Result } from '@srtdio/rpc';
import { rememberMentionNames, type MentionMember } from '@/lib/chat/mentions';

/** Which chat to list: a group by its Sorted group id, or a DM by its peer. */
export interface ChannelMembersInput {
  workspaceId: string | null;
  currentUserId: string | null;
  groupId: string | null;
  peerUserId: string | null;
}

/** The two reads, injected so the rules are unit-tested without a client. */
export interface ChannelMemberReaders {
  groupMemberIds: (groupId: string) => Promise<Result<string[]>>;
  members: (workspaceId: string, userIds: string[]) => Promise<Result<ChatMember[]>>;
}

/** The candidate ids: the group's members, or the DM peer; never the viewer. */
export async function channelMemberIds(
  input: ChannelMembersInput,
  readers: ChannelMemberReaders,
): Promise<string[]> {
  if (input.groupId !== null) {
    const ids = await readers.groupMemberIds(input.groupId);
    if (!ids.ok) {
      logger.warn('chat: mention members read failed', { error: ids.error.message });
      return [];
    }
    return ids.data.filter((id) => id !== input.currentUserId);
  }
  return input.peerUserId !== null && input.peerUserId !== input.currentUserId
    ? [input.peerUserId]
    : [];
}

/** Load the picker rows for one chat; a failed read yields none (logged). */
export async function loadChannelMembers(
  input: ChannelMembersInput,
  readers: ChannelMemberReaders,
): Promise<MentionMember[]> {
  if (input.workspaceId === null) return [];
  const ids = await channelMemberIds(input, readers);
  if (ids.length === 0) return [];
  const result = await readers.members(input.workspaceId, ids);
  if (!result.ok) {
    logger.warn('chat: mention member profiles read failed', { error: result.error.message });
    return [];
  }
  return result.data.map((m) => ({
    userId: m.userId,
    displayName: m.displayName,
    avatarUrl: m.avatarUrl,
    role: m.role,
  }));
}

const READERS: ChannelMemberReaders = {
  groupMemberIds: (groupId) => listGroupMemberIds(supabase, { groupId }),
  members: (workspaceId, userIds) => readChatMembers(supabase, { workspaceId, userIds }),
};

/** The mention picker's people for the open chat ([] until loaded). */
export function useChannelMembers(input: ChannelMembersInput): MentionMember[] {
  const [members, setMembers] = useState<MentionMember[]>([]);
  const { workspaceId, currentUserId, groupId, peerUserId } = input;
  useEffect(() => {
    let cancelled = false;
    void loadChannelMembers({ workspaceId, currentUserId, groupId, peerUserId }, READERS).then(
      (next) => {
        if (cancelled) return;
        rememberMentionNames(next);
        setMembers(next);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, currentUserId, groupId, peerUserId]);
  return members;
}
