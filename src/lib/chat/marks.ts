// Message marks (commitment / decision / pending) and the pure pieces around
// them: the RLS-scoped reads of public.chat_message_marks (one query per channel
// open and per catch-up, one row per live signal), the menu options per mark
// state, badge labels, the strip counts, the sheet orderings, the multi-select
// rules for deleting own messages, and the bounded "load older until found"
// loop behind jump-to-message. Writes live in record.ts. Framework-free, so every
// rule is unit-tested with no DOM and no database.
//
// A message carries at most one mark. Commitment and decision are frozen once
// set (no unmark, no edit); pending can have its priority changed and can be
// resolved, after which it is frozen too. A resolved row is kept in memory (it
// still locks the message against delete, as the proc does) but shows no badge
// and no list row.

import type { AgoraChat } from 'agora-chat';
import type { Client, Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import type { MarkPriority, MarkType } from '@/lib/chat/record';
import {
  parseLiveEvent,
  type ChatMessageRow,
  type MessageCursor,
  type ThreadMessage,
} from '@/lib/chat/thread';
import type { HistoryPage } from '@/lib/chat/history';
import type { ChatConnection } from '@/lib/chat/types';

export type { MarkPriority, MarkType } from '@/lib/chat/record';

type ChatMarkRow = Database['public']['Tables']['chat_message_marks']['Row'];

/** One mark as the thread renders it. */
export interface ChatMark {
  messageId: string;
  channelId: string;
  type: MarkType;
  priority: MarkPriority;
  markedAt: string;
  resolved: boolean;
}

const MARK_COLUMNS =
  'message_id, channel_id, workspace_id, mark_type, priority, marked_by, marked_at, resolved_by, resolved_at';

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
}

function markType(value: string): MarkType | undefined {
  return value === 'commitment' || value === 'decision' || value === 'pending' ? value : undefined;
}

/** Map a row; a row with an unknown mark type (CHECK makes it impossible) is skipped. */
export function rowToMark(row: ChatMarkRow): ChatMark | undefined {
  const type = markType(row.mark_type);
  if (type === undefined) return undefined;
  const priority: MarkPriority =
    type === 'pending' && (row.priority === 1 || row.priority === 2) ? row.priority : null;
  return {
    messageId: row.message_id,
    channelId: row.channel_id,
    type,
    priority,
    markedAt: row.marked_at,
    resolved: row.resolved_at !== null,
  };
}

/** Index marks by message id. */
export function indexMarks(marks: readonly ChatMark[]): Map<string, ChatMark> {
  const map = new Map<string, ChatMark>();
  for (const mark of marks) map.set(mark.messageId, mark);
  return map;
}

/** Every mark row of one channel (RLS: channel members only), one query. */
export async function loadChannelMarks(
  client: Client,
  channelId: string,
): Promise<Result<ChatMark[]>> {
  const res = await client
    .from('chat_message_marks')
    .select(MARK_COLUMNS)
    .eq('channel_id', channelId);
  if (res.error) return fail(`loadChannelMarks: ${res.error.message}`);
  const rows = (res.data ?? []) as ChatMarkRow[];
  const marks: ChatMark[] = [];
  for (const row of rows) {
    const mark = rowToMark(row);
    if (mark !== undefined) marks.push(mark);
  }
  return { ok: true, data: marks };
}

export type MarkLookup = { found: true; mark: ChatMark } | { found: false };

/** One mark row by message id, after a live mark signal. */
export async function loadMarkByMessageId(
  client: Client,
  messageId: string,
): Promise<Result<MarkLookup>> {
  const res = await client
    .from('chat_message_marks')
    .select(MARK_COLUMNS)
    .eq('message_id', messageId)
    .maybeSingle();
  if (res.error) return fail(`loadMarkByMessageId: ${res.error.message}`);
  const row = res.data as ChatMarkRow | null;
  const mark = row === null ? undefined : rowToMark(row);
  return { ok: true, data: mark === undefined ? { found: false } : { found: true, mark } };
}

/** Upsert one mark into the index (new Map; the input is not mutated). */
export function upsertMark(marks: Map<string, ChatMark>, mark: ChatMark): Map<string, ChatMark> {
  const next = new Map(marks);
  next.set(mark.messageId, mark);
  return next;
}

/** The mark types in menu order. */
export const MARK_TYPES: readonly MarkType[] = ['commitment', 'decision', 'pending'];

const TYPE_LABEL: Record<MarkType, string> = {
  commitment: 'Commitment',
  decision: 'Decision',
  pending: 'Pending',
};

/** The menu label for marking a message with a type. */
export function markMenuLabel(type: MarkType): string {
  return `Mark as ${TYPE_LABEL[type]}`;
}

/**
 * The mark actions the message menu offers: all three types for an unmarked
 * recorded message, nothing once it carries any mark (commitment and decision
 * are frozen; a pending priority changes from its badge, not the menu).
 */
export function markMenuOptions(
  message: Pick<ThreadMessage, 'state'>,
  mark: ChatMark | undefined,
): MarkType[] {
  if (message.state !== 'sent') return [];
  return mark === undefined ? [...MARK_TYPES] : [];
}

/** Whether tapping the badge opens the priority chooser (open pending only). */
export function canChangePriority(mark: ChatMark | undefined): boolean {
  return mark !== undefined && mark.type === 'pending' && !mark.resolved;
}

/** The P1 / P2 suffix; '' when unranked. */
export function priorityLabel(priority: MarkPriority): string {
  return priority === null ? '' : `P${priority}`;
}

/** Bubble badge text; '' (no badge) when unmarked or resolved. */
export function markBadgeLabel(mark: ChatMark | undefined): string {
  if (mark === undefined || mark.resolved) return '';
  const base = TYPE_LABEL[mark.type];
  return mark.type === 'pending' && mark.priority !== null
    ? `${base} ${priorityLabel(mark.priority)}`
    : base;
}

export interface MarkCounts {
  commitments: number;
  decisions: number;
  pending: number;
  p1: number;
}

/** Counts over open marks (resolved pending excluded). */
export function markCounts(marks: Iterable<ChatMark>): MarkCounts {
  const counts: MarkCounts = { commitments: 0, decisions: 0, pending: 0, p1: 0 };
  for (const mark of marks) {
    if (mark.resolved) continue;
    if (mark.type === 'commitment') counts.commitments += 1;
    else if (mark.type === 'decision') counts.decisions += 1;
    else {
      counts.pending += 1;
      if (mark.priority === 1) counts.p1 += 1;
    }
  }
  return counts;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The strip line: "N commitments · N decisions · N pending (N P1)", zero
 * counts hidden; '' when there is nothing to show (the strip hides).
 */
export function markStripLabel(counts: MarkCounts): string {
  const parts: string[] = [];
  if (counts.commitments > 0) parts.push(plural(counts.commitments, 'commitment', 'commitments'));
  if (counts.decisions > 0) parts.push(plural(counts.decisions, 'decision', 'decisions'));
  if (counts.pending > 0) {
    parts.push(`${counts.pending} pending${counts.p1 > 0 ? ` (${counts.p1} P1)` : ''}`);
  }
  return parts.join(' · ');
}

/** The sheet tabs. */
export type MarkTab = 'commitment' | 'decision' | 'pending';

export const MARK_TABS: ReadonlyArray<{ key: MarkTab; label: string }> = [
  { key: 'commitment', label: 'Commitments' },
  { key: 'decision', label: 'Decisions' },
  { key: 'pending', label: 'Pending' },
];

/** Epoch ms used for ordering: the marked message's time, else marked_at. */
export type MarkTimeOf = (mark: ChatMark) => number;

function priorityRank(priority: MarkPriority): number {
  return priority === null ? 3 : priority;
}

/**
 * One tab's rows, open marks only. Commitments and decisions newest first;
 * pending P1, then P2, then unranked, each oldest first.
 */
export function marksForTab(
  marks: Iterable<ChatMark>,
  tab: MarkTab,
  timeOf: MarkTimeOf,
): ChatMark[] {
  const list = [...marks].filter((m) => !m.resolved && m.type === tab);
  if (tab === 'pending') {
    return list.sort((a, b) => {
      const rank = priorityRank(a.priority) - priorityRank(b.priority);
      return rank !== 0 ? rank : timeOf(a) - timeOf(b);
    });
  }
  return list.sort((a, b) => timeOf(b) - timeOf(a));
}

/** Longest body snippet a sheet row shows. */
export const MARK_ROW_SNIPPET = 80;

/** A row's line: the first 80 chars of the body, else the shared card title, else a label. */
export function markRowText(
  message:
    | Pick<ThreadMessage, 'body' | 'attachments' | 'sharedPostIds' | 'sharedBriefIds'>
    | undefined,
  cardTitle: string | undefined,
): string {
  if (message === undefined) return 'Message';
  const body = message.body.trim();
  if (body !== '')
    return body.length > MARK_ROW_SNIPPET ? `${body.slice(0, MARK_ROW_SNIPPET)}…` : body;
  if (cardTitle !== undefined && cardTitle !== '') return cardTitle;
  if (message.sharedPostIds.length > 0) return 'Shared post';
  if (message.sharedBriefIds.length > 0) return 'Shared brief';
  if (message.attachments.length > 0) return 'Attachment';
  return 'Message';
}

/** How a message participates in selection mode. */
export type SelectionRole = 'selectable' | 'locked' | 'none';

/**
 * Selection mode shows a checkbox only on the caller's own recorded, unmarked
 * messages; own marked messages (any mark, resolved included, as the proc
 * blocks them) show a lock; everything else shows nothing.
 */
export function selectionRole(
  message: Pick<ThreadMessage, 'id' | 'mine' | 'state'>,
  marks: Map<string, ChatMark>,
): SelectionRole {
  if (!message.mine || message.state !== 'sent') return 'none';
  return marks.has(message.id) ? 'locked' : 'selectable';
}

/** Toggle an id in a selection (new Set). */
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Keep only selected ids that are still selectable (a mark or delete may land meanwhile). */
export function pruneSelection(
  selected: ReadonlySet<string>,
  messages: readonly ThreadMessage[],
  marks: Map<string, ChatMark>,
): Set<string> {
  const allowed = new Set(
    messages.filter((m) => selectionRole(m, marks) === 'selectable').map((m) => m.id),
  );
  return new Set([...selected].filter((id) => allowed.has(id)));
}

/** Confirm sheet title. */
export function deleteConfirmTitle(count: number): string {
  return `Delete ${count} ${count === 1 ? 'message' : 'messages'} for everyone?`;
}

/** Older pages jump-to loads before giving up. */
export const JUMP_MAX_PAGES = 10;

export type FindOlderOutcome = 'found' | 'not_found' | 'exhausted' | 'error';

/**
 * Page older history from `start` until a page contains `targetId`, at most
 * `maxPages` pages. Each page is handed to `onPage` (the caller folds it into
 * the thread) before the check. 'not_found' means history ran out, 'exhausted'
 * means the page cap was hit.
 */
export async function findInOlderPages(params: {
  start: MessageCursor | undefined;
  targetId: string;
  loadPage: (cursor: MessageCursor) => Promise<Result<HistoryPage>>;
  onPage: (rows: ChatMessageRow[], hasMore: boolean) => void;
  maxPages?: number;
}): Promise<FindOlderOutcome> {
  const maxPages = params.maxPages ?? JUMP_MAX_PAGES;
  let cursor = params.start;
  for (let page = 0; page < maxPages; page += 1) {
    if (cursor === undefined) return 'not_found';
    const result = await params.loadPage(cursor);
    if (!result.ok) return 'error';
    const rows = result.data.rows;
    params.onPage(rows, result.data.hasMore);
    if (rows.some((row) => row.id === params.targetId)) return 'found';
    if (!result.data.hasMore) return 'not_found';
    const oldest = rows[0];
    cursor = oldest === undefined ? undefined : { createdAt: oldest.created_at, id: oldest.id };
  }
  return 'exhausted';
}

/** The marks subscription's own SDK handler id. */
export const MARKS_EVENT_HANDLER_ID = 'chat-marks';

/** The connection slice the marks subscription needs. */
export type MarksConnection = Pick<ChatConnection, 'addEventHandler' | 'removeEventHandler'>;

/** Subscribe to live mark signals; returns the teardown. */
export function subscribeMarkEvents(
  connection: MarksConnection,
  onMark: (messageId: string) => void,
): () => void {
  const handler: AgoraChat.EventHandlerType = {
    onCmdMessage: (raw) => {
      const event = parseLiveEvent(raw.ext);
      if (event.kind === 'mark') onMark(event.messageId);
    },
  };
  connection.addEventHandler(MARKS_EVENT_HANDLER_ID, handler);
  return () => connection.removeEventHandler(MARKS_EVENT_HANDLER_ID);
}
