// One composer draft per chat, like WhatsApp: the text, caret, reply target,
// shared cards and picked files typed into a chat stay with that chat when
// another one opens, and come back when it reopens. In memory only (never
// localStorage): a reload starts clean. Keyed by the Sorted channel id, never by
// the title. Plain get / set / clear over one module map, plus a version and a
// subscribe so the chat list can show "Draft:" previews.

import type { PostCardFields } from '@srtdio/posts';
import type { BriefCardFields } from '@/lib/chat/briefs';
import type { ReplyQuote } from '@/lib/chat/attachments';

/** A picked file waiting in a draft (the composer's chip). */
export interface DraftFile {
  id: string;
  file: File;
  previewUrl: string | null;
}

/** The reply a draft carries: its quote (quote.id is the replied-to message id). */
export interface DraftReply {
  authorName: string;
  quote: ReplyQuote;
  /**
   * The quoted message was deleted for everyone: the quote's text is gone and
   * the reply bar reads deletedMessageLabel. Absent is the same as false.
   */
  deleted?: true;
}

/** A draft reply whose quoted message was deleted: its text stripped, marked deleted. Pure. */
export function strippedReply(reply: DraftReply): DraftReply {
  return reply.deleted === true && reply.quote.preview === ''
    ? reply
    : { ...reply, quote: { ...reply.quote, preview: '' }, deleted: true };
}

export interface ChannelDraft {
  text: string;
  caret: number;
  reply: DraftReply | null;
  sharedPosts: PostCardFields[];
  sharedBriefs: BriefCardFields[];
  pendingFiles: DraftFile[];
}

export const EMPTY_DRAFT: ChannelDraft = Object.freeze({
  text: '',
  caret: 0,
  reply: null,
  sharedPosts: [],
  sharedBriefs: [],
  pendingFiles: [],
}) as ChannelDraft;

const drafts = new Map<string, ChannelDraft>();
const listeners = new Set<() => void>();
let version = 0;

/** Whether a draft carries nothing worth keeping. */
export function isEmptyDraft(draft: ChannelDraft): boolean {
  return (
    draft.text === '' &&
    draft.reply === null &&
    draft.sharedPosts.length === 0 &&
    draft.sharedBriefs.length === 0 &&
    draft.pendingFiles.length === 0
  );
}

function sameDraft(a: ChannelDraft, b: ChannelDraft): boolean {
  return (
    a.text === b.text &&
    a.caret === b.caret &&
    a.reply === b.reply &&
    a.sharedPosts === b.sharedPosts &&
    a.sharedBriefs === b.sharedBriefs &&
    a.pendingFiles === b.pendingFiles
  );
}

function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** The draft of one channel; EMPTY_DRAFT when it has none. */
export function getDraft(channelId: string): ChannelDraft {
  return drafts.get(channelId) ?? EMPTY_DRAFT;
}

/** Merge fields into one channel's draft; an empty result drops the entry. */
export function setDraft(channelId: string, patch: Partial<ChannelDraft>): void {
  const prev = getDraft(channelId);
  const next: ChannelDraft = { ...prev, ...patch };
  if (sameDraft(prev, next)) return;
  if (isEmptyDraft(next)) {
    if (!drafts.has(channelId)) return;
    drafts.delete(channelId);
  } else {
    drafts.set(channelId, next);
  }
  bump();
}

/** Drop one channel's draft (a successful send). */
export function clearDraft(channelId: string): void {
  if (!drafts.delete(channelId)) return;
  bump();
}

/**
 * Messages became tombstones: every draft reply (any chat) that quotes one
 * loses the quoted text and is marked deleted. One bump when anything changed.
 */
export function stripDeletedReplies(messageIds: readonly string[]): void {
  if (messageIds.length === 0) return;
  const hit = new Set(messageIds);
  let changed = false;
  for (const [channelId, draft] of drafts) {
    const reply = draft.reply;
    if (reply === null || !hit.has(reply.quote.id)) continue;
    const next = strippedReply(reply);
    if (next === reply) continue;
    drafts.set(channelId, { ...draft, reply: next });
    changed = true;
  }
  if (changed) bump();
}

/** The draft text a chat list row previews; '' when none. */
export function draftText(channelId: string): string {
  return getDraft(channelId).text.trim() === '' ? '' : getDraft(channelId).text;
}

/** Bumped on every change; the chat list's external-store snapshot. */
export function draftsVersion(): number {
  return version;
}

/** Listen for draft changes; returns the unsubscribe. */
export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: forget every draft. */
export function resetDrafts(): void {
  drafts.clear();
  bump();
}
