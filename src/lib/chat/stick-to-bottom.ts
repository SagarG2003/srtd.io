/**
 * Stick-to-bottom for the chat thread (WhatsApp behaviour), as pure decisions
 * the thread wires to its events, observers and refs. The thread keeps an
 * INTENT to stay on the latest message rather than asking "is it at the bottom
 * now": only the reader's own gestures change it, so late growth (cards, marks,
 * badges, fonts, the composer) re-pins while it holds and never yanks a reader
 * who scrolled up to read history.
 */
import { NEAR_BOTTOM_THRESHOLD_PX } from '@/lib/chat/scroll';

/** The scroll geometry of the thread list. */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Who moved the list last: 'user' after a touch, wheel, scroll key or scrollbar
 * press; 'program' once the thread itself scrolls (a pin, a jump, the
 * older-page restore), whose scroll events never change the intent.
 */
export type ScrollSource = 'user' | 'program';

/** The unseen px below the fold; 0 when pinned to the latest message. */
export function distanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
}

/**
 * The intent after a scroll event: a user gesture that leaves the view more
 * than 120px from the bottom lets go, one within 120px takes hold again; a
 * programmatic scroll keeps whatever it was.
 */
export function intentAfterScroll(input: {
  intent: boolean;
  source: ScrollSource;
  distanceFromBottom: number;
}): boolean {
  if (input.source === 'program') return input.intent;
  return input.distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX;
}

/**
 * What a change in content height or list height does: pin to the bottom while
 * the intent holds, unless a pending jump owns the position or an older page is
 * being restored under the reader.
 */
export function sizeChangeAction(input: {
  intent: boolean;
  pendingJump: boolean;
  olderPageRestore: boolean;
}): 'pin' | 'leave' {
  if (input.pendingJump || input.olderPageRestore) return 'leave';
  return input.intent ? 'pin' : 'leave';
}

/**
 * The intent when the newest message changes: an own send always takes hold
 * again (the reader wants to see it land); anything else keeps the intent.
 */
export function intentAfterNewest(input: {
  intent: boolean;
  newest: { id: string; mine: boolean } | undefined;
  previousNewestId: string | null;
}): boolean {
  const newest = input.newest;
  if (newest === undefined || newest.id === input.previousNewestId) return input.intent;
  return newest.mine ? true : input.intent;
}

/** A thread opens holding the bottom, before any gesture. */
export function openingIntent(): boolean {
  return true;
}

/** Keys that scroll a focused list: arrows, pages, Home / End and Space. */
const SCROLL_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
]);

/** Whether a keydown on the list is a scroll gesture. */
export function isScrollKey(key: string): boolean {
  return SCROLL_KEYS.has(key);
}
