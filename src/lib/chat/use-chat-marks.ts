// React adapter over marks.ts + record.ts for the open channel. One
// chat_message_marks read on channel open and on every refetch (the thread
// calls it after each catch-up), plus one IN read of the marked messages so the
// marks sheet can list rows whose message is older than the loaded history.
// Writes go through chat_mark_set / chat_mark_resolve / chat_mark_reopen with a
// fresh uuid_v7 trace id per tap. A stamp or reopen moves the row between the
// Open and History tabs at once and moves it back if the record refuses the
// write. Only after the record accepts a write is a live Agora
// command sent (ext { sorted_event: 'mark', message_id }), and receivers re-read
// that one mark row. Counts are derived client-side from the loaded rows.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Client } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { generateTraceId } from '@/lib/trace';
import { createCmdMessage } from '@/lib/chat/message-factory';
import { loadMessagesByIds } from '@/lib/chat/history';
import {
  applyTransition,
  indexMarks,
  loadChannelMarks,
  loadMarkByMessageId,
  subscribeMarkEvents,
  upsertMark,
  type ChatMark,
  type MarkPriority,
  type MarkTransition,
  type MarkType,
} from '@/lib/chat/marks';
import {
  reopenMarkRecord,
  resolveMarkRecord,
  setMarkRecord,
  type WriteResult,
} from '@/lib/chat/record';
import {
  markEventExt,
  rowToThreadMessage,
  type ChannelTarget,
  type ThreadMessage,
} from '@/lib/chat/thread';
import { sendSignal, type TypingConnection } from '@/lib/chat/typing';
import type { ChatConnection } from '@/lib/chat/types';

export interface UseChatMarks {
  /** Every mark of the open channel keyed by message id (resolved included). */
  marks: Map<string, ChatMark>;
  /**
   * The open channel's marks read has settled (ok or not). False on mount and
   * on every channel switch until that channel's read resolves.
   */
  loaded: boolean;
  /** Marked messages read from the record (for sheet rows beyond loaded history). */
  markedMessages: Map<string, ThreadMessage>;
  /** Re-read all marks of the open channel. */
  refetch: () => void;
  /** Mark a message, or change an open pending mark's priority (same type). */
  setMark: (messageId: string, type: MarkType, priority: MarkPriority) => Promise<WriteResult>;
  /** Stamp an open mark (Delivered / Closed / Completed). */
  resolve: (messageId: string) => Promise<WriteResult>;
  /** Return a stamped mark to open. */
  reopen: (messageId: string) => Promise<WriteResult>;
}

/**
 * Whether the open channel's marks read has settled. Keyed by channel, so a
 * switch reads false on its first render, before the reset effect runs.
 */
export function marksReadSettled(loadedFor: string | null, channelId: string | null): boolean {
  return channelId !== null && loadedFor === channelId;
}

/**
 * One stamp or reopen: apply the optimistic mark, write it through the record
 * with a fresh uuid_v7 trace id (the actor is auth.uid() server-side), and
 * re-apply the original mark when the record refuses. Framework-free so the
 * whole round trip is unit-tested against a recording fake client.
 */
export async function runMarkTransition(params: {
  db: Client;
  mark: ChatMark;
  action: MarkTransition;
  /** The caller's user id, for the optimistic resolver only; never sent. */
  actorId: string;
  apply: (mark: ChatMark) => void;
  now?: () => string;
}): Promise<{ result: WriteResult; traceId: string }> {
  const { db, mark, action } = params;
  const nowIso = (params.now ?? (() => new Date().toISOString()))();
  const traceId = generateTraceId();
  params.apply(applyTransition(mark, action, params.actorId, nowIso));
  const write = action === 'resolve' ? resolveMarkRecord : reopenMarkRecord;
  const result = await write({
    client: db,
    channelId: mark.channelId,
    messageId: mark.messageId,
    traceId,
  });
  if (!result.ok) params.apply(mark);
  return { result, traceId };
}

export function useChatMarks(params: {
  client: ChatConnection | null;
  channelId: string | null;
  target: ChannelTarget | null;
  currentUserId: string;
  /** Injected in tests; the app uses the shared Supabase client. */
  db?: Client;
}): UseChatMarks {
  const { client, channelId, target, currentUserId } = params;
  const db: Client = params.db ?? supabase;
  const [marks, setMarks] = useState<Map<string, ChatMark>>(new Map());
  const [markedMessages, setMarkedMessages] = useState<Map<string, ThreadMessage>>(new Map());
  // The channel whose marks read has settled (ok or not); null until one has.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const channelRef = useRef(channelId);
  channelRef.current = channelId;
  const clientRef = useRef(client);
  clientRef.current = client;
  const targetRef = useRef(target);
  targetRef.current = target;

  /** One IN read of the marked messages, merged into the lookup. */
  const loadMarkedMessages = useCallback(
    async (ids: readonly string[], forChannel: string): Promise<void> => {
      if (ids.length === 0) return;
      const result = await loadMessagesByIds(db, ids);
      if (channelRef.current !== forChannel) return;
      if (!result.ok) {
        logger.warn('chat: marked messages load failed', { error: result.error.message });
        return;
      }
      setMarkedMessages((prev) => {
        const next = new Map(prev);
        for (const row of result.data) next.set(row.id, rowToThreadMessage(row, currentUserId));
        return next;
      });
    },
    [db, currentUserId],
  );

  const load = useCallback(
    async (forChannel: string): Promise<void> => {
      const result = await loadChannelMarks(db, forChannel);
      if (channelRef.current !== forChannel) return;
      if (!result.ok) {
        logger.warn('chat: marks load failed', {
          channel_id: forChannel,
          error: result.error.message,
        });
        // Settled all the same: the strip stops holding and shows what it has.
        setLoadedFor(forChannel);
        return;
      }
      setMarks(indexMarks(result.data));
      setLoadedFor(forChannel);
      await loadMarkedMessages(
        result.data.map((m) => m.messageId),
        forChannel,
      );
    },
    [db, loadMarkedMessages],
  );

  useEffect(() => {
    setMarks(new Map());
    setMarkedMessages(new Map());
    setLoadedFor(null);
    if (channelId === null) return;
    void load(channelId);
  }, [channelId, load]);

  const refetch = useCallback((): void => {
    const forChannel = channelRef.current;
    if (forChannel !== null) void load(forChannel);
  }, [load]);

  /** Re-read one mark row (after a live signal or our own write). */
  const refreshOne = useCallback(
    async (messageId: string): Promise<void> => {
      const forChannel = channelRef.current;
      if (forChannel === null) return;
      const result = await loadMarkByMessageId(db, messageId);
      if (channelRef.current !== forChannel) return;
      if (!result.ok) {
        logger.warn('chat: mark load failed', {
          message_id: messageId,
          error: result.error.message,
        });
        return;
      }
      if (!result.data.found || result.data.mark.channelId !== forChannel) return;
      const mark = result.data.mark;
      setMarks((prev) => upsertMark(prev, mark));
      await loadMarkedMessages([messageId], forChannel);
    },
    [db, loadMarkedMessages],
  );

  useEffect(() => {
    if (client === null || channelId === null) return;
    return subscribeMarkEvents(client, (messageId) => void refreshOne(messageId));
  }, [client, channelId, refreshOne]);

  /** Tell peers a mark changed; never fails the write (they catch up on reopen). */
  const signal = useCallback((messageId: string, traceId: string): void => {
    const connection = clientRef.current;
    const liveTarget = targetRef.current;
    if (connection === null || liveTarget === null) return;
    void sendSignal({
      connection: connection as TypingConnection,
      target: liveTarget,
      createCmd: createCmdMessage,
      ext: markEventExt({ messageId }),
    }).catch((error: unknown) =>
      logger.warn('chat: mark signal failed', { trace_id: traceId, error: String(error) }),
    );
  }, []);

  const setMark = useCallback<UseChatMarks['setMark']>(
    async (messageId, type, priority) => {
      const forChannel = channelRef.current;
      if (forChannel === null) return { ok: false, message: 'No chat is open.' };
      const traceId = generateTraceId();
      const result = await setMarkRecord({
        client: db,
        channelId: forChannel,
        messageId,
        type,
        priority,
        traceId,
      });
      if (!result.ok) {
        logger.warn('chat: mark set failed', {
          trace_id: traceId,
          message_id: messageId,
          error: result.message,
        });
        return result;
      }
      if (channelRef.current === forChannel) {
        setMarks((prev) => {
          const existing = prev.get(messageId);
          return upsertMark(prev, {
            messageId,
            channelId: forChannel,
            type,
            priority: type === 'pending' ? priority : null,
            markedAt: existing?.markedAt ?? new Date().toISOString(),
            resolved: false,
            resolvedBy: null,
            resolvedAt: null,
          });
        });
      }
      signal(messageId, traceId);
      void refreshOne(messageId);
      return result;
    },
    [db, signal, refreshOne],
  );

  const transition = useCallback(
    async (messageId: string, action: MarkTransition): Promise<WriteResult> => {
      const forChannel = channelRef.current;
      const mark = marksRef.current.get(messageId);
      if (forChannel === null || mark === undefined || mark.channelId !== forChannel) {
        return { ok: false, message: 'Mark not loaded.' };
      }
      const { result, traceId } = await runMarkTransition({
        db,
        mark,
        action,
        actorId: currentUserId,
        apply: (next) => {
          if (channelRef.current === forChannel) setMarks((prev) => upsertMark(prev, next));
        },
      });
      if (!result.ok) {
        logger.warn(`chat: mark ${action} failed`, {
          trace_id: traceId,
          message_id: messageId,
          error: result.message,
        });
        return result;
      }
      signal(messageId, traceId);
      void refreshOne(messageId);
      return result;
    },
    [db, currentUserId, signal, refreshOne],
  );

  const resolve = useCallback<UseChatMarks['resolve']>(
    (messageId) => transition(messageId, 'resolve'),
    [transition],
  );
  const reopen = useCallback<UseChatMarks['reopen']>(
    (messageId) => transition(messageId, 'reopen'),
    [transition],
  );

  const loaded = marksReadSettled(loadedFor, channelId);
  return useMemo(
    () => ({ marks, loaded, markedMessages, refetch, setMark, resolve, reopen }),
    [marks, loaded, markedMessages, refetch, setMark, resolve, reopen],
  );
}
