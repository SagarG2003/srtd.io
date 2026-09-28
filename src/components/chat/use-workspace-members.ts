// Loads the workspace's members as picker options, reusing the existing reads:
// @srtdio/workspace's listMembers (RLS-scoped workspace_members select) for the
// member ids and chat-reads' batched readProfiles for display name + avatar. No
// new DB read and no N+1: one membership read plus one batched profile read.
// Only active memberships become options, one per user (a user can hold an
// inactive row next to their active one).

import { useCallback, useEffect, useState } from 'react';
import { listMembers } from '@srtdio/workspace';
import type { Database } from '@srtdio/schemas';
import { supabase } from '@/lib/supabase';
import { readProfiles } from '@/lib/chat-reads';
import { toMemberOptions, type MemberOption } from '@/components/chat/member-picker';

interface WorkspaceMembersState {
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

/** Resolve the active workspace's members to picker options. */
export function useWorkspaceMembers(workspaceId: string): WorkspaceMembersState {
  const [state, setState] = useState<WorkspaceMembersState>({
    options: [],
    loading: true,
    error: null,
  });

  const load = useCallback(async (): Promise<WorkspaceMembersState> => {
    const members = await listMembers(supabase, workspaceId);
    if (!members.ok) return { options: [], loading: false, error: members.error.message };
    const userIds = activeMemberIds(members.data);
    const profiles = await readProfiles(supabase, userIds);
    if (!profiles.ok) return { options: [], loading: false, error: profiles.error.message };
    return { options: toMemberOptions(profiles.data), loading: false, error: null };
  }, [workspaceId]);

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
