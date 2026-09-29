// Chat @mentions: the composer's mention map, the wire format and the render
// helpers. A mention travels in the body as the literal `@[<uuid>]` token, the
// same format comments use (@srtdio/comments parseMentions reads it back), and
// chat_message_send / chat_message_edit take the uuids as p_mentions.
//
// The composer shows "@Name" in the textarea and keeps a pick list (id + name).
// On send the text is serialized: every picked "@Name" still intact in the text
// becomes its token; a damaged one stays plain text and its mention drops. The
// body is then the single source of truth: p_mentions is parseMentions(body), so
// a persisted outbox entry (which keeps the body) resends its mentions.
//
// Rendering never shows a raw token: every token resolves to "@Name", or
// "@Unknown member" when the id is not a known profile. Names come from the
// batched profile reads that already hydrate the thread and the chat list; this
// module also keeps a small in-memory name registry (like the drafts map) so a
// draft's tokens resolve in the chat list's "Draft:" line.
//
// Pure except for the registry, so everything is unit-tested without React.

import { parseMentions } from '@srtdio/comments';

/** A picked mention: the member's user id and the display name typed in. */
export interface MentionPick {
  userId: string;
  name: string;
}

/** Resolve a user id to a display name; undefined when unknown. */
export type NameOf = (userId: string) => string | undefined;

/** One run of a body: plain text, or a mention token's user id. */
export type BodySegment = { kind: 'text'; text: string } | { kind: 'mention'; userId: string };

/** The label an unresolvable mention renders as (after the "@"). */
export const UNKNOWN_MEMBER = 'Unknown member';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** A fresh global token matcher (a shared /g regex would carry lastIndex). */
function tokenPattern(): RegExp {
  return new RegExp(`@\\[(${UUID})\\]`, 'gi');
}

/** The distinct mentioned user ids of a body, in first-seen order (lowercase). */
export function mentionIds(body: string): string[] {
  return parseMentions(body);
}

/** Split a body into text runs and mention tokens. Adjacent text stays one run. */
export function splitMentions(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let last = 0;
  for (const match of body.matchAll(tokenPattern())) {
    const at = match.index ?? 0;
    if (at > last) segments.push({ kind: 'text', text: body.slice(last, at) });
    segments.push({ kind: 'mention', userId: (match[1] ?? '').toLowerCase() });
    last = at + match[0].length;
  }
  if (last < body.length) segments.push({ kind: 'text', text: body.slice(last) });
  return segments;
}

/** "@Name" for a mention, or "@Unknown member" when the id does not resolve. */
export function mentionLabel(userId: string, nameOf: NameOf): string {
  const name = nameOf(userId.toLowerCase());
  return `@${name !== undefined && name !== '' ? name : UNKNOWN_MEMBER}`;
}

/** The body as plain text: every token becomes "@Name". Other text is verbatim. */
export function resolveMentionText(body: string, nameOf: NameOf): string {
  return body.replace(tokenPattern(), (_match, id: string) => mentionLabel(id, nameOf));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The typed "@Name" of one pick, as a matcher: it counts only at the start of
 * the text or after whitespace, and only when the name is not followed by
 * another letter or digit (so "@Al" never matches inside "@Alex").
 */
function pickPattern(name: string): RegExp {
  return new RegExp(`(^|\\s)@${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'gu');
}

/**
 * The textarea text as the body the server stores: each pick whose "@Name" is
 * still intact becomes `@[uuid]`. Longer names go first so a name that is a
 * prefix of another never splits it. A damaged "@Name" is left as typed.
 */
export function serializeMentions(text: string, picks: readonly MentionPick[]): string {
  const ordered = [...picks].sort((a, b) => b.name.length - a.name.length);
  let out = text;
  for (const pick of ordered) {
    if (pick.name === '') continue;
    out = out.replace(pickPattern(pick.name), (_match, lead: string) => `${lead}@[${pick.userId}]`);
  }
  return out;
}

/**
 * A stored body back as textarea text plus its picks (the edit box and a
 * restored draft): every token becomes "@Name" and a pick. A token whose id does
 * not resolve reads "@Unknown member" and is not a pick, so it drops on save.
 */
export function deserializeMentions(
  body: string,
  nameOf: NameOf,
): { text: string; picks: MentionPick[] } {
  let picks: MentionPick[] = [];
  const text = body.replace(tokenPattern(), (_match, raw: string) => {
    const userId = raw.toLowerCase();
    const name = nameOf(userId);
    if (name === undefined || name === '') return `@${UNKNOWN_MEMBER}`;
    picks = addPick(picks, { userId, name });
    return `@${name}`;
  });
  return { text, picks };
}

/** Add a pick; the same person picked twice stays one entry (the newest name). */
export function addPick(picks: readonly MentionPick[], pick: MentionPick): MentionPick[] {
  return [...picks.filter((p) => p.userId !== pick.userId), pick];
}

/**
 * The open mention run before the caret: an "@" at the start of the text or
 * right after whitespace, followed by no whitespace up to the caret. Returns the
 * "@" index and the typed query (possibly empty), or null when none is open.
 */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1] ?? '')) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/** Replace the open "@query" run with "@Name " and put the caret after it. */
export function insertMention(
  text: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const open = mentionQuery(text, caret);
  if (open === null) return { text, caret };
  const inserted = `@${name} `;
  const after = text.slice(caret).replace(/^ /, '');
  return {
    text: `${text.slice(0, open.start)}${inserted}${after}`,
    caret: open.start + inserted.length,
  };
}

/** A person the picker can offer. */
export interface MentionMember {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  /** Raw workspace role; labelled at render. Null when unknown. */
  role: string | null;
}

/**
 * The picker rows for a query: every member but me whose display name contains
 * the query (case-insensitive), names starting with it first, then by name.
 */
export function filterMentionMembers(
  members: readonly MentionMember[],
  query: string,
  selfId: string | null,
): MentionMember[] {
  const q = query.trim().toLowerCase();
  const rank = (m: MentionMember): number => (m.displayName.toLowerCase().startsWith(q) ? 0 : 1);
  return members
    .filter((m) => m.userId !== selfId && m.displayName.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName));
}

/**
 * Cut a body to at most `limit` characters without splitting a token: a cut
 * inside one keeps the whole token. An ellipsis marks any cut.
 */
export function truncateBody(body: string, limit: number): string {
  if (body.length <= limit) return body;
  let end = limit;
  for (const match of body.matchAll(tokenPattern())) {
    const at = match.index ?? 0;
    if (at >= limit) break;
    if (at + match[0].length > limit) end = at + match[0].length;
  }
  return end >= body.length ? body : `${body.slice(0, end)}…`;
}

/** The caret in serialized (token) coordinates, for a draft that stores the body. */
export function serializedCaret(
  text: string,
  caret: number,
  picks: readonly MentionPick[],
): number {
  return serializeMentions(text.slice(0, caret), picks).length;
}

/** A stored draft's caret back in textarea coordinates (a cut token rounds down). */
export function displayCaret(body: string, caret: number, nameOf: NameOf): number {
  let head = body.slice(0, caret);
  const open = head.lastIndexOf('@[');
  if (open !== -1 && !head.slice(open).includes(']')) head = head.slice(0, open);
  return deserializeMentions(head, nameOf).text.length;
}

// --- name registry -----------------------------------------------------------

const names = new Map<string, string>();

/** Remember display names from any batched profile read (or a pick). */
export function rememberMentionNames(
  entries: Iterable<{ userId: string; displayName: string }>,
): void {
  for (const entry of entries) {
    if (entry.displayName !== '') names.set(entry.userId.toLowerCase(), entry.displayName);
  }
}

/** A remembered display name, or undefined. */
export const knownMentionName: NameOf = (userId) => names.get(userId.toLowerCase());

/** Test-only: forget every remembered name. */
export function resetMentionNames(): void {
  names.clear();
}
