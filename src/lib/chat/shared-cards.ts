// One thread's shared post and brief cards, read in batches instead of once
// per bubble. Every card in a thread asks this cache for its ids; asks made in
// the same tick (a page of bubbles mounting, or the thread asking for every id
// across its loaded messages) coalesce into ONE posts read and ONE briefs read,
// chunked at 100 ids, each chunk bounded at 5s. The approvers of the posts
// read come back in ONE profile read. Ids already read or in flight are never
// asked again, so a new message only adds its missing ids. A failed or timed-
// out first read settles its ids as absent: the card shows its existing
// fallback ("not visible" / "Brief unavailable"), never a skeleton forever. A
// failed refresh keeps what is shown. Framework-free (readers injected), so the
// batching is unit-tested without React or a database.

import type { Result } from '@srtdio/rpc';
import { READ_TIMEOUT_MS, withReadTimeout, type ChatProfile } from '@/lib/chat-reads';

/** Ids per IN read (PostgREST URL length stays small). */
export const CARD_READ_CHUNK = 100;

/** The batched readers the cache runs; the app binds the existing readers. */
export interface SharedCardReaders<P, B> {
  /** One IN read of posts by id (readPostCards). Absent rows are not visible. */
  readPosts: (ids: string[]) => Promise<Result<P[]>>;
  /** One IN read of briefs by id (readBriefsByIds). Absent rows are unavailable. */
  readBriefs: (ids: string[]) => Promise<Result<B[]>>;
  /** One IN read of profiles (readProfiles), for the "Approved by" names. */
  readNames: (userIds: string[]) => Promise<Result<ChatProfile[]>>;
  postId: (post: P) => string;
  briefId: (brief: B) => string;
  /** The user ids a post's footer names (its approver). */
  approverIds: (posts: readonly P[]) => string[];
}

export interface SharedCardCacheOptions {
  /** Runs a flush after the current tick; defaults to queueMicrotask. */
  schedule?: (flush: () => void) => void;
  timeoutMs?: number;
  now?: () => number;
}

/** What a card with these post ids shows right now. */
export interface PostCardsSnapshot<P> {
  /** Some id has never settled (first read in flight): the card keeps its skeleton. */
  loading: boolean;
  /** The visible posts among the ids (absent = not visible, or the read failed). */
  posts: P[];
  /** Approver display names by user id. */
  names: Map<string, string>;
}

export interface BriefCardsSnapshot<B> {
  loading: boolean;
  briefs: B[];
}

export interface SharedCardCache<P, B> {
  /** Ask for these ids; only ids never read and not in flight are read. */
  request: (ids: { postIds?: readonly string[]; briefIds?: readonly string[] }) => void;
  /** Re-read these posts (post changed, tab back after a minute); current cards stay meanwhile. */
  refreshPosts: (ids: readonly string[]) => void;
  posts: (ids: readonly string[]) => PostCardsSnapshot<P>;
  briefs: (ids: readonly string[]) => BriefCardsSnapshot<B>;
  /** When these posts were last read (ms; 0 when never). */
  postsFetchedAt: (ids: readonly string[]) => number;
  /** React subscription (useSyncExternalStore): the listener runs after each applied read. */
  subscribe: (listener: () => void) => () => void;
  /** Bumped on every applied read; the snapshot key. */
  version: () => number;
  /** Channel or workspace switch, unmount: drop listeners, ignore every read in flight. */
  dispose: () => void;
}

function chunks(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += CARD_READ_CHUNK) {
    out.push(ids.slice(i, i + CARD_READ_CHUNK));
  }
  return out;
}

/** Run a chunked read, each chunk bounded; any failed chunk fails its own ids only. */
async function readChunked<T>(
  ids: readonly string[],
  read: (chunk: string[]) => Promise<Result<T[]>>,
  timeoutMs: number,
): Promise<Array<{ ids: string[]; result: Result<T[]> }>> {
  return Promise.all(
    chunks(ids).map(async (chunk) => ({
      ids: chunk,
      result: await withReadTimeout(() => read(chunk), timeoutMs),
    })),
  );
}

export function createSharedCardCache<P, B>(
  readers: SharedCardReaders<P, B>,
  options: SharedCardCacheOptions = {},
): SharedCardCache<P, B> {
  const schedule = options.schedule ?? ((flush: () => void) => queueMicrotask(flush));
  const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  /** Settled posts: the row, or null (not visible / first read failed). */
  const postRows = new Map<string, P | null>();
  const postReadAt = new Map<string, number>();
  const briefRows = new Map<string, B | null>();
  const names = new Map<string, string>();
  const namesAsked = new Set<string>();
  const inFlightPosts = new Set<string>();
  const inFlightBriefs = new Set<string>();
  let queuedPosts = new Set<string>();
  let queuedBriefs = new Set<string>();
  let scheduled = false;
  let disposed = false;
  let version = 0;
  const listeners = new Set<() => void>();

  function notify(): void {
    if (disposed) return;
    version += 1;
    for (const listener of [...listeners]) listener();
  }

  function kick(): void {
    if (scheduled || disposed) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      void flush();
    });
  }

  async function readPostBatch(ids: string[]): Promise<void> {
    for (const id of ids) inFlightPosts.add(id);
    const results = await readChunked(ids, readers.readPosts, timeoutMs);
    if (disposed) return;
    const found: P[] = [];
    for (const { ids: chunk, result } of results) {
      for (const id of chunk) inFlightPosts.delete(id);
      if (!result.ok) {
        // First read: settle as absent (the card's fallback). Refresh: keep.
        for (const id of chunk) if (!postRows.has(id)) postRows.set(id, null);
        continue;
      }
      const byId = new Map(result.data.map((row) => [readers.postId(row), row]));
      for (const id of chunk) {
        const row = byId.get(id) ?? null;
        postRows.set(id, row);
        postReadAt.set(id, now());
        if (row !== null) found.push(row);
      }
    }
    // One profile read for every approver not asked before (chunked, bounded).
    const approvers = [...new Set(readers.approverIds(found))].filter((id) => !namesAsked.has(id));
    if (approvers.length > 0) {
      for (const id of approvers) namesAsked.add(id);
      const named = await readChunked(approvers, readers.readNames, timeoutMs);
      if (disposed) return;
      for (const { ids: chunk, result } of named) {
        if (!result.ok) {
          // Unknown names fall back to the footer's date; a later read may ask again.
          for (const id of chunk) namesAsked.delete(id);
          continue;
        }
        for (const p of result.data) names.set(p.userId, p.displayName);
      }
    }
  }

  async function readBriefBatch(ids: string[]): Promise<void> {
    for (const id of ids) inFlightBriefs.add(id);
    const results = await readChunked(ids, readers.readBriefs, timeoutMs);
    if (disposed) return;
    for (const { ids: chunk, result } of results) {
      for (const id of chunk) inFlightBriefs.delete(id);
      if (!result.ok) {
        for (const id of chunk) if (!briefRows.has(id)) briefRows.set(id, null);
        continue;
      }
      const byId = new Map(result.data.map((row) => [readers.briefId(row), row]));
      for (const id of chunk) briefRows.set(id, byId.get(id) ?? null);
    }
  }

  async function flush(): Promise<void> {
    if (disposed) return;
    const posts = [...queuedPosts].filter((id) => !inFlightPosts.has(id));
    const briefs = [...queuedBriefs].filter((id) => !inFlightBriefs.has(id));
    queuedPosts = new Set();
    queuedBriefs = new Set();
    const work: Promise<void>[] = [];
    if (posts.length > 0) work.push(readPostBatch(posts).then(notify));
    if (briefs.length > 0) work.push(readBriefBatch(briefs).then(notify));
    await Promise.all(work);
  }

  return {
    request({ postIds = [], briefIds = [] }) {
      let added = false;
      for (const id of postIds) {
        if (id === '' || postRows.has(id) || inFlightPosts.has(id) || queuedPosts.has(id)) continue;
        queuedPosts.add(id);
        added = true;
      }
      for (const id of briefIds) {
        if (id === '' || briefRows.has(id) || inFlightBriefs.has(id) || queuedBriefs.has(id))
          continue;
        queuedBriefs.add(id);
        added = true;
      }
      if (added) kick();
    },
    refreshPosts(ids) {
      let added = false;
      for (const id of ids) {
        if (id === '' || inFlightPosts.has(id) || queuedPosts.has(id)) continue;
        queuedPosts.add(id);
        added = true;
      }
      if (added) kick();
    },
    posts(ids) {
      const posts: P[] = [];
      let loading = false;
      for (const id of ids) {
        if (!postRows.has(id)) {
          loading = true;
          continue;
        }
        const row = postRows.get(id);
        if (row != null) posts.push(row);
      }
      return { loading, posts, names };
    },
    briefs(ids) {
      const briefs: B[] = [];
      let loading = false;
      for (const id of ids) {
        if (!briefRows.has(id)) {
          loading = true;
          continue;
        }
        const row = briefRows.get(id);
        if (row != null) briefs.push(row);
      }
      return { loading, briefs };
    },
    postsFetchedAt(ids) {
      let oldest = Number.POSITIVE_INFINITY;
      for (const id of ids) oldest = Math.min(oldest, postReadAt.get(id) ?? 0);
      return Number.isFinite(oldest) ? oldest : 0;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
    dispose() {
      disposed = true;
      listeners.clear();
      queuedPosts.clear();
      queuedBriefs.clear();
    },
  };
}
