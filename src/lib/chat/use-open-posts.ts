// The posts waiting in review for the open-loops strip and sheet. Opening a
// thread runs exactly two posts reads (the list and the head-only count), never
// one per render or per row. No realtime subscription: it refetches when a
// sorted:post-changed event fires (any post, since a post entering review is
// not in the list yet) and when the tab returns after more than a minute, the
// same rule the shared post cards follow. React-free pieces are exported so the
// query plan and the refetch triggers are unit tested without a DOM.

import { useEffect, useRef, useState } from 'react';
import type { Client, Result } from '@srtdio/rpc';
import {
  POST_CHANGED_EVENT,
  staleOnVisible,
  type FreshnessTargets,
} from '@/components/chat/post-card';
import { supabase } from '@/lib/supabase';
import { countOpenPosts, listOpenPosts, type OpenPostRow } from '../../../packages/posts/src/reads';

export type { OpenPostRow };

/** One settled fetch: the rows (null when the list read failed) and the count. */
export interface OpenPostsData {
  posts: OpenPostRow[] | null;
  count: number | null;
}

/** The injectable reads (tests pass fakes). */
export interface OpenPostsReads {
  list: (client: Client, input: { workspaceId: string }) => Promise<Result<OpenPostRow[]>>;
  count: (client: Client, input: { workspaceId: string }) => Promise<Result<number>>;
}

const READS: OpenPostsReads = { list: listOpenPosts, count: countOpenPosts };

/** One fetch: the list and the count, in parallel. Never throws. */
export async function fetchOpenPosts(
  client: Client,
  workspaceId: string,
  reads: OpenPostsReads = READS,
): Promise<OpenPostsData> {
  const [list, count] = await Promise.all([
    reads.list(client, { workspaceId }).catch(() => null),
    reads.count(client, { workspaceId }).catch(() => null),
  ]);
  const posts = list !== null && list.ok ? list.data : null;
  // A failed count falls back to the rows in hand (capped, but better than nothing).
  const n = count !== null && count.ok ? count.data : (posts?.length ?? null);
  return { posts, count: n };
}

/**
 * Refetch on any post-changed event, and on a tab returning visible more than
 * a minute after the last fetch. Returns the unsubscribe.
 */
export function watchOpenPosts(
  targets: FreshnessTargets,
  opts: { fetchedAt: () => number; now: () => number; refetch: () => void },
): () => void {
  const onVisibility = (): void => {
    if (targets.document.visibilityState !== 'visible') return;
    if (staleOnVisible(opts.fetchedAt(), opts.now())) opts.refetch();
  };
  const onChanged = (): void => opts.refetch();
  targets.document.addEventListener('visibilitychange', onVisibility);
  targets.window.addEventListener(POST_CHANGED_EVENT, onChanged);
  return () => {
    targets.document.removeEventListener('visibilitychange', onVisibility);
    targets.window.removeEventListener(POST_CHANGED_EVENT, onChanged);
  };
}

export interface UseOpenPosts extends OpenPostsData {
  /** The first fetch for this thread has settled (ok or not). */
  ready: boolean;
}

/**
 * Posts in review for the open thread. `threadKey` changes on a thread switch,
 * which refetches; the previous thread's data is kept (same workspace) so the
 * strip does not flash while the new read runs.
 */
export function useOpenPosts(
  workspaceId: string | null,
  threadKey: string,
  client: Client = supabase,
): UseOpenPosts {
  const [state, setState] = useState<{ workspaceId: string; data: OpenPostsData } | null>(null);
  const [tick, setTick] = useState(0);
  const fetchedAt = useRef(0);

  useEffect(() => {
    if (workspaceId === null) return;
    let cancelled = false;
    void fetchOpenPosts(client, workspaceId).then((data) => {
      if (cancelled) return;
      fetchedAt.current = Date.now();
      setState((prev) =>
        // A failed refetch keeps what was already on screen.
        prev !== null && prev.workspaceId === workspaceId && data.posts === null
          ? prev
          : { workspaceId, data },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, threadKey, tick]);

  useEffect(
    () =>
      watchOpenPosts(
        { window, document },
        {
          fetchedAt: () => fetchedAt.current,
          now: () => Date.now(),
          refetch: () => setTick((t) => t + 1),
        },
      ),
    [],
  );

  if (workspaceId === null) return { posts: null, count: null, ready: true };
  if (state === null || state.workspaceId !== workspaceId) {
    return { posts: null, count: null, ready: false };
  }
  return { ...state.data, ready: true };
}
