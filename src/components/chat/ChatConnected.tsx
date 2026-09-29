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

interface ChatConnectedProps {
  client: ChatConnection | null;
  status: ChatStatus;
  workspaceId: string;
  currentUserId: string;
}

const DESKTOP_QUERY = '(min-width: 768px)';

const NO_MESSAGES: ThreadMessage[] = [];

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
  useEffect(() => {
    if (loadStatus !== 'ready') return;
    const channel = searchParams.get('channel');
    if (channel === null || channel === '') {
      selectedFromParam.current = null;
      return;
    }
    if (selectedFromParam.current === channel) return;
    selectedFromParam.current = channel;
    if (selectedRef.current?.channelId === channel) return;
    const found = roster.find((c) => c.channelId === channel);
    if (found !== undefined) setSelected(found);
    else writeChannelParam(null);
  }, [loadStatus, roster, searchParams, writeChannelParam]);

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

  // Resolve sender display info in one batched read per set of new ids (no N+1).
  useEffect(() => {
    const needed = new Set<string>();
    for (const message of thread.messages) {
      if (message.senderUserId !== null && !profiles.has(message.senderUserId)) {
        needed.add(message.senderUserId);
      }
    }
    if (selected?.peerUserId != null && !profiles.has(selected.peerUserId)) {
      needed.add(selected.peerUserId);
    }
    if (needed.size === 0) return;
    let cancelled = false;
    void readProfiles(supabase, [...needed]).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        logger.warn('chat: profile read failed', { error: result.error.message });
        return;
      }
      setProfiles((prev) => {
        const next = new Map(prev);
        for (const profile of result.data) next.set(profile.userId, profile);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [thread.messages, selected, profiles]);

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
              messages={threadCurrent ? thread.messages : NO_MESSAGES}
              loading={thread.loading || !threadCurrent}
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
