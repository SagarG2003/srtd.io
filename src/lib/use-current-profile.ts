// Reads the signed-in user's own profile row for the onboarding gate. Mirrors the
// direct-query pattern in src/components/comments/commentProfiles.ts
// (supabase.from('users').select(...).eq('id', userId).maybeSingle()), selecting
// exactly the columns the gate and the form need. Loading, error and loaded are
// three distinct states so the gate can fail open on a transient error instead of
// mistaking it for "profile not loaded yet" or "profile complete".
//
// One module-level store backs every useCurrentProfile() caller, so the header
// (AppLayout) and Settings render the same snapshot and a refetch() from any of
// them updates all. At most one read is in flight; mounts and refetches share it
// (a refetch during a read queues exactly one follow-up so it sees fresh data).
// The store is keyed by the auth user id: a snapshot for another user is never
// returned, so one user's profile cannot paint for the next user on this device.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/session-context';
import { SIGNOUT_EVENT } from '@/lib/events';
import { logger } from '@/lib/logger';

export interface CurrentProfile {
  display_name: string;
  designation: string | null;
  avatar_url: string | null;
  email_opt_in: boolean;
  profile_completed_at: string | null;
}

export interface UseCurrentProfile {
  profile: CurrentProfile | null;
  loading: boolean;
  error: boolean;
  refetch: () => void;
}

export interface ProfileSnapshot {
  userId: string | null;
  profile: CurrentProfile | null;
  loading: boolean;
  error: boolean;
}

/** No user, or a user whose row has not landed yet: hold in loading. */
const EMPTY: ProfileSnapshot = { userId: null, profile: null, loading: true, error: false };

let snapshot: ProfileSnapshot = EMPTY;
let inflight: Promise<void> | null = null;
let queued = false;
const listeners = new Set<() => void>();

function publish(next: ProfileSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function readProfile(userId: string): Promise<{ data: CurrentProfile | null; failed: boolean }> {
  return Promise.resolve(
    supabase
      .from('users')
      .select('display_name, designation, avatar_url, email_opt_in, profile_completed_at')
      .eq('id', userId)
      .maybeSingle(),
  ).then(
    ({ data, error: queryError }) => {
      if (queryError) {
        logger.error('useCurrentProfile load failed', { error: queryError.message });
      }
      if (queryError || data === null) return { data: null, failed: true };
      return { data: data as CurrentProfile, failed: false };
    },
    (thrown: unknown) => {
      logger.error('useCurrentProfile load failed', { error: String(thrown) });
      return { data: null, failed: true };
    },
  );
}

function startRead(userId: string): Promise<void> {
  const run = readProfile(userId).then(({ data, failed }) => {
    // The user changed (or signed out) mid-read: drop the stale result.
    if (snapshot.userId !== userId) return;
    if (failed) {
      // Keep the last good row; flag the failure the same way as before.
      publish({ userId, profile: snapshot.profile, loading: false, error: true });
    } else {
      publish({ userId, profile: data, loading: false, error: false });
    }
  });
  const tracked = run.finally(() => {
    if (inflight !== tracked) return;
    inflight = null;
    if (queued && snapshot.userId === userId) {
      queued = false;
      inflight = startRead(userId);
    }
    queued = false;
  });
  return tracked;
}

/** Drop everything held for the previous user. Synchronous. */
export function resetProfileStore(userId: string | null = null): void {
  inflight = null;
  queued = false;
  publish(userId === null ? EMPTY : { ...EMPTY, userId });
}

/**
 * Make sure a read for `userId` is running or has run. A different user resets
 * the store first. `force` (refetch) queues one follow-up read when one is
 * already in flight, so a read started before a write never wins.
 */
export function loadProfile(userId: string, force = false): Promise<void> {
  if (snapshot.userId !== userId) resetProfileStore(userId);
  if (inflight !== null) {
    if (force) queued = true;
    return inflight;
  }
  inflight = startRead(userId);
  return inflight;
}

export function getProfileSnapshot(): ProfileSnapshot {
  return snapshot;
}

function onSignout(): void {
  resetProfileStore(null);
}

export function subscribeProfile(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') {
    window.addEventListener(SIGNOUT_EVENT, onSignout);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener(SIGNOUT_EVENT, onSignout);
    }
  };
}

/**
 * What a caller signed in as `userId` may see. A snapshot held for any other
 * user renders as loading, so the switch is clean on the very first render,
 * before any effect has reset the store. Pure.
 */
export function profileViewFor(snap: ProfileSnapshot, userId: string | null): ProfileSnapshot {
  if (userId === null || snap.userId !== userId) return { ...EMPTY, userId };
  return snap;
}

export function useCurrentProfile(): UseCurrentProfile {
  const { session } = useSession();
  const userId = session?.user.id ?? null;

  const snap = useSyncExternalStore(subscribeProfile, getProfileSnapshot, getProfileSnapshot);

  useEffect(() => {
    if (userId === null) {
      // No session yet (or signed out): clear any previous user's row.
      if (getProfileSnapshot().userId !== null) resetProfileStore(null);
      return;
    }
    void loadProfile(userId);
  }, [userId]);

  const refetch = useCallback(() => {
    if (userId !== null) void loadProfile(userId, true);
  }, [userId]);

  const view = profileViewFor(snap, userId);
  return { profile: view.profile, loading: view.loading, error: view.error, refetch };
}
