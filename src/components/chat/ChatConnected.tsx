import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { useMediaQuery } from '@/lib/use-media-query';
import { useWorkspace } from '@/lib/workspace-context';
import {
  listGroupMemberIds,
  readProfiles,
  type ChannelSummary,
  type ChatProfile,
} from '@/lib/chat-reads';
import { targetFromSummary, type ChannelTarget, type ThreadMessage } from '@/lib/chat/thread';
import { generateTraceId } from '@/lib/trace';
import { clearChannelRecord } from '@/lib/chat/record';
import { runClearChannels, type ClearRunResult } from '@/lib/chat/clear-flow';
import { workspaceTimeZone } from '@/lib/chat/time-format';
import { useChatThread } from '@/lib/chat/use-chat-thread';
import { useChatMarks } from '@/lib/chat/use-chat-marks';
import { useChatTyping } from '@/lib/chat/use-chat-typing';
import { visibleTypingIds } from '@/lib/chat/typing';
import { useChatPresence } from '@/lib/chat/use-chat-presence';
import { useChatStore } from '@/components/chat/ChatStoreProvider';
import type { ChatConnection, ChatStatus } from '@/lib/chat/types';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconChat } from '@/components/ui/icons';
import { ChannelList } from '@/components/chat/ChannelList';
import { MessageThread } from '@/components/chat/MessageThread';
import { NewChatSheet } from '@/components/chat/NewChatSheet';
import { GroupInfoSheet } from '@/components/chat/GroupInfoSheet';
import { leaveSelectionThen } from '@/lib/chat/forward';
import { startDmChannel } from '@/components/chat/chat-actions';
import { useChannelMembers } from '@/components/chat/use-channel-members';
import { knownMentionName, mentionIds, rememberMentionNames } from '@/lib/chat/mentions';
import { useToast } from '@/components/ui/toast';
import type { Result } from '@srtdio/rpc';

interface ChatConnectedProps {
  client: ChatConnection | null;
  status: ChatStatus;
  workspaceId: string;
  currentUserId: string;
}

const DESKTOP_QUERY = '(min-width: 768px)';

const NO_MESSAGES: ThreadMessage[] = [];

/** The toast when opening a DM from a mention fails; the raw error is only logged. */
export const MENTION_DM_FAILED = "Couldn't open that chat, try again";

/**
 * The user ids a thread's first paint needs names for: every sender, the DM
 * peer, and every @mention in a body or a reply quote, minus the ones already
 * held. One batched read covers them all (no per-token fetch). Pure.
 */
export function profileIdsNeeded(
  messages: readonly ThreadMessage[],
  peerUserId: string | null,
  held: ReadonlyMap<string, unknown>,
): string[] {
  const needed = new Set<string>();
  const add = (id: string | null): void => {
    if (id !== null && !held.has(id)) needed.add(id);
  };
  for (const message of messages) {
    add(message.senderUserId);
    for (const id of rowNameIds(message)) add(id);
  }
  add(peerUserId);
  return [...needed];
}

/**
 * Where the thread's profile reads left each id they asked about. `unknown`:
 * a read succeeded without it (an ex-member); it renders "@Unknown member" for
 * good and is never read again. `failed`: its last read failed; it renders
 * "@Unknown member" inert for now and rides along on the next read.
 */
export interface NameReads {
  unknown: ReadonlySet<string>;
  failed: ReadonlySet<string>;
}

export const NO_NAME_READS: NameReads = { unknown: new Set(), failed: new Set() };

/** The ids a row's first paint names: its @mentions, its quote's author and the quote's @mentions. */
export function rowNameIds(message: ThreadMessage): string[] {
  const ids = mentionIds(message.body);
  if (message.reply !== null) {
    if (message.reply.authorUserId !== null) ids.push(message.reply.authorUserId);
    ids.push(...mentionIds(message.reply.preview));
  }
  return ids;
}

/**
 * The rows that may paint: each id a row names is known, or its read settled
 * (unknown or failed). A row still waiting on a read is held back, so a live
 * row or an older page never paints "@Unknown member" and then changes. The
 * same array comes back when nothing is held. Pure.
 */
export function paintableMessages(
  messages: ThreadMessage[],
  isKnown: (userId: string) => boolean,
  reads: NameReads,
): ThreadMessage[] {
  const settled = (id: string): boolean =>
    isKnown(id) || reads.unknown.has(id) || reads.failed.has(id);
  const held = messages.filter((m) => !rowNameIds(m).every(settled));
  if (held.length === 0) return messages;
  return messages.filter((m) => !held.includes(m));
}

/**
 * The ids the next batched read asks for: every needed id never read (and not
 * in flight), plus, alongside them, the ones whose last read failed (a retry).
 * Empty when nothing new is needed, so a failure never loops. Pure.
 */
export function idsToRead(
  needed: readonly string[],
  reads: NameReads,
  inFlight: ReadonlySet<string>,
): string[] {
  const fresh = needed.filter(
    (id) => !reads.unknown.has(id) && !reads.failed.has(id) && !inFlight.has(id),
  );
  if (fresh.length === 0) return [];
  const retry = [...reads.failed].filter((id) => !inFlight.has(id) && !fresh.includes(id));
  return [...fresh, ...retry];
}

/**
 * Fold one read's outcome in. Success: the ids it did not return are unknown
 * (ex-members) and none of the asked ids stays failed. Failure: the asked ids
 * are failed, never unknown, so the next read retries them. Pure.
 */
export function applyProfileRead(
  reads: NameReads,
  requested: readonly string[],
  result: Result<ChatProfile[]>,
): NameReads {
  const failed = new Set(reads.failed);
  if (!result.ok) {
    for (const id of requested) failed.add(id);
    return { unknown: reads.unknown, failed };
  }
  const returned = new Set(result.data.map((p) => p.userId));
  const unknown = new Set(reads.unknown);
  for (const id of requested) {
    failed.delete(id);
    if (!returned.has(id)) unknown.add(id);
  }
  return { unknown, failed };
}

/**
 * The deep link's jump target: ?message= only counts alongside the ?channel= it
 * belongs to. Pure.
 */
export function messageParamTarget(
  params: URLSearchParams,
): { channelId: string; messageId: string } | null {
  const channelId = params.get('channel');
  const messageId = params.get('message');
  if (channelId === null || channelId === '' || messageId === null || messageId === '') return null;
  return { channelId, messageId };
}

/** The toast when a deep link names a chat that is not in my list. */
export const CHAT_UNAVAILABLE_TOAST = "That chat isn't available";

/**
 * What a ?channel= deep link does once the roster is ready: open that chat
 * (with its ?message= jump, if any), or, when the chat is not in my list, say
 * so and stay on the list (no jump is kept). Pure.
 */
export function deepLinkStep(
  params: URLSearchParams,
  roster: readonly ChannelSummary[],
): {
  open: ChannelSummary | null;
  jump: { channelId: string; messageId: string } | null;
  unavailable: boolean;
} {
  const channelId = params.get('channel');
  const found = roster.find((c) => c.channelId === channelId) ?? null;
  return {
    open: found,
    jump: found !== null ? messageParamTarget(params) : null,
    unavailable: found === null,
  };
}

/** The jump the open chat takes: the pending one only while it is for this chat. Pure. */
export function initialJumpFor(
  pending: { channelId: string; messageId: string } | null,
  channelId: string,
): string | null {
  return pending?.channelId === channelId ? pending.messageId : null;
}

/** What opening a DM from a tapped mention needs. */
export interface MentionDmDeps {
  workspaceId: string;
  /** The existing open-or-create DM function (startDmChannel), bound to its client. */
  start: (
    params: { workspaceId: string; peerUserId: string; traceId: string },
    onOpen: (channelId: string) => void,
  ) => Promise<{ message: string } | null>;
  /** Select and open the DM once it exists. */
  onOpen: (channelId: string) => void;
  onFailed: (traceId: string, message: string) => void;
}

/** Open (or create) my DM with a mentioned person, one fresh trace per tap. */
export async function openMentionDm(userId: string, deps: MentionDmDeps): Promise<void> {
  const traceId = generateTraceId();
  const failure = await deps.start(
    { workspaceId: deps.workspaceId, peerUserId: userId, traceId },
    deps.onOpen,
  );
  if (failure !== null) deps.onFailed(traceId, failure.message);
}

/** Resolve a channel's Agora target defensively; a bad row yields no target. */
function safeTarget(channel: ChannelSummary | null): ChannelTarget | null {
  if (channel === null) return null;
  try {
    return targetFromSummary(channel);
  } catch (error) {
    logger.error('chat: failed to derive channel target', { error: String(error) });
    return null;
  }
}

export function ChatConnected(props: ChatConnectedProps): ReactElement {
  const { client, status, workspaceId, currentUserId } = props;
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const { workspaces } = useWorkspace();
  // The workspace civil clock every timestamp renders on; the browser's own zone
  // only when the workspace has none.
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const timeZone = workspaceTimeZone(workspace?.timezone);

  const [selected, setSelected] = useState<ChannelSummary | null>(null);
  const [profiles, setProfiles] = useState<Map<string, ChatProfile>>(new Map());
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [groupInfoOpen, setGroupInfoOpen] = useState(false);
  // An Activity mention's ?message=: the thread opens with it in view.
  const [pendingJump, setPendingJump] = useState<{ channelId: string; messageId: string } | null>(
    null,
  );
  // The first page paints once its names (senders and @mentions) are in.
  const [namesSettled, setNamesSettled] = useState<string | null>(null);
  const toast = useToast();

  const {
    state: chatStore,
    loadStatus,
    roster,
    retryLoad,
    reloadRoster,
    setActive,
    markConversationRead,
    updateOwnMessage,
    refreshUnreadCounts,
    refreshPreviews,
    clearPendingOpen,
    outbox,
    clearConversation,
  } = useChatStore();

  // The open thread lives in ?channel={channelId} (replace, never push), so the
  // shell hides the mobile chrome in the same render the thread opens. Opening
  // and closing set the state and the param in one batch; only 'channel' is
  // touched, preserving any sibling deep-link param.
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const writeChannelParam = useCallback(
    (channelId: string | null) => {
      setSearchParams(
        (prev) => {
          if ((prev.get('channel') ?? null) === channelId) return prev;
          const next = new URLSearchParams(prev);
          if (channelId === null) next.delete('channel');
          else next.set('channel', channelId);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const openChannel = useCallback(
    (channel: ChannelSummary) => {
      setSelected(channel);
      writeChannelParam(channel.channelId);
    },
    [writeChannelParam],
  );
  const closeChannel = useCallback(() => {
    setSelected(null);
    writeChannelParam(null);
  }, [writeChannelParam]);

  // Email deep-link: ?channel={channelId} selects that channel once the store's
  // roster is ready, once per distinct id. The param stays while the thread is
  // open; an id not in the roster is stripped so the chrome comes back.
  const selectedFromParam = useRef<string | null>(null);
  const toastRef = useRef(toast);
  toastRef.current = toast;
  useEffect(() => {
    if (loadStatus !== 'ready') return;
    const channel = searchParams.get('channel');
    if (channel === null || channel === '') {
      selectedFromParam.current = null;
      return;
    }
    if (selectedFromParam.current === channel) return;
    selectedFromParam.current = channel;
    const step = deepLinkStep(searchParams, roster);
    // ?message= is consumed once: the thread takes it, the url drops it.
    if (step.jump !== null) setPendingJump(step.jump);
    if (searchParams.has('message')) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('message');
          return next;
        },
        { replace: true },
      );
    }
    if (selectedRef.current?.channelId === channel) return;
    if (step.open !== null) {
      setSelected(step.open);
      return;
    }
    writeChannelParam(null);
    toastRef.current.show({ title: CHAT_UNAVAILABLE_TOAST });
  }, [loadStatus, roster, searchParams, setSearchParams, writeChannelParam]);

  // A ?channel= that disappears by any route other than closeChannel (browser
  // back, external navigation) closes the thread below md so the chrome returns.
  // Only the present -> absent transition counts, so an open that sets state
  // before its param lands never reads as a close. Desktop keeps its selection.
  const channelParam = searchParams.get('channel') || null;
  const prevChannelParam = useRef(channelParam);
  useEffect(() => {
    const prev = prevChannelParam.current;
    prevChannelParam.current = channelParam;
    if (prev === null || channelParam !== null || isDesktop) return;
    if (selectedRef.current !== null) setSelected(null);
  }, [channelParam, isDesktop]);

  // Re-read the store's roster after a mutation. When channelId is given, the
  // matching (possibly newly created) channel is selected and opened.
  const refreshChannels = useCallback(
    async (channelId: string | null): Promise<void> => {
      const next = await reloadRoster();
      if (next === null || channelId === null) return;
      const found = next.find((channel) => channel.channelId === channelId);
      if (found !== undefined) openChannel(found);
    },
    [reloadRoster, openChannel],
  );

  const onDmReady = useCallback(
    (channelId: string) => {
      setNewChatOpen(false);
      // A thread selecting messages exits that first (history.back()).
      leaveSelectionThen(() => void refreshChannels(channelId));
    },
    [refreshChannels],
  );

  const onGroupCreated = useCallback(() => {
    setNewChatOpen(false);
    void refreshChannels(null);
  }, [refreshChannels]);

  const onGroupChanged = useCallback(() => {
    void refreshChannels(selected?.channelId ?? null);
  }, [refreshChannels, selected]);

  const onGroupLeft = useCallback(() => {
    setGroupInfoOpen(false);
    closeChannel();
    void refreshChannels(null);
  }, [refreshChannels, closeChannel]);

  // Delete chats for me: one trace for the action, one proc call per chat in
  // order, stopping at the first failure. Each accepted clear empties the card
  // and drops its unrecorded sends at once; an open thread goes back to the list.
  const onDeleteChats = useCallback(
    async (list: ChannelSummary[]): Promise<ClearRunResult<ChannelSummary>> => {
      const traceId = generateTraceId();
      const result = await runClearChannels({
        channels: list,
        clear: (channelId) => clearChannelRecord({ client: supabase, channelId, traceId }),
        onCleared: (channel) => {
          clearConversation(channel.channelId, Date.now());
          if (selectedRef.current?.channelId === channel.channelId) closeChannel();
        },
      });
      if (!result.ok) {
        logger.warn('chat: delete chat failed', {
          trace_id: traceId,
          channel_id: result.failed.channelId,
          error: result.message,
        });
      }
      return result;
    },
    [clearConversation, closeChannel],
  );

  // Keep the live store's active conversation in step with the open channel:
  // opening one zeroes its badge locally (the thread records the read cursor);
  // leaving or unmounting clears it.
  const selectedChannelId = selected?.channelId ?? null;
  useEffect(() => {
    if (selectedChannelId === null) {
      setActive(null);
      return;
    }
    setActive(selectedChannelId);
    markConversationRead(selectedChannelId);
    return () => setActive(null);
  }, [selectedChannelId, setActive, markConversationRead]);

  // A toast press asks the store to open a channel; consume it once the roster
  // is ready by selecting that channel, then clear the request.
  const pendingOpen = chatStore.pendingOpenConversationId;
  useEffect(() => {
    if (pendingOpen === null || loadStatus !== 'ready') return;
    const found = roster.find((channel) => channel.channelId === pendingOpen);
    if (found !== undefined) openChannel(found);
    clearPendingOpen();
  }, [pendingOpen, loadStatus, roster, clearPendingOpen, openChannel]);

  // Keyed on the channel the send was recorded in, which may no longer be open.
  const onOwnMessage = useCallback(
    (channelId: string, text: string, ts: number) => updateOwnMessage(channelId, text, ts),
    [updateOwnMessage],
  );

  const target = useMemo(() => safeTarget(selected), [selected]);
  const marks = useChatMarks({ client, channelId: selectedChannelId, target, currentUserId });
  const refetchMarks = marks.refetch;
  // Every catch-up refreshes the unread counts and re-reads the channel's marks.
  const onCaughtUp = useCallback(() => {
    refreshUnreadCounts();
    refetchMarks();
  }, [refreshUnreadCounts, refetchMarks]);
  const onMessagesDeleted = useCallback(() => refreshPreviews(), [refreshPreviews]);
  const thread = useChatThread({
    client,
    status,
    channelId: selectedChannelId,
    target,
    currentUserId,
    peerUserId: selected?.peerUserId ?? null,
    onOwnMessage,
    onCaughtUp,
    onMessagesDeleted,
    outbox,
  });
  // The thread hook resets its messages in an effect after a switch, so the
  // first render for a new channel still holds the previous chat's rows. Until
  // that reset has committed, the thread gets the loading skeleton instead:
  // never a frame of the old chat. Declared after useChatThread so both land
  // in the same re-render.
  const [threadChannelId, setThreadChannelId] = useState(selectedChannelId);
  useEffect(() => setThreadChannelId(selectedChannelId), [selectedChannelId]);
  const threadCurrent = threadChannelId === selectedChannelId;

  const typing = useChatTyping({ client, target, channelId: selectedChannelId, currentUserId });

  // A group's member ids, so its typing row only names members. Tagged with the
  // group they belong to; another group's set never applies.
  const selectedGroupId = selected?.channelType === 'group' ? (selected.groupId ?? null) : null;
  const [groupMembers, setGroupMembers] = useState<{
    groupId: string;
    ids: ReadonlySet<string>;
  } | null>(null);
  useEffect(() => {
    if (selectedGroupId === null) return;
    let cancelled = false;
    void listGroupMemberIds(supabase, { groupId: selectedGroupId }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        logger.warn('chat: group member read failed', { error: result.error.message });
        return;
      }
      setGroupMembers({ groupId: selectedGroupId, ids: new Set(result.data) });
    });
    return () => {
      cancelled = true;
    };
  }, [selectedGroupId]);
  const typingUserIds = visibleTypingIds({
    ids: typing.typingUserIds,
    isGroup: selected?.channelType === 'group',
    peerUserId: selected?.peerUserId ?? null,
    memberIds:
      groupMembers !== null && groupMembers.groupId === selectedGroupId ? groupMembers.ids : null,
  });
  const presence = useChatPresence({ client, peerUserId: selected?.peerUserId ?? null });

  // Resolve sender and @mention display info in one batched read per set of
  // new ids (no N+1). The first page of a chat is held until its names are in,
  // and a live row or an older page is held until the read for its names
  // settles, so no mention ever paints as "@Unknown member" and then swaps.
  const firstPageIn = !thread.loading && threadCurrent;
  const [nameReads, setNameReads] = useState<NameReads>(NO_NAME_READS);
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Opening a chat retries the ids whose last read failed.
  useEffect(() => {
    setNameReads((prev) => (prev.failed.size === 0 ? prev : { ...prev, failed: new Set() }));
  }, [selectedChannelId]);
  const needed = profileIdsNeeded(thread.messages, selected?.peerUserId ?? null, profiles);
  const unsettled = needed.filter((id) => !nameReads.unknown.has(id) && !nameReads.failed.has(id));
  useEffect(() => {
    const ids = idsToRead(
      profileIdsNeeded(thread.messages, selected?.peerUserId ?? null, profiles),
      nameReads,
      inFlight.current,
    );
    if (ids.length === 0) return;
    for (const id of ids) inFlight.current.add(id);
    void readProfiles(supabase, ids).then((result) => {
      for (const id of ids) inFlight.current.delete(id);
      if (!mounted.current) return;
      if (!result.ok) {
        logger.warn('chat: profile read failed', { error: result.error.message });
      } else {
        rememberMentionNames(result.data);
        setProfiles((prev) => {
          const next = new Map(prev);
          for (const profile of result.data) next.set(profile.userId, profile);
          return next;
        });
      }
      setNameReads((prev) => applyProfileRead(prev, ids, result));
    });
  }, [thread.messages, selected, profiles, nameReads]);
  const firstPageSettled = firstPageIn && unsettled.length === 0;
  useEffect(() => {
    if (firstPageSettled) setNamesSettled(selectedChannelId);
  }, [firstPageSettled, selectedChannelId]);
  const threadMessages = useMemo(
    () =>
      paintableMessages(
        thread.messages,
        (id) => profiles.has(id) || knownMentionName(id) !== undefined,
        nameReads,
      ),
    [thread.messages, profiles, nameReads],
  );
  const namesReady = namesSettled === selectedChannelId;

  // The @ picker's people: the group's members, or the DM's other person.
  const mentionMembers = useChannelMembers({
    workspaceId,
    currentUserId,
    groupId: selectedGroupId,
    peerUserId: selected?.channelType === 'dm' ? (selected.peerUserId ?? null) : null,
  });

  // Tapping a mentioned name opens my DM with them (created on first use).
  const onOpenMention = useCallback(
    (userId: string) =>
      void openMentionDm(userId, {
        workspaceId,
        start: (params, onOpen) => startDmChannel(supabase, params, onOpen),
        onOpen: onDmReady,
        onFailed: (traceId, message) => {
          logger.warn('chat: mention dm open failed', { trace_id: traceId, error: message });
          toast.show({ title: MENTION_DM_FAILED });
        },
      }),
    [workspaceId, onDmReady, toast],
  );

  const onBack = closeChannel;

  const showList = isDesktop || selected === null;
  const showThread = isDesktop || selected !== null;

  const isGroup = selected?.channelType === 'group';

  return (
    <div className="flex h-full min-h-0">
      {showList ? (
        <div className="h-full w-full border-border md:w-72 md:border-r">
          <ChannelList
            channels={roster}
            status={loadStatus}
            onRetry={retryLoad}
            selectedChannelId={selected?.channelId ?? null}
            onSelect={openChannel}
            onNewChat={() => setNewChatOpen(true)}
            timeZone={timeZone}
            onDeleteChats={onDeleteChats}
          />
        </div>
      ) : null}
      {showThread ? (
        <div className="h-full min-w-0 flex-1">
          {selected !== null ? (
            <MessageThread
              key={selected.channelId}
              title={selected.title}
              channelId={selected.channelId}
              avatarUrl={selected.avatarUrl}
              {...(!isGroup && workspace !== undefined ? { subtitle: workspace.name } : {})}
              {...(!isGroup ? { role: selected.role ?? null } : {})}
              isGroup={isGroup}
              profiles={profiles}
              messages={threadCurrent ? threadMessages : NO_MESSAGES}
              loading={thread.loading || !threadCurrent || !namesReady}
              loadingOlder={thread.loadingOlder}
              hasMore={thread.hasMore}
              onLoadOlder={thread.loadOlder}
              onNewestVisible={thread.markNewestVisible}
              timeZone={timeZone}
              canSend
              onSend={thread.send}
              onRetry={thread.retry}
              typingUserIds={typingUserIds}
              onTyping={typing.notifyTyping}
              onToggleReaction={thread.toggleReaction}
              marks={marks.marks}
              marksLoaded={marks.loaded}
              markedMessages={marks.markedMessages}
              onSetMark={marks.setMark}
              onResolveMark={marks.resolve}
              onReopenMark={marks.reopen}
              currentUserId={currentUserId}
              onDeleteMessages={thread.deleteMessages}
              onEditMessage={thread.editMessage}
              forwardChannels={roster}
              onForward={thread.forward}
              onEnsureLoaded={thread.ensureLoaded}
              mentionMembers={mentionMembers}
              mentions={{
                peerUserId: selected.channelType === 'dm' ? (selected.peerUserId ?? null) : null,
                onOpen: onOpenMention,
              }}
              initialMessageId={initialJumpFor(pendingJump, selected.channelId)}
              onInitialJumpTaken={() => setPendingJump(null)}
              showTicks={selected.channelType === 'dm'}
              {...(selected.peerUserId != null ? { presence } : {})}
              {...(isDesktop ? {} : { onBack })}
              {...(isGroup ? { onOpenInfo: () => setGroupInfoOpen(true) } : {})}
            />
          ) : (
            <div className="flex h-full flex-col justify-center bg-bg">
              <EmptyState icon={<IconChat size={22} />} title="Select a conversation" />
            </div>
          )}
        </div>
      ) : null}

      <NewChatSheet
        open={newChatOpen}
        onClose={() => setNewChatOpen(false)}
        workspaceId={workspaceId}
        currentUserId={currentUserId}
        onDmReady={onDmReady}
        onGroupCreated={onGroupCreated}
      />

      {isGroup && selected?.groupId != null ? (
        <GroupInfoSheet
          open={groupInfoOpen}
          onClose={() => setGroupInfoOpen(false)}
          workspaceId={workspaceId}
          groupId={selected.groupId}
          groupName={selected.title}
          currentUserId={currentUserId}
          onChanged={onGroupChanged}
          onLeft={onGroupLeft}
        />
      ) : null}
    </div>
  );
}
