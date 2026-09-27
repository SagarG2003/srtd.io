// Delete own messages for everyone: record first (chat_message_delete, chunked
// at 100 ids per call), then for each accepted chunk drop the ids locally and
// signal peers live with ext { sorted_event: 'delete', message_ids }. A failed
// signal never fails the delete (the rows are gone; a receiver that misses it
// stops seeing them on its next history load). Pure of React and the SDK so the
// ordering is unit-tested directly.

import type { Client } from '@srtdio/rpc';
import { deleteMessagesRecord } from '@/lib/chat/record';
import { deleteEventExt } from '@/lib/chat/thread';

export interface DeleteFlowDeps {
  client: Client;
  /** Drop accepted ids from the thread (and store). */
  removeLocal: (ids: string[]) => void;
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
      deps.removeLocal(ids);
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
