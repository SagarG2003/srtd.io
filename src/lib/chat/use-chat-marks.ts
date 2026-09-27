// React adapter over marks.ts + record.ts for the open channel. One
// chat_message_marks read on channel open and on every refetch (the thread
// calls it after each catch-up), plus one IN read of the marked messages so the
// marks sheet can list rows whose message is older than the loaded history.
// Writes go through chat_mark_set / chat_mark_resolve with a fresh uuid_v7
// trace id per tap; only after the record accepts the write is a live Agora
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
  indexMarks,
  loadChannelMarks,
  loadMarkByMessageId,
  subscribeMarkEvents,
  upsertMark,
  type ChatMark,
  type MarkPriority,
  type MarkType,
} from '@/lib/chat/marks';
import { resolveMarkRecord, setMarkRecord, type WriteResult } from '@/lib/chat/record';
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
  /** Marked messages read from the record (for sheet rows beyond loaded history). */
  markedMessages: Map<string, ThreadMessage>;
  /** Re-read all marks of the open channel. */
  refetch: () => void;
  /** Mark a message, or change an open pending mark's priority (same type). */
  setMark: (messageId: string, type: MarkType, priority: MarkPriority) => Promise<WriteResult>;
  /** Resolve an open pending mark. */
  resolve: (messageId: string) => Promise<WriteResult>;
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
        return;
      }
      setMarks(indexMarks(result.data));
      await loadMarkedMessages(
        result.data.filter((m) => !m.resolved).map((m) => m.messageId),
        forChannel,
      );
    },
    [db, loadMarkedMessages],
  );

  useEffect(() => {
    setMarks(new Map());
    setMarkedMessages(new Map());
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
      if (!mark.resolved) await loadMarkedMessages([messageId], forChannel);
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
          });
        });
      }
      signal(messageId, traceId);
      void refreshOne(messageId);
      return result;
    },
    [db, signal, refreshOne],
  );

  const resolve = useCallback<UseChatMarks['resolve']>(
    async (messageId) => {
      const forChannel = channelRef.current;
      if (forChannel === null) return { ok: false, message: 'No chat is open.' };
      const traceId = generateTraceId();
      const result = await resolveMarkRecord({
        client: db,
        channelId: forChannel,
        messageId,
        traceId,
      });
      if (!result.ok) {
        logger.warn('chat: mark resolve failed', {
          trace_id: traceId,
          message_id: messageId,
          error: result.message,
        });
        return result;
      }
      if (channelRef.current === forChannel) {
        setMarks((prev) => {
          const existing = prev.get(messageId);
          return existing === undefined ? prev : upsertMark(prev, { ...existing, resolved: true });
        });
      }
      signal(messageId, traceId);
      return result;
    },
    [db, signal],
  );

  return useMemo(
    () => ({ marks, markedMessages, refetch, setMark, resolve }),
    [marks, markedMessages, refetch, setMark, resolve],
  );
}
