// Loads the workspace's members as picker options, reusing the existing reads:
// @srtdio/workspace's listMembers (RLS-scoped workspace_members select) for the
// member ids and chat-reads' batched readProfiles for display name + avatar. No
// new DB read and no N+1: one membership read plus one batched profile read.
// Only active memberships become options, one per user (a user can hold an
// inactive row next to their active one).

import { useCallback, useEffect, useState } from 'react';
import { listMembers } from '@srtdio/workspace';
import type { Database } from '@srtdio/schemas';
import type { Result } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { readProfiles } from '@/lib/chat-reads';
import { toMemberOptions, type MemberOption } from '@/components/chat/member-picker';

export interface WorkspaceMembersState {
  options: MemberOption[];
  loading: boolean;
  error: string | null;
}

type MemberRow = Pick<
  Database['public']['Tables']['workspace_members']['Row'],
  'user_id' | 'active'
>;

/** The distinct user ids of the active members, in row order. */
export function activeMemberIds(rows: readonly MemberRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.active === true) ids.add(row.user_id);
  }
  return [...ids];
}

/** The members failure line; the raw error goes to the logger only. */
export const MEMBERS_LOAD_FAILED = "Couldn't load members, try again";

/** The two reads, injected so the error mapping is unit-tested. */
export interface MemberReaders {
  members: () => Promise<Result<MemberRow[]>>;
  profiles: (userIds: string[]) => ReturnType<typeof readProfiles>;
}

/** Read the members then their profiles; a failure is the fixed copy, never raw text. */
export async function loadWorkspaceMembers(readers: MemberReaders): Promise<WorkspaceMembersState> {
  const members = await readers.members();
  if (!members.ok) {
    logger.warn('chat: members load failed', { error: members.error.message });
    return { options: [], loading: false, error: MEMBERS_LOAD_FAILED };
  }
  const profiles = await readers.profiles(activeMemberIds(members.data));
  if (!profiles.ok) {
    logger.warn('chat: member profiles load failed', { error: profiles.error.message });
    return { options: [], loading: false, error: MEMBERS_LOAD_FAILED };
  }
  return { options: toMemberOptions(profiles.data), loading: false, error: null };
}

/** Resolve the active workspace's members to picker options. */
export function useWorkspaceMembers(workspaceId: string): WorkspaceMembersState {
  const [state, setState] = useState<WorkspaceMembersState>({
    options: [],
    loading: true,
    error: null,
  });

  const load = useCallback(
    (): Promise<WorkspaceMembersState> =>
      loadWorkspaceMembers({
        members: () => listMembers(supabase, workspaceId),
        profiles: (userIds) => readProfiles(supabase, userIds),
      }),
    [workspaceId],
  );

  useEffect(() => {
    let cancelled = false;
    setState({ options: [], loading: true, error: null });
    void load().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  return state;
}
