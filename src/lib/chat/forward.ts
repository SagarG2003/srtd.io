// Forwarding messages to other chats. Pure pieces only (no React, no SDK, no
// client) so the unit job covers them: which messages can be forwarded and in
// what order, the thread's selection rules now that selection serves both
// Forward (anyone's recorded message) and Delete (own, unmarked only), the
// picker's channel list and copy, the record input for one forwarded copy, and
// the sequential run that stops at the first failing chat.

import type { ChannelSummary } from '@/lib/chat-reads';
import { filterChannelsByName } from '@/lib/channel-filter';
import { sortChannelsByRecency, type RecencySummary } from '@/lib/chat/sort-conversations';
import { buildAttachmentMeta } from '@/lib/chat/attachments';
import { previewText } from '@/lib/chat/chat-store';
import { selectionRole, type ChatMark } from '@/lib/chat/marks';
import type { SendRecordParams } from '@/lib/chat/record';
import { compareMessages, type ThreadMessage } from '@/lib/chat/thread';

/**
 * Only a recorded message can be forwarded: a sending or failed bubble has no
 * row yet, and a deleted message has left the thread (and the history reads).
 */
export function canForward(message: Pick<ThreadMessage, 'state'>): boolean {
  return message.state === 'sent';
}

/** The forwardable messages among `messages`, in thread (original) order. */
export function forwardableInOrder(messages: readonly ThreadMessage[]): ThreadMessage[] {
  return messages.filter(canForward).sort(compareMessages);
}

/** Selection mode in the thread: any recorded message can be checked. */
export function threadSelectable(message: Pick<ThreadMessage, 'state'>): boolean {
  return canForward(message);
}

/** Keep only selected ids that are still loaded and forwardable. */
export function pruneThreadSelection(
  selected: ReadonlySet<string>,
  messages: readonly ThreadMessage[],
): Set<string> {
  const allowed = new Set(messages.filter(threadSelectable).map((m) => m.id));
  return new Set([...selected].filter((id) => allowed.has(id)));
}

/**
 * Delete stays own-only: every selected message must be the caller's own,
 * recorded and unmarked (the proc refuses marked ones). False at 0.
 */
export function canDeleteSelection(
  selected: ReadonlySet<string>,
  messages: readonly ThreadMessage[],
  marks: Map<string, ChatMark>,
): boolean {
  if (selected.size === 0) return false;
  const byId = new Map(messages.map((m) => [m.id, m]));
  for (const id of selected) {
    const message = byId.get(id);
    if (message === undefined || selectionRole(message, marks) !== 'selectable') return false;
  }
  return true;
}

/** The selected messages to forward, in thread order. */
export function selectedForForward(
  selected: ReadonlySet<string>,
  messages: readonly ThreadMessage[],
): ThreadMessage[] {
  return forwardableInOrder(messages.filter((m) => selected.has(m.id)));
}

/**
 * The picker's chats: every channel the caller is in (hidden ones included),
 * most recent first, then narrowed by the name search.
 */
export function forwardPickerChannels(
  channels: readonly ChannelSummary[],
  summaryFor: (channelId: string) => RecencySummary | undefined,
  query: string,
): ChannelSummary[] {
  return filterChannelsByName(sortChannelsByRecency(channels, summaryFor), query);
}

/** Toggle a chat in the picker's selection (new Set). */
export function toggleForwardTarget(selected: ReadonlySet<string>, channelId: string): Set<string> {
  const next = new Set(selected);
  if (next.has(channelId)) next.delete(channelId);
  else next.add(channelId);
  return next;
}

/** The picker's send button label. */
export function sendToLabel(count: number): string {
  return `Send to ${count} ${count === 1 ? 'chat' : 'chats'}`;
}

/** Toast when forwarding to a chat failed. */
export function forwardFailedMessage(title: string): string {
  return `Could not forward to ${title}.`;
}

/** The label shown above a forwarded message's body. */
export const FORWARDED_LABEL = 'Forwarded';

/**
 * The record input for one forwarded copy: a fresh id, the source's body,
 * attachments (same asset ids and meta, never re-uploaded), shared posts and
 * briefs, no reply, no mentions, and the source id. Marks are not carried.
 */
export function forwardRecordInput(
  source: ThreadMessage,
  ids: { id: string; channelId: string; traceId: string },
): Omit<SendRecordParams, 'client'> {
  return {
    id: ids.id,
    channelId: ids.channelId,
    traceId: ids.traceId,
    body: source.body,
    attachmentAssetIds: source.attachments.map((a) => a.assetId),
    attachmentMeta: buildAttachmentMeta(source.attachments),
    sharedPostIds: [...source.sharedPostIds],
    sharedBriefIds: [...source.sharedBriefIds],
    replyToMessageId: null,
    forwardedFromMessageId: source.id,
  };
}

/** The chat-list preview line for a forwarded copy. */
export function forwardPreviewText(source: ThreadMessage): string {
  return previewText({
    body: source.body,
    hasAttachments:
      source.attachments.length > 0 ||
      source.sharedPostIds.length > 0 ||
      source.sharedBriefIds.length > 0,
  });
}

export type ForwardRunResult<T> = { ok: true } | { ok: false; failed: T; message: string };

/**
 * Forward sequentially: for each chat, each message in order. The first failed
 * send stops the whole run and names its chat; chats after it are untouched.
 */
export async function runForward<T>(deps: {
  targets: readonly T[];
  messages: readonly ThreadMessage[];
  sendOne: (
    target: T,
    message: ThreadMessage,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
}): Promise<ForwardRunResult<T>> {
  for (const target of deps.targets) {
    for (const message of deps.messages) {
      const result = await deps.sendOne(target, message);
      if (!result.ok) return { ok: false, failed: target, message: result.message };
    }
  }
  return { ok: true };
}
