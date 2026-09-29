// Post references in a thread, pure. A card message is one that shares posts
// (shared_post_ids). A message "about" a post is a reply whose target is a card
// message: it renders a KEY chip instead of a quote, and the per-post filter
// keeps the post's card messages plus the replies to them. The composer's hash
// picker opens while the text at the caret is a hash token. Client-side over the
// loaded pages only; no reads here.

import type { ReplyQuote } from '@/lib/chat/attachments';
import type { ThreadMessage } from '@/lib/chat/thread';

type CardFields = Pick<ThreadMessage, 'sharedPostIds'>;
type RefFields = Pick<ThreadMessage, 'id' | 'sharedPostIds' | 'reply' | 'parentSharedPostIds'>;

/** Post ids of a card message, keyed by its message id. */
export type ParentIndex = ReadonlyMap<string, readonly string[]>;

/** The chip a message carries: the card message it replies to and that card's post. */
export interface ChipTarget {
  cardMessageId: string;
  postId: string;
}

/** A message that shares at least one post (it renders post cards). */
export function isCardMessage(row: CardFields): boolean {
  return row.sharedPostIds.length > 0;
}

/** Index the loaded card messages by id (the chip parents present in the pages). */
export function parentIndexOf(rows: readonly RefFields[]): Map<string, readonly string[]> {
  const index = new Map<string, readonly string[]>();
  for (const row of rows) if (isCardMessage(row)) index.set(row.id, row.sharedPostIds);
  return index;
}

/**
 * The chip for a message, or null when its reply target is not a card message.
 * The parent's post ids come from the loaded row when present, else from the
 * hydrated parentSharedPostIds (the resolveReplies IN read). A card that shares
 * several posts is about its first.
 */
export function chipTargetFor(row: RefFields, parentIndex: ParentIndex): ChipTarget | null {
  if (row.reply === null) return null;
  const postIds = parentIndex.get(row.reply.id) ?? row.parentSharedPostIds ?? [];
  const postId = postIds[0];
  return postId !== undefined ? { cardMessageId: row.reply.id, postId } : null;
}

/** The distinct post ids of every chip in the rows, sorted (the chip batch's key). */
export function chipPostIds(rows: readonly RefFields[], parentIndex: ParentIndex): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const target = chipTargetFor(row, parentIndex);
    if (target !== null) ids.add(target.postId);
  }
  return [...ids].sort();
}

/** The newest loaded card message sharing the post, or null. */
export function newestCardFor<T extends Pick<ThreadMessage, 'id' | 'sharedPostIds'>>(
  rows: readonly T[],
  postId: string,
): T | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row !== undefined && row.sharedPostIds.includes(postId)) return row;
  }
  return null;
}

/**
 * The card message a share just queued: the first row sharing the post whose id
 * was not in the list when the share was sent. Null until the outbox bubble lands.
 */
export function newCardFor<T extends Pick<ThreadMessage, 'id' | 'sharedPostIds' | 'mine'>>(
  rows: readonly T[],
  knownIds: ReadonlySet<string>,
  postId: string,
): T | null {
  for (const row of rows) {
    if (row.mine && !knownIds.has(row.id) && row.sharedPostIds.includes(postId)) return row;
  }
  return null;
}

/**
 * One post's conversation: its card messages and every message replying to one
 * of them, in thread order. Status lines ride on their rows.
 */
export function filterRows<T extends RefFields>(rows: readonly T[], postId: string): T[] {
  const cards = new Set(rows.filter((r) => r.sharedPostIds.includes(postId)).map((r) => r.id));
  return rows.filter((r) => cards.has(r.id) || (r.reply !== null && cards.has(r.reply.id)));
}

/**
 * The reply a send carries: the reply draft wins; else the About card, unless
 * the send itself shares posts (a new card is never a reply to the old one).
 */
export function replyForSend(
  reply: ReplyQuote | null,
  about: ReplyQuote | null,
  sharesPosts: boolean,
): ReplyQuote | null {
  if (reply !== null) return reply;
  return sharesPosts ? null : about;
}

/** A hash token ending at the caret: start of text or after whitespace, no spaces. */
const HASH_AT_CARET = /(^|\s)#([^\s#]*)$/;

/** The query typed after a hash at the caret, or null when the caret is not in one. */
export function caretHashQuery(text: string, caret: number): string | null {
  const match = HASH_AT_CARET.exec(text.slice(0, Math.max(0, Math.min(caret, text.length))));
  return match !== null ? (match[2] ?? '') : null;
}

/**
 * Remove the hash token ending at the caret (the whitespace before it stays) and
 * put the caret where the token began. Text without a token is returned as is.
 */
export function stripHashToken(text: string, caret: number): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const query = caretHashQuery(text, at);
  if (query === null) return { text, caret: at };
  const start = at - query.length - 1;
  return { text: text.slice(0, start) + text.slice(at), caret: start };
}
