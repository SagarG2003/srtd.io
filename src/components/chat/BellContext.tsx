// The chat bell's state, mounted by ChatConnected around the chat surface: the
// loaded bell data (bell.ts), the open sheet / popover, the reminder sheet
// (Remind me from a message, Change time from Upcoming), the cancel confirm
// and the "Scheduled in this chat" sheet the bell opens for one chat.
//
// Data: one load on mount (so the dot is right before the bell opens), then a
// refetch on open, after every action, when the tab becomes visible and on the
// shell's inbox poll tick (BELL_REFRESH_EVENT). Until the first load settles
// the panel shows skeleton rows, never an empty state that flips to rows; a
// later refetch keeps the rows on screen. Action failures toast "Couldn't do
// that. Try again."; a "not found" (already done elsewhere) refetches silently.
// Every listener and in-flight read is dropped on unmount.

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
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Client } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { generateTraceId } from '@/lib/trace';
import { newMessageId } from '@/lib/chat/message-id';
import { mentionTargets, type NameOf } from '@/lib/chat/mentions';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { ThreadMessage } from '@/lib/chat/thread';
import {
  BELL_REFRESH_EVENT,
  EMPTY_BELL,
  announceRemindersChanged,
  bellUnreadCount,
  loadBell,
  markBellEventsRead,
  markBellRead,
  mergeOlder,
  messagePreview,
  readChannelScheduled,
  snoozeBellEntry,
  type BellData,
  type BellEntry,
  type BellSnoozeKind,
} from '@/lib/chat/bell';
import {
  ACTION_FAILED_COPY,
  cancelReminder,
  mapReminderError,
  reminderSetCopy,
  setReminder,
  type ReminderRow,
} from '@/lib/chat/reminders';
import {
  cancelScheduledMessage,
  mapScheduleError,
  rowMentions,
  sendScheduledNow,
  updateScheduledMessage,
  type ScheduledRow,
} from '@/lib/chat/scheduled';
import { BELL_OPEN_PARAM, chatMessageHref } from '@/lib/inbox/bell-types';
import { useToast } from '@/components/ui/toast';

export type BellStatus = 'loading' | 'ready' | 'error';

/** What the reminder sheet is for: a new reminder on a message, or a new time for one. */
export type ReminderTarget =
  | { mode: 'new'; messageId: string; channelId: string; preview: string }
  | { mode: 'change'; reminder: ReminderRow; preview: string };

export interface BellContextValue {
  data: BellData;
  status: BellStatus;
  /** Unread items in Now (the dot). */
  unread: number;
  open: boolean;
  setOpen: (open: boolean) => void;
  reload: () => void;
  loadMore: () => void;
  loadingMore: boolean;
  nameOf: NameOf;
  chatNameOf: (channelId: string | null) => string;
  /** Hidden at once while a write that removes them is in flight. */
  hiddenIds: ReadonlySet<string>;
  // Now
  openEntry: (entry: BellEntry) => void;
  snooze: (entry: BellEntry, kind: BellSnoozeKind) => Promise<void>;
  done: (entry: BellEntry) => Promise<void>;
  clearSent: () => Promise<void>;
  retryFailed: (entry: BellEntry) => Promise<void>;
  editFailed: (entry: BellEntry) => void;
  // Upcoming
  changeReminderTime: (reminder: ReminderRow) => void;
  askCancelReminder: (reminder: ReminderRow) => void;
  openScheduledChat: (channelId: string) => void;
  // From a message's action menu
  canRemind: (messageId: string) => boolean;
  openReminderFor: (messageId: string) => void;
  // Sheets the bell owns (rendered by NotificationsSheets)
  reminderTarget: ReminderTarget | null;
  closeReminder: () => void;
  pickReminderTime: (at: Date) => Promise<void>;
  cancelTarget: ReminderRow | null;
  closeCancel: () => void;
  confirmCancel: () => Promise<void>;
  scheduledSheet: { channelId: string; rows: ScheduledRow[] } | null;
  closeScheduledSheet: () => void;
  scheduledActions: {
    onSendNow: (row: ScheduledRow) => Promise<void>;
    onSaveBody: (row: ScheduledRow, body: string) => Promise<boolean>;
    onRetime: (row: ScheduledRow, sendAt: Date) => Promise<boolean>;
    onCancel: (row: ScheduledRow) => Promise<boolean>;
  };
}

const BellContext = createContext<BellContextValue | null>(null);

/** The raw provider: BellProvider uses it; tests hand it a fixed value. */
export const BellValueProvider = BellContext.Provider;

/** The bell, or null outside a BellProvider (ChannelList and the menu render without it in tests). */
export function useBellOptional(): BellContextValue | null {
  return useContext(BellContext);
}

/** What the bell's actions need: injected so tests drive them with a recording client. */
export interface BellActionDeps {
  client: Client;
  workspaceId: string;
  newTraceId: () => string;
  /** A fresh uuid_v7 for chat_reminder_set. */
  newId: () => string;
  reload: () => void;
  /** Hide rows at once while a write that removes them is in flight. */
  hide: (ids: string[]) => void;
  unhide: (ids: string[]) => void;
  entries: () => readonly BellEntry[];
  /** Log a failure; toast `copy` (default "Couldn't do that. Try again."), null stays silent. */
  failed: (what: string, traceId: string, message: string, copy?: string | null) => void;
  notify: (title: string) => void;
  goToMessage: (channelId: string | null, messageId: string | null) => void;
  openChannelSheet: (channelId: string) => void;
  remindersChanged: () => void;
}

export interface BellActions {
  openEntry: (entry: BellEntry) => void;
  snooze: (entry: BellEntry, kind: BellSnoozeKind) => Promise<void>;
  done: (entry: BellEntry) => Promise<void>;
  clearSent: () => Promise<void>;
  retryFailed: (entry: BellEntry) => Promise<void>;
  editFailed: (entry: BellEntry) => void;
  setReminderAt: (target: { messageId: string; channelId: string }, at: Date) => Promise<void>;
  cancelReminder: (reminder: ReminderRow) => Promise<void>;
}

/**
 * The bell's writes. Each mints a trace id, calls its proc (p_trace_id
 * explicit), refetches, and on failure logs and toasts the action copy (a "not
 * found" refetches silently). Opening a mention or a sent row marks it read,
 * THEN opens the chat at the message; opening a reminder never clears it.
 */
export function createBellActions(deps: BellActionDeps): BellActions {
  const markRead = async (entry: BellEntry, what: string): Promise<boolean> => {
    const traceId = deps.newTraceId();
    deps.hide([entry.id]);
    const res = await markBellRead(deps.client, entry, traceId);
    if (!res.ok) {
      deps.unhide([entry.id]);
      deps.failed(what, traceId, res.error.message);
    }
    deps.reload();
    return res.ok;
  };
  return {
    openEntry(entry) {
      if (entry.eventType === 'reminder') {
        deps.goToMessage(entry.channelId, entry.messageId);
        return;
      }
      if (entry.eventType === 'scheduled_failed') return;
      const messageId =
        entry.eventType === 'scheduled_sent'
          ? (entry.messageId ?? entry.scheduledId)
          : entry.messageId;
      void markRead(entry, entry.eventType === 'mention' ? 'mention read' : 'sent read').then(() =>
        deps.goToMessage(entry.channelId, messageId),
      );
    },
    async snooze(entry, kind) {
      const traceId = deps.newTraceId();
      deps.hide([entry.id]);
      const res = await snoozeBellEntry(deps.client, entry, kind, traceId);
      if (!res.ok) {
        deps.unhide([entry.id]);
        deps.failed('snooze', traceId, res.error.message);
      }
      deps.reload();
    },
    async done(entry) {
      await markRead(entry, 'done');
    },
    async clearSent() {
      const traceId = deps.newTraceId();
      const ids = deps
        .entries()
        .filter((e) => e.eventType === 'scheduled_sent')
        .map((e) => e.id);
      deps.hide(ids);
      const res = await markBellEventsRead(deps.client, {
        workspaceId: deps.workspaceId,
        eventTypes: ['scheduled_sent'],
        traceId,
      });
      if (!res.ok) {
        deps.unhide(ids);
        deps.failed('clear sent', traceId, res.error.message);
      }
      deps.reload();
    },
    async retryFailed(entry) {
      if (entry.scheduledId === null) return;
      const traceId = deps.newTraceId();
      const res = await sendScheduledNow({ client: deps.client, id: entry.scheduledId, traceId });
      if (!res.ok) {
        const mapped = mapScheduleError(res.message);
        deps.failed('retry', traceId, res.message, mapped === null ? null : ACTION_FAILED_COPY);
      }
      deps.reload();
    },
    editFailed(entry) {
      if (entry.channelId !== null) deps.openChannelSheet(entry.channelId);
    },
    async setReminderAt(target, at) {
      const traceId = deps.newTraceId();
      // A new id every time: the proc ignores an id it already holds and
      // replaces the pending reminder on the same message (Change time).
      const res = await setReminder({
        client: deps.client,
        id: deps.newId(),
        messageId: target.messageId,
        channelId: target.channelId,
        remindAt: at,
        traceId,
      });
      if (res.ok) deps.notify(reminderSetCopy(at, new Date()));
      else deps.failed('reminder set', traceId, res.message, mapReminderError(res.message));
      deps.remindersChanged();
      deps.reload();
    },
    async cancelReminder(reminder) {
      const traceId = deps.newTraceId();
      deps.hide([reminder.id]);
      const res = await cancelReminder({ client: deps.client, id: reminder.id, traceId });
      if (!res.ok) {
        deps.unhide([reminder.id]);
        deps.failed('reminder cancel', traceId, res.message);
      }
      deps.remindersChanged();
      deps.reload();
    },
  };
}

export function BellProvider(props: {
  workspaceId: string;
  currentUserId: string;
  roster: readonly ChannelSummary[];
  /** The open chat and its loaded messages: the Remind me preview reads them. */
  openChannelId: string | null;
  messages: readonly ThreadMessage[];
  nameOf: NameOf;
  children: ReactNode;
}): ReactElement {
  const { workspaceId, currentUserId } = props;
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<BellData>(EMPTY_BELL);
  const [status, setStatus] = useState<BellStatus>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpenState] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(new Set());
  const [reminderTarget, setReminderTarget] = useState<ReminderTarget | null>(null);
  const [cancelTarget, setCancelTarget] = useState<ReminderRow | null>(null);
  const [scheduledSheet, setScheduledSheet] = useState<{
    channelId: string;
    rows: ScheduledRow[];
  } | null>(null);

  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  const dataRef = useRef(data);
  dataRef.current = data;
  const messagesRef = useRef(props.messages);
  messagesRef.current = props.messages;
  const openChannelRef = useRef(props.openChannelId);
  openChannelRef.current = props.openChannelId;
  const nameOfRef = useRef(props.nameOf);
  nameOfRef.current = props.nameOf;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback((): void => {
    seqRef.current += 1;
    const seq = seqRef.current;
    void loadBell(supabase, { workspaceId, userId: currentUserId }).then((res) => {
      if (!mountedRef.current || seq !== seqRef.current) return;
      if (res.ok) {
        setData(res.data);
        setStatus('ready');
        setHiddenIds(new Set());
        return;
      }
      logger.warn('bell: load failed', { error: res.error.message });
      // A refetch failure keeps what is on screen; only a first load shows the error.
      setStatus((prev) => (prev === 'ready' ? 'ready' : 'error'));
    });
  }, [workspaceId, currentUserId]);

  const loadMore = useCallback((): void => {
    const current = dataRef.current;
    const oldest = current.entries[current.entries.length - 1]?.createdAt;
    if (oldest === undefined || !current.hasMore) return;
    setLoadingMore(true);
    const seq = seqRef.current;
    void loadBell(supabase, { workspaceId, userId: currentUserId, before: oldest }).then((res) => {
      if (!mountedRef.current) return;
      setLoadingMore(false);
      if (seq !== seqRef.current) return;
      if (res.ok) setData((prev) => mergeOlder(prev, res.data));
      else {
        logger.warn('bell: older page failed', { error: res.error.message });
        toast.show({ title: ACTION_FAILED_COPY });
      }
    });
  }, [workspaceId, currentUserId, toast]);

  // First load, and a fresh one on a workspace or user switch.
  useEffect(() => {
    setStatus('loading');
    setData(EMPTY_BELL);
    reload();
  }, [reload]);

  // The tab becoming visible and the shell's poll tick refetch.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(BELL_REFRESH_EVENT, reload);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(BELL_REFRESH_EVENT, reload);
    };
  }, [reload]);

  const setOpen = useCallback(
    (next: boolean): void => {
      setOpenState(next);
      if (next) reload();
    },
    [reload],
  );

  // ?bell=1 (the missed-reminders toast): open the bell, then drop the param.
  useEffect(() => {
    if (searchParams.get(BELL_OPEN_PARAM) !== '1') return;
    setOpen(true);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(BELL_OPEN_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams, setOpen]);

  const channelOf = useCallback(
    (channelId: string | null): ChannelSummary | undefined =>
      channelId === null ? undefined : props.roster.find((c) => c.channelId === channelId),
    [props.roster],
  );
  const chatNameOf = useCallback(
    (channelId: string | null): string => channelOf(channelId)?.title ?? 'Chat',
    [channelOf],
  );
  const nameOf = useCallback<NameOf>(
    (id) => dataRef.current.names.get(id) ?? nameOfRef.current(id),
    [],
  );

  const failed = useCallback(
    (what: string, traceId: string, message: string, copy: string | null = ACTION_FAILED_COPY) => {
      logger.warn(`bell: ${what} failed`, { trace_id: traceId, error: message });
      if (copy !== null) toast.show({ title: copy });
    },
    [toast],
  );

  const goToMessage = useCallback(
    (channelId: string | null, messageId: string | null): void => {
      if (channelId === null) return;
      setOpenState(false);
      navigate(chatMessageHref(channelId, messageId));
    },
    [navigate],
  );

  const openChannelSheet = useCallback(
    (channelId: string): void => {
      void readChannelScheduled(supabase, { channelId }).then((res) => {
        if (!mountedRef.current) return;
        if (!res.ok) {
          logger.warn('bell: chat scheduled read failed', { error: res.error.message });
          toast.show({ title: ACTION_FAILED_COPY });
          return;
        }
        setOpenState(false);
        setScheduledSheet({ channelId, rows: res.data });
      });
    },
    [toast],
  );

  const actions = useMemo(
    () =>
      createBellActions({
        client: supabase,
        workspaceId,
        newTraceId: generateTraceId,
        newId: newMessageId,
        reload,
        hide: (ids) => setHiddenIds((prev) => new Set([...prev, ...ids])),
        unhide: (ids) =>
          setHiddenIds((prev) => new Set([...prev].filter((id) => !ids.includes(id)))),
        entries: () => dataRef.current.entries,
        failed,
        notify: (title) => toast.show({ title }),
        goToMessage,
        openChannelSheet,
        remindersChanged: announceRemindersChanged,
      }),
    [workspaceId, reload, failed, toast, goToMessage, openChannelSheet],
  );

  const refreshSheet = useCallback((channelId: string): void => {
    void readChannelScheduled(supabase, { channelId }).then((res) => {
      if (!mountedRef.current || !res.ok) return;
      setScheduledSheet((prev) =>
        prev === null || prev.channelId !== channelId
          ? prev
          : res.data.length === 0
            ? null
            : { channelId, rows: res.data },
      );
    });
  }, []);

  const scheduledActions = useMemo(() => {
    const write = async <T,>(
      row: ScheduledRow,
      what: string,
      run: (traceId: string) => Promise<{ ok: true; row: T } | { ok: false; message: string }>,
    ): Promise<boolean> => {
      const traceId = generateTraceId();
      const res = await run(traceId);
      refreshSheet(row.channel_id);
      reload();
      if (res.ok) return true;
      const mapped = mapScheduleError(res.message);
      failed(what, traceId, res.message, mapped === null ? null : mapped);
      return false;
    };
    const channelType = (channelId: string): 'dm' | 'group' | undefined =>
      props.roster.find((c) => c.channelId === channelId)?.channelType;
    return {
      onSendNow: async (row: ScheduledRow): Promise<void> => {
        await write(row, 'scheduled send now', (traceId) =>
          sendScheduledNow({ client: supabase, id: row.id, traceId }),
        );
      },
      onSaveBody: (row: ScheduledRow, body: string): Promise<boolean> =>
        write(row, 'scheduled edit', (traceId) =>
          updateScheduledMessage({
            client: supabase,
            id: row.id,
            // A failed row's time has passed: keep it only while still ahead.
            sendAt: new Date(Math.max(Date.parse(row.send_at), Date.now() + 2 * 60_000)),
            body,
            mentions: mentionTargets(body, channelType(row.channel_id)),
            traceId,
          }),
        ),
      onRetime: (row: ScheduledRow, sendAt: Date): Promise<boolean> =>
        write(row, 'scheduled retime', (traceId) =>
          updateScheduledMessage({
            client: supabase,
            id: row.id,
            sendAt,
            body: row.body ?? '',
            mentions: rowMentions(row),
            traceId,
          }),
        ),
      onCancel: (row: ScheduledRow): Promise<boolean> =>
        write(row, 'scheduled cancel', (traceId) =>
          cancelScheduledMessage({ client: supabase, id: row.id, traceId }),
        ),
    };
  }, [props.roster, failed, reload, refreshSheet]);

  const previewOfMessage = useCallback(
    (messageId: string): string | null => {
      const m = messagesRef.current.find((x) => x.id === messageId);
      if (m !== undefined) {
        return messagePreview(
          {
            id: m.id,
            channelId: openChannelRef.current ?? '',
            senderUserId: m.senderUserId,
            body: m.body,
            hasAttachments: m.attachments.length > 0,
            hasPosts: m.sharedPostIds.length > 0,
            hasBriefs: m.sharedBriefIds.length > 0,
          },
          nameOf,
        );
      }
      const held = dataRef.current.messages.get(messageId);
      return held !== undefined ? messagePreview(held, nameOf) : null;
    },
    [nameOf],
  );

  const canRemind = useCallback((messageId: string): boolean => {
    const m = messagesRef.current.find((x) => x.id === messageId);
    return (
      openChannelRef.current !== null &&
      m !== undefined &&
      m.state === 'sent' &&
      m.deleted !== true &&
      m.createdAt !== ''
    );
  }, []);

  const openReminderFor = useCallback(
    (messageId: string): void => {
      const channelId = openChannelRef.current;
      if (channelId === null) return;
      setReminderTarget({
        mode: 'new',
        messageId,
        channelId,
        preview: previewOfMessage(messageId) ?? 'Message',
      });
    },
    [previewOfMessage],
  );

  const changeReminderTime = useCallback(
    (reminder: ReminderRow): void => {
      setOpenState(false);
      setReminderTarget({
        mode: 'change',
        reminder,
        preview: previewOfMessage(reminder.message_id) ?? 'Message',
      });
    },
    [previewOfMessage],
  );

  const pickReminderTime = useCallback(
    async (at: Date): Promise<void> => {
      const target = reminderTarget;
      setReminderTarget(null);
      if (target === null) return;
      await actions.setReminderAt(
        target.mode === 'new'
          ? { messageId: target.messageId, channelId: target.channelId }
          : { messageId: target.reminder.message_id, channelId: target.reminder.channel_id },
        at,
      );
    },
    [reminderTarget, actions],
  );

  const askCancelReminder = useCallback((reminder: ReminderRow): void => {
    setOpenState(false);
    setCancelTarget(reminder);
  }, []);

  const confirmCancel = useCallback(async (): Promise<void> => {
    const target = cancelTarget;
    setCancelTarget(null);
    if (target !== null) await actions.cancelReminder(target);
  }, [cancelTarget, actions]);

  const unread = useMemo(
    () =>
      bellUnreadCount(
        data.entries.filter((e) => !hiddenIds.has(e.id)),
        Date.now(),
      ),
    [data.entries, hiddenIds],
  );

  const value = useMemo<BellContextValue>(
    () => ({
      data,
      status,
      unread,
      open,
      setOpen,
      reload,
      loadMore,
      loadingMore,
      nameOf,
      chatNameOf,
      hiddenIds,
      openEntry: actions.openEntry,
      snooze: actions.snooze,
      done: actions.done,
      clearSent: actions.clearSent,
      retryFailed: actions.retryFailed,
      editFailed: actions.editFailed,
      changeReminderTime,
      askCancelReminder,
      openScheduledChat: openChannelSheet,
      canRemind,
      openReminderFor,
      reminderTarget,
      closeReminder: () => setReminderTarget(null),
      pickReminderTime,
      cancelTarget,
      closeCancel: () => setCancelTarget(null),
      confirmCancel,
      scheduledSheet,
      closeScheduledSheet: () => setScheduledSheet(null),
      scheduledActions,
    }),
    [
      data,
      status,
      unread,
      open,
      setOpen,
      reload,
      loadMore,
      loadingMore,
      nameOf,
      chatNameOf,
      hiddenIds,
      actions,
      changeReminderTime,
      askCancelReminder,
      openChannelSheet,
      canRemind,
      openReminderFor,
      reminderTarget,
      pickReminderTime,
      cancelTarget,
      confirmCancel,
      scheduledSheet,
      scheduledActions,
    ],
  );

  return <BellContext.Provider value={value}>{props.children}</BellContext.Provider>;
}
