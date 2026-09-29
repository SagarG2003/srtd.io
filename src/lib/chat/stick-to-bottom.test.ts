import { describe, expect, it } from 'vitest';
import {
  distanceFromBottom,
  intentAfterNewest,
  intentAfterScroll,
  isScrollKey,
  openingIntent,
  sizeChangeAction,
  type ScrollMetrics,
  type ScrollSource,
} from './stick-to-bottom';
import { NEAR_BOTTOM_THRESHOLD_PX } from './scroll';

/**
 * A thread list as MessageThread wires it: gestures mark the source 'user',
 * every scroll the thread makes marks it 'program', scroll events step the
 * intent, and any size change pins while the intent holds.
 */
function simulatedThread(): {
  metrics: ScrollMetrics;
  intent: () => boolean;
  gesture: (scrollTop: number) => void;
  programScroll: (scrollTop: number) => void;
  grow: (px: number, context?: { pendingJump?: boolean; olderPageRestore?: boolean }) => void;
  newest: (message: { id: string; mine: boolean }) => void;
} {
  const metrics: ScrollMetrics = { scrollTop: 0, scrollHeight: 2000, clientHeight: 600 };
  let intent = openingIntent();
  let source: ScrollSource = 'program';
  let lastId: string | null = null;
  const scrolled = (): void => {
    intent = intentAfterScroll({ intent, source, distanceFromBottom: distanceFromBottom(metrics) });
  };
  const pin = (): void => {
    source = 'program';
    metrics.scrollTop = metrics.scrollHeight - metrics.clientHeight;
    scrolled();
  };
  pin();
  return {
    metrics,
    intent: () => intent,
    gesture: (scrollTop) => {
      source = 'user';
      metrics.scrollTop = scrollTop;
      scrolled();
    },
    programScroll: (scrollTop) => {
      source = 'program';
      metrics.scrollTop = scrollTop;
      scrolled();
    },
    grow: (px, context = {}) => {
      metrics.scrollHeight += px;
      const action = sizeChangeAction({
        intent,
        pendingJump: context.pendingJump === true,
        olderPageRestore: context.olderPageRestore === true,
      });
      if (action === 'pin') pin();
    },
    newest: (message) => {
      intent = intentAfterNewest({ intent, newest: message, previousNewestId: lastId });
      lastId = message.id;
      if (intent) pin();
    },
  };
}

describe('stick-to-bottom intent', () => {
  it('opens holding the bottom', () => {
    expect(openingIntent()).toBe(true);
    const thread = simulatedThread();
    expect(distanceFromBottom(thread.metrics)).toBe(0);
  });

  it('a programmatic scroll never flips the intent, even far from the bottom', () => {
    expect(intentAfterScroll({ intent: true, source: 'program', distanceFromBottom: 5000 })).toBe(
      true,
    );
    expect(intentAfterScroll({ intent: false, source: 'program', distanceFromBottom: 0 })).toBe(
      false,
    );
    // A smooth scroll aimed at a stale height leaves the list short of the bottom.
    const thread = simulatedThread();
    thread.metrics.scrollHeight += 800;
    thread.programScroll(thread.metrics.scrollTop + 10);
    expect(thread.intent()).toBe(true);
  });

  it('a gesture past 120px lets go; back within 120px takes hold again', () => {
    const t = NEAR_BOTTOM_THRESHOLD_PX;
    expect(intentAfterScroll({ intent: true, source: 'user', distanceFromBottom: t + 1 })).toBe(
      false,
    );
    expect(intentAfterScroll({ intent: false, source: 'user', distanceFromBottom: t })).toBe(true);
    const thread = simulatedThread();
    const bottom = thread.metrics.scrollTop;
    thread.gesture(bottom - 121);
    expect(thread.intent()).toBe(false);
    thread.gesture(bottom - 60);
    expect(thread.intent()).toBe(true);
  });

  it('growth pins while the intent holds and leaves a reader who scrolled up', () => {
    expect(sizeChangeAction({ intent: true, pendingJump: false, olderPageRestore: false })).toBe(
      'pin',
    );
    expect(sizeChangeAction({ intent: false, pendingJump: false, olderPageRestore: false })).toBe(
      'leave',
    );
    const pinned = simulatedThread();
    pinned.grow(180); // a card skeleton becomes the card
    pinned.grow(24); // mark badges land
    pinned.grow(28); // the typing row
    expect(distanceFromBottom(pinned.metrics)).toBe(0);
    const reading = simulatedThread();
    reading.gesture(200);
    reading.grow(180);
    expect(reading.metrics.scrollTop).toBe(200);
    expect(reading.intent()).toBe(false);
  });

  it('a pending jump beats the pin', () => {
    expect(sizeChangeAction({ intent: true, pendingJump: true, olderPageRestore: false })).toBe(
      'leave',
    );
  });

  it('an older-page restore beats the pin', () => {
    expect(sizeChangeAction({ intent: true, pendingJump: false, olderPageRestore: true })).toBe(
      'leave',
    );
  });

  it('an own send takes hold again; an incoming message or a re-render does not', () => {
    const own = { id: 'm2', mine: true };
    expect(intentAfterNewest({ intent: false, newest: own, previousNewestId: 'm1' })).toBe(true);
    const peer = { id: 'm3', mine: false };
    expect(intentAfterNewest({ intent: false, newest: peer, previousNewestId: 'm2' })).toBe(false);
    // The same own message re-rendering (a status or receipt change) never yanks.
    expect(intentAfterNewest({ intent: false, newest: own, previousNewestId: 'm2' })).toBe(false);
    expect(intentAfterNewest({ intent: true, newest: undefined, previousNewestId: null })).toBe(
      true,
    );
    const thread = simulatedThread();
    thread.newest({ id: 'a', mine: false });
    thread.gesture(0);
    thread.newest({ id: 'b', mine: true });
    expect(thread.intent()).toBe(true);
    expect(distanceFromBottom(thread.metrics)).toBe(0);
  });

  it('two channels with the same title each open pinned at the bottom', () => {
    // The thread is keyed by channel id, so each chat mounts with fresh state
    // even when the titles match.
    const first = simulatedThread();
    first.gesture(0);
    expect(first.intent()).toBe(false);
    const second = simulatedThread();
    expect(second.intent()).toBe(true);
    second.grow(300);
    expect(distanceFromBottom(second.metrics)).toBe(0);
  });

  it('scroll keys are gestures; typing keys are not', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']) {
      expect(isScrollKey(key)).toBe(true);
    }
    expect(isScrollKey('a')).toBe(false);
    expect(isScrollKey('Enter')).toBe(false);
  });
});
