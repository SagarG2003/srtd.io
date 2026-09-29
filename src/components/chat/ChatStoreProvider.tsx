// The always-on chat live layer. Mounted once at the shell (inside the Agora
// ChatProvider, the toast provider, and the router), it owns the chat roster and
// seeds the pure chat store from it plus Postgres (clears, chat_unread_counts
// for badges and ordering, one bounded scan for the preview lines), all read in
// parallel and applied in one update, then keeps it live off
// the controller's global incoming-message fan-out. Every live message is
// verified against its chat_messages row before it counts (the shared verifier
// logs a missing row once, for store and thread). Unread counts are re-read
// on open, on every reconnect, and 2s after the last incoming live message, so
// Postgres stays the truth for the badge. The provider also owns the
// per-channel outbox and its background sender (send-flow.ts): sends record and
// publish here, retry with backoff (and at once on reconnect, tab visible and
// online), persist to localStorage for this workspace and user so a reload
// resumes them, and are wiped from storage on sign-out. A channel switch or
// leaving the chat page never drops a sending or failed bubble. A message for a
// conversation the user is not viewing fires a toast and stays unread; a message for the open
// conversation is marked read locally (the thread writes the cursor). All store
// mutation lives in the pure reducer (chat-store.ts); this file only wires that
// reducer to Agora, Postgres, React, and the toast surface.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AgoraChat } from 'agora-chat';
import type { Result } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/Avatar';
import {
  listChannelClears,
  listChannelSummaries,
  readProfiles,
  type ChannelSummary,
  type ChatProfile,
} from '@/lib/chat-reads';
import {
  knownMentionName,
  mentionIds,
  rememberMentionNames,
  resolveMentionText,
} from '@/lib/chat/mentions';
import { SIGNOUT_EVENT } from '@/lib/events';
import { stripDeletedReplies } from '@/lib/chat/drafts';
import { leaveSelectionThen } from '@/lib/chat/forward';
import { generateTraceId } from '@/lib/trace';
import { useChat } from '@/lib/chat/chat-context';
import { createTextMessage } from '@/lib/chat/message-factory';
import { sendMessageRecord } from '@/lib/chat/record';
import { createOutboxSender, runSend, type OutboxSender } from '@/lib/chat/send-flow';
import {
  mapLiveTextMessage,
  parseLiveEvent,
  sendText,
  targetFromSummary,
  type ChannelTarget,
  type ChatMessageRow,
  type ThreadConnection,
} from '@/lib/chat/thread';
import { liveVerifierFor } from '@/lib/chat/live-verify';
import { subscribeGlobalCmds, subscribeGlobalMessages } from '@/lib/chat/controller';
import {
  loadConversationPreviews,
  loadMessagesByIds,
  loadUnreadCounts,
  type ConversationPreview,
  type UnreadCount,
} from '@/lib/chat/history';
import { createDebouncer, UNREAD_REFRESH_DEBOUNCE_MS } from '@/lib/chat/read-cursor';
import * as store from '@/lib/chat/chat-store';
import type {
  ChannelClear,
  ChannelOutbox,
  ChatLoadStatus,
  ChatStoreState,
  OutboxEvent,
  OutboxStorage,
} from '@/lib/chat/chat-store';

/** The store plus the actions the chat UI uses to keep it in step. */
export interface ChatStoreContextValue {
  state: ChatStoreState;
  /** The list's load status for the current workspace; rows render only when 'ready'. */
  loadStatus: ChatLoadStatus;
  /** The current workspace's channels; empty unless loadStatus is 'ready'. */
  roster: readonly ChannelSummary[];
  /** Re-run the first load after an error (Retry). */
  retryLoad: () => void;
  /** Re-read the roster after a mutation; resolves to it, or null when the read failed. */
  reloadRoster: () => Promise<readonly ChannelSummary[] | null>;
  /** Sum of unread across every channel; the Chat-tab badge reads this. */
  totalUnread: number;
  /** Mark the viewed channel (its incoming messages stay read), or clear it. */
  setActive: (channelId: string | null) => void;
  /** Zero a channel's unread locally (the thread records the read cursor). */
  markConversationRead: (channelId: string) => void;
  /** Refresh a channel's last line after a recorded own send ('You: ...'). */
  updateOwnMessage: (channelId: string, text: string, ts: number) => void;
  /** Re-read chat_unread_counts now (after a catch-up). */
  refreshUnreadCounts: () => void;
  /** Re-read the last-line previews (after messages were deleted for everyone). */
  refreshPreviews: () => void;
  /** Ask the chat page to open a channel (consumed via pendingOpenConversationId). */
  requestOpen: (channelId: string) => void;
  /** Clear the pending-open request once the chat page has acted on it. */
  clearPendingOpen: () => void;
  /** Unrecorded own sends per channel and their background sender; survives channel switches. */
  outbox: ChannelOutbox;
  /**
   * The chat was deleted for the caller (chat_channel_clear accepted): record the
   * clear time, empty its card and drop its unrecorded sends.
   */
  clearConversation: (channelId: string, clearedAtMs: number) => void;
}

const ChatStoreContext = createContext<ChatStoreContextValue | null>(null);

/** Stable empty roster while the list is not ready. */
const EMPTY_ROSTER: readonly ChannelSummary[] = [];

/** Bound on the live-message ids remembered for dedupe. */
const SEEN_IDS_LIMIT = 500;

/** Bound on the deleted message ids remembered for stripping queued quotes. */
const DELETED_IDS_LIMIT = 500;

function indexSummaries(roster: readonly ChannelSummary[]): Map<string, ChannelSummary> {
  const map = new Map<string, ChannelSummary>();
  for (const summary of roster) {
    map.set(summary.channelId, summary);
  }
  return map;
}

/** localStorage, or null where reading it throws (blocked storage, private mode). */
function browserStorage(): OutboxStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** A channel's Agora target for the live publish; a bad row yields none (the record still holds it). */
function liveTarget(summary: ChannelSummary | undefined): ChannelTarget | null {
  if (summary === undefined) return null;
  try {
    return targetFromSummary(summary);
  } catch {
    return null;
  }
}

/** Remember a live message id; true when it was already seen. Bounded FIFO. */
export function rememberSeen(
  seen: Set<string>,
  id: string,
  limit: number = SEEN_IDS_LIMIT,
): boolean {
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > limit) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return false;
}

/** What handling a tombstone signal touches, injected so the order is unit-tested. */
export interface DeletedSignalDeps {
  /** The channels whose list line shows one of the ids (store.channelsShowingDeleted). */
  channelsShowing: (messageIds: readonly string[]) => string[];
  /** One batched preview read (the existing reader), applied to just these channels. */
  rereadPreviews: (channelIds: readonly string[]) => void;
  /** Strip draft replies that quote the ids (drafts.stripDeletedReplies). */
  stripDrafts: (messageIds: readonly string[]) => void;
  /** Clear the quote text of queued sends that quote the ids (persisted outbox). */
  stripOutbox: (messageIds: readonly string[]) => void;
}

/**
 * Messages became tombstones, in any channel: strip them from draft replies and
 * the queued outbox, and re-read the list lines that showed one, all in one
 * preview read however many channels are hit (none when no line showed one).
 */
export function handleMessagesDeleted(
  deps: DeletedSignalDeps,
  messageIds: readonly string[],
): void {
  if (messageIds.length === 0) return;
  deps.stripDrafts(messageIds);
  deps.stripOutbox(messageIds);
  const channels = deps.channelsShowing(messageIds);
  if (channels.length > 0) deps.rereadPreviews(channels);
}

/** What routing a global command needs, injected so the trust check is unit-tested. */
export interface GlobalCmdDeps {
  /** One batched read of the named rows (loadMessagesByIds). */
  loadByIds: (messageIds: readonly string[]) => Promise<Result<ChatMessageRow[]>>;
  /** The ids whose rows are tombstones on record. */
  onDeleted: (messageIds: readonly string[]) => void;
}

/**
 * A live command for any channel (the global fan-out). The payload alone is
 * never trusted: a delete signal's ids are re-read in one batched read and only
 * rows whose deleted_at is set reach the tombstone handler; ids not found or
 * not deleted are ignored. Every other command is the open thread's business.
 */
export async function routeGlobalCmd(ext: unknown, deps: GlobalCmdDeps): Promise<void> {
  const event = parseLiveEvent(ext);
  if (event.kind !== 'delete' || event.messageIds.length === 0) return;
  const claimed = new Set(event.messageIds);
  const result = await deps.loadByIds([...claimed]);
  if (!result.ok) {
    logger.warn('chat store: delete signal verification failed, ignored', {
      error: result.error.message,
    });
    return;
  }
  const deleted = result.data
    .filter((row) => claimed.has(row.id) && row.deleted_at !== null)
    .map((row) => row.id);
  if (deleted.length > 0) deps.onDeleted(deleted);
}

/** A body with @[uuid] tokens as list text: "@Name" (the registry's names). */
export function previewMentionText(text: string): string {
  return resolveMentionText(text, knownMentionName);
}

/**
 * Make sure every @mention in these bodies has a remembered name: one batched
 * profile read for the ids not known yet (none when all are). A failed read is
 * logged; those mentions then read "@Unknown member", never a raw token.
 */
export async function rememberBodyNames(
  bodies: readonly string[],
  readNames: (ids: string[]) => Promise<Result<ChatProfile[]>>,
): Promise<void> {
  const ids = [...new Set(bodies.flatMap(mentionIds))].filter(
    (id) => knownMentionName(id) === undefined,
  );
  if (ids.length === 0) return;
  const result = await readNames(ids);
  if (!result.ok) {
    logger.warn('chat store: mention names read failed', { error: result.error.message });
    return;
  }
  rememberMentionNames(result.data);
}

/**
 * The previews with their mentions resolved to "@Name", after one batched name
 * read, so the list's first paint is final. A failed preview read passes through.
 */
export async function resolvePreviewMentions(
  previews: Result<ConversationPreview[]>,
  readNames: (ids: string[]) => Promise<Result<ChatProfile[]>>,
): Promise<Result<ConversationPreview[]>> {
  if (!previews.ok) return previews;
  await rememberBodyNames(
    previews.data.map((p) => p.body),
    readNames,
  );
  return {
    ok: true,
    data: previews.data.map((p) => ({ ...p, body: previewMentionText(p.body) })),
  };
}

/** The last-line previews with their mention names resolved. */
function readPreviews(workspaceId: string): Promise<Result<ConversationPreview[]>> {
  return loadConversationPreviews(supabase, workspaceId).then((result) =>
    resolvePreviewMentions(result, (ids) => readProfiles(supabase, ids)),
  );
}

/** The four reads the chat list's first paint waits on. */
export interface ChatListReaders {
  roster: () => Promise<Result<ChannelSummary[]>>;
  clears: () => Promise<Result<ChannelClear[]>>;
  previews: () => Promise<Result<ConversationPreview[]>>;
  counts: () => Promise<Result<UnreadCount[]>>;
}

/**
 * Run the four list reads in parallel and resolve to the one store transition
 * that applies them all ('ready'), or to 'error' when any of them failed.
 */
export async function loadChatList(
  readers: ChatListReaders,
  scope: string,
  currentUserId: string,
): Promise<(prev: ChatStoreState) => ChatStoreState> {
  const [roster, clears, previews, counts] = await Promise.all([
    readers.roster(),
    readers.clears(),
    readers.previews(),
    readers.counts(),
  ]);
  if (!roster.ok || !clears.ok || !previews.ok || !counts.ok) {
    logger.error('chat store: initial load failed', {
      roster: roster.ok ? 'ok' : roster.error.message,
      clears: clears.ok ? 'ok' : clears.error.message,
      previews: previews.ok ? 'ok' : previews.error.message,
      counts: counts.ok ? 'ok' : counts.error.message,
    });
    return (prev) => store.loadFailed(prev, scope);
  }
  return (prev) =>
    store.loadReady(prev, {
      scope,
      roster: roster.data,
      clears: clears.data,
      previews: previews.data,
      counts: counts.data,
      currentUserId,
    });
}

export function ChatStoreProvider({ children }: { children: ReactNode }): ReactElement {
  const { status, client } = useChat();
  const { session } = useSession();
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const navigate = useNavigate();
  const currentUserId = session?.user.id ?? null;

  const [state, setState] = useState<ChatStoreState>(store.initialState);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const scope =
    workspaceId && currentUserId !== null ? store.loadScope(workspaceId, currentUserId) : null;

  // The live handler reads these refs so the global subscription registers once
  // and never goes stale: roster summaries, the active channel, and the ids
  // already folded in.
  const summariesRef = useRef<Map<string, ChannelSummary>>(new Map());
  const activeRef = useRef<string | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const clientRef = useRef(client);
  clientRef.current = client;
  const senderRef = useRef<OutboxSender | null>(null);
  const outboxListenersRef = useRef<Set<(event: OutboxEvent) => void>>(new Set());
  // Latest store state for the tombstone handler (it runs outside render).
  const stateRef = useRef(state);
  stateRef.current = state;
  // Deleted ids whose quotes queued sends must not persist (bounded FIFO).
  const deletedIdsRef = useRef<Set<string>>(new Set());
  const onMessagesDeletedRef = useRef<(messageIds: readonly string[]) => void>(() => {});
  // Which record attempts may sample the server clock (session-wide).
  const clockSamplerRef = useRef<store.ClockSampler>(store.createClockSampler());
  // Stable facade over the current sender, which is replaced per workspace/user.
  const outbox = useMemo<ChannelOutbox>(
    () => ({
      entries: (channelId) => senderRef.current?.entries(channelId) ?? [],
      enqueue: (channelId, entry) => {
        clockSamplerRef.current.fresh(entry.id);
        senderRef.current?.enqueue(channelId, entry);
      },
      retry: (channelId, id) => senderRef.current?.retry(channelId, id),
      settle: (channelId, id) => senderRef.current?.settle(channelId, id),
      subscribe: (listener) => {
        const listeners = outboxListenersRef.current;
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      messagesDeleted: (messageIds) => onMessagesDeletedRef.current(messageIds),
    }),
    [],
  );

  useEffect(() => {
    activeRef.current = state.activeConversationId;
  }, [state.activeConversationId]);

  // The live handler resolves channels from the store's roster, so a channel
  // created after the first load (new DM or group) counts too.
  useEffect(() => {
    summariesRef.current = indexSummaries(state.roster);
  }, [state.roster]);

  const setActive = useCallback((channelId: string | null) => {
    setState((prev) => store.setActive(prev, channelId));
  }, []);

  const markConversationRead = useCallback((channelId: string) => {
    setState((prev) => store.markRead(prev, channelId));
  }, []);

  const updateOwnMessage = useCallback((channelId: string, text: string, ts: number) => {
    const line = previewMentionText(text);
    setState((prev) => store.updateOwnMessage(prev, { channelId, text: line, ts }));
  }, []);

  const clearConversation = useCallback((channelId: string, clearedAtMs: number) => {
    senderRef.current?.dropChannel(channelId);
    setState((prev) => store.applyClear(prev, channelId, clearedAtMs));
  }, []);

  const requestOpen = useCallback((channelId: string) => {
    setState((prev) => store.requestOpen(prev, channelId));
  }, []);

  const clearPendingOpen = useCallback(() => {
    setState((prev) => store.clearPendingOpen(prev));
  }, []);

  // Refreshes after the first load; a response for a workspace the store has
  // moved on from is dropped.
  const refreshUnreadCounts = useCallback(() => {
    if (scope === null || workspaceId === null) return;
    void loadUnreadCounts(supabase, workspaceId).then((result) => {
      if (!result.ok) {
        logger.warn('chat store: unread counts load failed', { error: result.error.message });
        return;
      }
      setState((prev) =>
        prev.scope === scope ? store.applyUnreadCounts(prev, result.data) : prev,
      );
    });
  }, [scope, workspaceId]);

  const refreshPreviews = useCallback(() => {
    if (scope === null || workspaceId === null || currentUserId === null) return;
    const forUser = currentUserId;
    void readPreviews(workspaceId).then((result) => {
      if (!result.ok) {
        logger.warn('chat store: previews load failed', { error: result.error.message });
        return;
      }
      setState((prev) =>
        prev.scope === scope ? store.applyPreviews(prev, result.data, forUser) : prev,
      );
    });
  }, [scope, workspaceId, currentUserId]);

  // Messages became tombstones: drafts, the queued outbox and the list lines
  // that showed one. The re-read is one preview scan for every hit channel.
  // The open thread and the global cmd fan-out both report a live delete; ids
  // already handled are skipped so the line is re-read once.
  onMessagesDeletedRef.current = (reported) => {
    const messageIds = reported.filter((id) => !deletedIdsRef.current.has(id));
    handleMessagesDeleted(
      {
        channelsShowing: (ids) => store.channelsShowingDeleted(stateRef.current, ids),
        rereadPreviews: (channelIds) => {
          if (scope === null || workspaceId === null || currentUserId === null) return;
          const forUser = currentUserId;
          void readPreviews(workspaceId).then((result) => {
            if (!result.ok) {
              logger.warn('chat store: previews load failed', { error: result.error.message });
              return;
            }
            setState((prev) =>
              prev.scope === scope
                ? store.applyChannelPreviews(prev, channelIds, result.data, forUser)
                : prev,
            );
          });
        },
        stripDrafts: stripDeletedReplies,
        stripOutbox: (ids) => {
          for (const id of ids) rememberSeen(deletedIdsRef.current, id, DELETED_IDS_LIMIT);
          store.stripPersistedQuotes(browserStorage(), ids);
        },
      },
      messageIds,
    );
  };

  // Seed the store on workspace/user switch (and on Retry): the roster, clears,
  // previews and unread counts are read in parallel and applied in one update,
  // so the list's first paint is its final state. Any failure is the error
  // state. Independent of the Agora connection: the list and badges work while
  // chat is still connecting.
  useEffect(() => {
    if (scope === null || !workspaceId || currentUserId === null) return;
    let cancelled = false;
    seenRef.current = new Set();
    setState((prev) => store.beginLoad(prev, scope));
    void loadChatList(
      {
        roster: () => listChannelSummaries(supabase, { workspaceId, currentUserId }),
        clears: () => listChannelClears(supabase, { workspaceId }),
        previews: () => readPreviews(workspaceId),
        counts: () => loadUnreadCounts(supabase, workspaceId),
      },
      scope,
      currentUserId,
    ).then((transition) => {
      if (!cancelled) setState(transition);
    });
    return () => {
      cancelled = true;
    };
  }, [scope, workspaceId, currentUserId, loadAttempt]);

  const retryLoad = useCallback(() => setLoadAttempt((n) => n + 1), []);

  const reloadRoster = useCallback(async (): Promise<readonly ChannelSummary[] | null> => {
    if (scope === null || !workspaceId || currentUserId === null) return null;
    const result = await listChannelSummaries(supabase, { workspaceId, currentUserId });
    if (!result.ok) {
      logger.error('chat store: roster reload failed', { error: result.error.message });
      return null;
    }
    setState((prev) => (prev.scope === scope ? store.applyRoster(prev, result.data) : prev));
    return result.data;
  }, [scope, workspaceId, currentUserId]);

  // One background sender per workspace and user, seeded from this scope's
  // persisted outbox. Teardown (workspace switch, sign-out, unmount) clears its
  // timers and ignores every answer still in flight; sign-out also wipes the
  // persisted bodies.
  useEffect(() => {
    if (!workspaceId || currentUserId === null) return;
    const scopeKey = { workspaceId, userId: currentUserId };
    const storage = browserStorage();
    // Persisted sends are replays (never marked fresh): their acks carry the
    // original created_at.
    const persisted = store.readPersistedOutbox(storage, scopeKey);
    const clockSampler = clockSamplerRef.current;
    const sender = createOutboxSender(
      {
        deliver: (channelId, entry, traceId, onRecorded) => {
          const connection = clientRef.current;
          const target = liveTarget(summariesRef.current.get(channelId));
          return runSend(
            {
              // The ack's server created_at against the device time of the
              // send sets the server clock offset (the edit / delete windows).
              // Only the first attempt of an id queued in this session samples
              // it; its ack or failure ends that.
              recordMessage: (input) => {
                const sentAt = clockSampler.begin(input.id);
                return sendMessageRecord({ client: supabase, ...input }).then((result) => {
                  clockSampler.settled(input.id);
                  if (result.ok && sentAt !== null) {
                    const createdAt = result.row.created_at;
                    setState((prev) => store.applyServerClock(prev, createdAt, sentAt));
                  }
                  return result;
                });
              },
              publishLive:
                connection !== null && target !== null
                  ? (input) =>
                      sendText({
                        connection: connection as ThreadConnection,
                        target,
                        text: input.text,
                        attachments: input.local.attachments,
                        sharedPostIds: input.local.sharedPostIds,
                        reply: input.local.reply,
                        createMessage: createTextMessage,
                        liveIds: {
                          sorted_message_id: input.id,
                          sorted_channel_id: input.channelId,
                        },
                      })
                  : undefined,
              // The row exists; receivers catch up from Postgres.
              onLiveWarning: (context) =>
                logger.warn('chat: live publish did not complete', context),
              onRecorded,
            },
            {
              id: entry.id,
              channelId,
              currentUserId: scopeKey.userId,
              traceId,
              text: entry.text,
              local: entry.local,
            },
          );
        },
        newTraceId: generateTraceId,
        onEvent: (event) => {
          // The row exists: the list card shows 'You: ...', whatever page is open.
          if (event.type === 'recorded') {
            const { channelId, message } = event;
            setState((prev) =>
              store.updateOwnMessage(prev, {
                channelId,
                messageId: message.id,
                text: previewMentionText(message.body),
                ts: message.time,
              }),
            );
          }
          for (const listener of outboxListenersRef.current) listener(event);
        },
        // A queued send quoting a deleted message never persists its quote text.
        onChange: (next) =>
          store.writePersistedOutbox(
            storage,
            scopeKey,
            store.stripDeletedQuotes(next, deletedIdsRef.current),
          ),
        onAttemptFailed: (context) => logger.warn('chat: message record attempt failed', context),
      },
      persisted,
    );
    senderRef.current = sender;
    const kick = (): void => sender.kick();
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') kick();
    };
    const onSignout = (): void => {
      sender.dispose();
      store.clearPersistedOutbox(storage);
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', kick);
    window.addEventListener(SIGNOUT_EVENT, onSignout);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', kick);
      window.removeEventListener(SIGNOUT_EVENT, onSignout);
      sender.dispose();
      if (senderRef.current === sender) senderRef.current = null;
    };
  }, [workspaceId, currentUserId]);

  // Every (re)connect re-reads the counts (live messages missed while offline
  // are already in Postgres) and retries any queued send at once.
  const previousStatusRef = useRef(status);
  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = status;
    if (status !== 'connected' || previous === 'connected') return;
    refreshUnreadCounts();
    senderRef.current?.kick();
  }, [status, refreshUnreadCounts]);

  // Debounced reconcile after live traffic (2s after the last incoming message).
  const refreshRef = useRef(refreshUnreadCounts);
  refreshRef.current = refreshUnreadCounts;
  const debouncedRefresh = useMemo(
    () => createDebouncer<null>(() => refreshRef.current(), UNREAD_REFRESH_DEBOUNCE_MS),
    [],
  );
  useEffect(() => () => debouncedRefresh.cancel(), [debouncedRefresh]);

  // Latest incoming-message logic, held in a ref so the global subscription
  // below registers exactly once yet always runs the current closure.
  const onIncomingRef = useRef<(message: AgoraChat.TextMsgBody) => void>(() => {});
  onIncomingRef.current = (raw) => {
    if (currentUserId === null) return;
    const mapped = mapLiveTextMessage(raw, currentUserId);
    if (!mapped.ok) {
      logger.warn('chat store: live message without sorted ids ignored', { agora_id: raw.id });
      return;
    }
    if (mapped.message.mine) return;
    if (rememberSeen(seenRef.current, mapped.message.id)) return;
    const forUser = currentUserId;
    // Only a row the caller can read counts: badge, preview and toast all come
    // from the verified row, never from the Agora payload.
    void liveVerifierFor(supabase)
      .verify(mapped.message.id)
      .then(async (lookup) => {
        if (!lookup.found) return;
        const row = lookup.row;
        if (row.sender_user_id === forUser) return;
        const summary = summariesRef.current.get(row.channel_id);
        if (summary === undefined) return;
        // Names first (one batched read for unknown ids), so the line and the
        // toast read "@Name" from their first paint.
        await rememberBodyNames([row.body ?? ''], (ids) => readProfiles(supabase, ids));
        const text = store.previewText({
          body: previewMentionText(row.body ?? ''),
          hasAttachments:
            (row.attachment_asset_ids ?? []).length > 0 ||
            (row.shared_post_ids ?? []).length > 0 ||
            (row.shared_brief_ids ?? []).length > 0,
        });
        const ts = Date.parse(row.created_at);
        setState((prev) =>
          store.applyIncoming(prev, {
            channelId: row.channel_id,
            messageId: row.id,
            senderIsSelf: false,
            text,
            ts: Number.isNaN(ts) ? mapped.message.time : ts,
          }),
        );
        debouncedRefresh.schedule(null);

        if (row.channel_id === activeRef.current) return;
        toast.show({
          title: summary.title,
          description: text,
          icon: (
            <Avatar
              name={summary.title}
              size="sm"
              {...(summary.avatarUrl !== null ? { src: summary.avatarUrl } : {})}
            />
          ),
          // A thread selecting messages exits that first (history.back()).
          onPress: () =>
            leaveSelectionThen(() => {
              requestOpen(row.channel_id);
              navigate('/chat');
            }),
        });
      });
  };

  useEffect(() => subscribeGlobalMessages((message) => onIncomingRef.current(message)), []);
  // A delete signal for any chat, open or not, strips its drafts, queued quotes
  // and list line once its rows read back deleted (the open thread also turns
  // the rows into tombstones itself).
  useEffect(
    () =>
      subscribeGlobalCmds((message) => {
        void routeGlobalCmd(message.ext, {
          loadByIds: (ids) => loadMessagesByIds(supabase, ids),
          onDeleted: (ids) => onMessagesDeletedRef.current(ids),
        });
      }),
    [],
  );

  const loadStatus = store.selectLoadStatus(state, scope);
  const roster = loadStatus === 'ready' ? state.roster : EMPTY_ROSTER;
  const value = useMemo<ChatStoreContextValue>(
    () => ({
      state,
      loadStatus,
      roster,
      retryLoad,
      reloadRoster,
      totalUnread: store.selectTotalUnread(state),
      setActive,
      markConversationRead,
      updateOwnMessage,
      refreshUnreadCounts,
      refreshPreviews,
      requestOpen,
      clearPendingOpen,
      outbox,
      clearConversation,
    }),
    [
      loadStatus,
      roster,
      retryLoad,
      reloadRoster,
      outbox,
      clearConversation,
      state,
      setActive,
      markConversationRead,
      updateOwnMessage,
      refreshUnreadCounts,
      refreshPreviews,
      requestOpen,
      clearPendingOpen,
    ],
  );

  return <ChatStoreContext.Provider value={value}>{children}</ChatStoreContext.Provider>;
}

/**
 * Server time now: the device clock plus the store's server clock offset (0
 * outside a provider or before the first own-send ack). The edit and delete
 * windows read this, never Date.now() alone.
 */
export function useServerNow(): () => number {
  const offset = useContext(ChatStoreContext)?.state.serverClockOffsetMs ?? 0;
  return useCallback(() => Date.now() + offset, [offset]);
}

export function useChatStore(): ChatStoreContextValue {
  const ctx = useContext(ChatStoreContext);
  if (ctx === null) {
    throw new Error('useChatStore must be used within a ChatStoreProvider');
  }
  return ctx;
}
