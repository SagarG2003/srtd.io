// The posts waiting in review for the open-loops strip and sheet. Opening a
// thread runs exactly two posts reads (the list and the head-only count), never
// one per render or per row. No realtime subscription: it refetches when a
// sorted:post-changed event fires (any post, since a post entering review is
// not in the list yet) and when the tab returns after more than a minute, the
// same rule the shared post cards follow. One round is in flight at a time: a
// trigger during a round marks it dirty and exactly one more round follows.
// React-free pieces are exported so the query plan, the single-flight runner,
// the merge on failure and the refetch triggers are unit tested without a DOM.

import { useEffect, useRef, useState } from 'react';
import type { Client, Result } from '@srtdio/rpc';
import {
  POST_CHANGED_EVENT,
  staleOnVisible,
  type FreshnessTargets,
} from '@/components/chat/post-card';
import { withReadTimeout } from '@/lib/chat-reads';
import { supabase } from '@/lib/supabase';
import { countOpenPosts, listOpenPosts, type OpenPostRow } from '../../../packages/posts/src/reads';

export type { OpenPostRow };

/** One settled round: each read's result, null when that read failed. */
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

/**
 * One round: the list and the count, in parallel, each bounded at 5s (a hang
 * is that read failing, so the round always settles). Never throws.
 */
export async function fetchOpenPosts(
  client: Client,
  workspaceId: string,
  reads: OpenPostsReads = READS,
): Promise<OpenPostsData> {
  const [list, count] = await Promise.all([
    withReadTimeout(() => reads.list(client, { workspaceId })),
    withReadTimeout(() => reads.count(client, { workspaceId })),
  ]);
  return {
    posts: list.ok ? list.data : null,
    count: count.ok ? count.data : null,
  };
}

/** What the strip and sheet read. `failed`: the list has never been read here. */
export interface OpenPostsView {
  posts: OpenPostRow[] | null;
  count: number | null;
  failed: boolean;
}

/**
 * Fold one round into what is shown. A good list replaces everything (a failed
 * count falls back to the rows). A failed list keeps the previous rows and
 * takes a good count; with nothing before, it is `failed` so the strip never
 * claims "Nothing open" on a read it does not have.
 */
export function mergeOpenPosts(prev: OpenPostsView | null, next: OpenPostsData): OpenPostsView {
  if (next.posts !== null) {
    return { posts: next.posts, count: next.count ?? next.posts.length, failed: false };
  }
  if (prev !== null && !prev.failed) {
    return { posts: prev.posts, count: next.count ?? prev.count, failed: false };
  }
  return { posts: null, count: next.count ?? prev?.count ?? null, failed: true };
}

/**
 * Single-flight rounds for one key at a time. `request(key)` starts a round when
 * none is running; otherwise it records the key and marks the runner dirty, and
 * exactly one more round (for the latest key) runs once the current one
 * settles. A round's result is delivered only if its key is still the latest.
 * `fetchedAt` is the start of the latest round (never 0 once one has started).
 */
export function createOpenPostsRunner<K>(opts: {
  fetch: (key: K) => Promise<OpenPostsData>;
  onSettle: (key: K, data: OpenPostsData) => void;
  now: () => number;
}): {
  request: (key: K) => void;
  fetchedAt: () => number | null;
  dispose: () => void;
} {
  let latest: K | undefined;
  let inFlight = false;
  let dirty = false;
  let disposed = false;
  let startedAt: number | null = null;

  const run = (key: K): void => {
    inFlight = true;
    startedAt = opts.now();
    void opts
      .fetch(key)
      .then(
        (data) => {
          if (!disposed && latest === key) opts.onSettle(key, data);
        },
        () => undefined,
      )
      .finally(() => {
        inFlight = false;
        if (disposed || !dirty || latest === undefined) return;
        dirty = false;
        run(latest);
      });
  };

  return {
    request: (key) => {
      if (disposed) return;
      latest = key;
      if (inFlight) {
        dirty = true;
        return;
      }
      run(key);
    },
    fetchedAt: () => startedAt,
    dispose: () => {
      disposed = true;
    },
  };
}

/**
 * Refetch on any post-changed event, and on a tab returning visible more than
 * a minute after the latest round started (none started: no refetch, the
 * first round is still to come). Returns the unsubscribe.
 */
export function watchOpenPosts(
  targets: FreshnessTargets,
  opts: { fetchedAt: () => number | null; now: () => number; refetch: () => void },
): () => void {
  const onVisibility = (): void => {
    if (targets.document.visibilityState !== 'visible') return;
    const at = opts.fetchedAt();
    if (at !== null && staleOnVisible(at, opts.now())) opts.refetch();
  };
  const onChanged = (): void => opts.refetch();
  targets.document.addEventListener('visibilitychange', onVisibility);
  targets.window.addEventListener(POST_CHANGED_EVENT, onChanged);
  return () => {
    targets.document.removeEventListener('visibilitychange', onVisibility);
    targets.window.removeEventListener(POST_CHANGED_EVENT, onChanged);
  };
}

export interface UseOpenPosts extends OpenPostsView {
  /** This thread's first round has settled (ok or not). */
  ready: boolean;
}

/** The (workspace, thread) a round is for. */
function roundKey(workspaceId: string, threadKey: string): string {
  return `${workspaceId}\n${threadKey}`;
}

/**
 * Posts in review for the open thread. A thread switch (`threadKey`) is not
 * ready until the new thread's round settles; a failed round keeps what the
 * same workspace already showed (see {@link mergeOpenPosts}).
 */
export function useOpenPosts(
  workspaceId: string | null,
  threadKey: string,
  client: Client = supabase,
): UseOpenPosts {
  const [state, setState] = useState<{
    workspaceId: string;
    key: string;
    view: OpenPostsView;
  } | null>(null);
  const runnerRef = useRef<ReturnType<typeof createOpenPostsRunner<string>> | null>(null);
  const keyRef = useRef<string | null>(null);
  const key = workspaceId !== null ? roundKey(workspaceId, threadKey) : null;
  keyRef.current = key;

  // One runner per client; its rounds are keyed so a switch never overlaps them.
  useEffect(() => {
    const runner = createOpenPostsRunner<string>({
      fetch: (k) => fetchOpenPosts(client, k.slice(0, k.indexOf('\n'))),
      onSettle: (k, data) => {
        const ws = k.slice(0, k.indexOf('\n'));
        setState((prev) => ({
          workspaceId: ws,
          key: k,
          view: mergeOpenPosts(prev !== null && prev.workspaceId === ws ? prev.view : null, data),
        }));
      },
      now: () => Date.now(),
    });
    runnerRef.current = runner;
    const stop = watchOpenPosts(
      { window, document },
      {
        fetchedAt: runner.fetchedAt,
        now: () => Date.now(),
        refetch: () => {
          if (keyRef.current !== null) runner.request(keyRef.current);
        },
      },
    );
    return () => {
      stop();
      runner.dispose();
      runnerRef.current = null;
    };
  }, [client]);

  useEffect(() => {
    if (key !== null) runnerRef.current?.request(key);
  }, [key, client]);

  if (key === null) return { posts: null, count: null, failed: false, ready: true };
  if (state === null || state.key !== key) {
    return { posts: null, count: null, failed: false, ready: false };
  }
  return { ...state.view, ready: true };
}
