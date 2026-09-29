// Delete own messages for everyone: record first (chat_message_delete, chunked
// at 100 ids per call), then for each accepted chunk turn the ids into
// tombstones locally and signal peers live with ext { sorted_event: 'delete',
// message_ids }. A failed signal never fails the delete (the rows are wiped; a
// receiver that misses it reads the tombstones on its next history load).
//
// Edit own message: the same order. chat_message_edit first; only the
// returned row updates the bubble (the new text never shows before the record
// holds it), then peers get ext { sorted_event: 'edit', message_ids: [id],
// body, edited_at }. A failed record returns the mapped user copy. The edit
// always carries the body's COMPLETE mention list (empty when none): the proc
// reads an omitted list as "clear all mentions". A refused mention re-reads the
// chat's members once and edits again without the ones who left (without any
// mention when that re-read fails).
//
// Pure of React and the SDK so the ordering is unit-tested directly.

import type { Client } from '@srtdio/rpc';
import { deleteMessagesRecord, editFailureCopy, editMessageRecord } from '@/lib/chat/record';
import { deleteEventExt, editEventExt, type ChatMessageRow } from '@/lib/chat/thread';
import {
  ALL_MENTION,
  isEveryoneRefusal,
  isMentionRefusal,
  mentionTargets,
  mentionsAfterRefusal,
} from '@/lib/chat/mentions';
import { recheck } from '@/lib/chat/send-flow';
import { readChannelMemberIds } from '@/lib/chat-reads';
import type { Result } from '@srtdio/rpc';

export interface DeleteFlowDeps {
  client: Client;
  /** Turn accepted ids into tombstones in the thread (and tell the store). */
  markDeletedLocal: (ids: string[]) => void;
  /** Publish the live delete command; undefined while there is no connection. */
  signal: ((ext: Record<string, unknown>) => Promise<unknown>) | undefined;
  onSignalFailed: (error: unknown) => void;
}

export async function runDelete(
  deps: DeleteFlowDeps,
  input: { channelId: string; messageIds: readonly string[]; traceId: string },
): Promise<{ ok: true } | { ok: false; message: string; deleted: string[] }> {
  const result = await deleteMessagesRecord({
    client: deps.client,
    channelId: input.channelId,
    messageIds: input.messageIds,
    traceId: input.traceId,
    onChunkDeleted: (ids) => {
      deps.markDeletedLocal(ids);
      if (deps.signal === undefined) return;
      let pending: Promise<unknown>;
      try {
        pending = deps.signal(deleteEventExt({ messageIds: ids }));
      } catch (error) {
        deps.onSignalFailed(error);
        return;
      }
      void pending.catch((error: unknown) => deps.onSignalFailed(error));
    },
  });
  return result.ok ? { ok: true } : { ok: false, message: result.message, deleted: result.deleted };
}

export interface EditFlowDeps {
  client: Client;
  /** Show the recorded row (new body and edited_at) in the thread. */
  applyLocal: (row: ChatMessageRow) => void;
  /** Publish the live edit command; undefined while there is no connection. */
  signal: ((ext: Record<string, unknown>) => Promise<unknown>) | undefined;
  onSignalFailed: (error: unknown) => void;
  /** Re-read the chat's members after a refused mention; defaults to readChannelMemberIds. */
  recheckMentions?: (channelId: string) => Promise<Result<string[]>>;
  /** Override for tests. */
  timeoutMs?: number;
}

export async function runEdit(
  deps: EditFlowDeps,
  input: {
    channelId: string;
    messageId: string;
    body: string;
    traceId: string;
    /** The chat's type; a DM never sends "all" in p_mentions. */
    channelType?: 'dm' | 'group';
  },
): Promise<{ ok: true } | { ok: false; message: string; error: string }> {
  const edit = (mentions: string[]): ReturnType<typeof editMessageRecord> =>
    editMessageRecord({
      client: deps.client,
      channelId: input.channelId,
      messageId: input.messageId,
      body: input.body,
      mentions,
      traceId: input.traceId,
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    });
  let mentions = mentionTargets(input.body, input.channelType);
  let result = await edit(mentions);
  // As runSend: the chat's type was unknown and "all" went out in a DM: drop
  // only "all" and edit with the people first; a further refusal takes the
  // ladder below.
  if (
    !result.ok &&
    input.channelType === undefined &&
    mentions.includes(ALL_MENTION) &&
    isEveryoneRefusal(result.message)
  ) {
    mentions = mentions.filter((id) => id !== ALL_MENTION);
    result = await edit(mentions);
  }
  if (!result.ok && mentions.length > 0 && isMentionRefusal(result.message)) {
    const read =
      deps.recheckMentions ??
      ((channelId: string) => readChannelMemberIds(deps.client, { channelId }));
    const retry = mentionsAfterRefusal(mentions, await recheck(read, input.channelId));
    result = await edit(retry);
    // Refused again: the last step edits without mentions, never a failed edit.
    if (!result.ok && retry.length > 0 && isMentionRefusal(result.message)) {
      result = await edit([]);
    }
  }
  if (!result.ok) {
    return { ok: false, message: editFailureCopy(result.message), error: result.message };
  }
  const row = result.row;
  deps.applyLocal(row);
  if (deps.signal !== undefined) {
    let pending: Promise<unknown> | null = null;
    try {
      pending = deps.signal(
        editEventExt({
          messageId: row.id,
          body: row.body ?? '',
          editedAt: row.edited_at ?? new Date().toISOString(),
        }),
      );
    } catch (error) {
      deps.onSignalFailed(error);
    }
    if (pending !== null) void pending.catch((error: unknown) => deps.onSignalFailed(error));
  }
  return { ok: true };
}
