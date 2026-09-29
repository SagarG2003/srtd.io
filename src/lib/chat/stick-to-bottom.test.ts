import { describe, expect, it } from 'vitest';
import {
  anchorAfterOlderLoad,
  distanceFromBottom,
  flickInProgress,
  intentAfterNewest,
  intentAfterScroll,
  isScrollKey,
  openingIntent,
  SCROLL_SETTLE_MS,
  sentFromThisDevice,
  settleDecision,
  sizeChangeAction,
  type ScrollMetrics,
  type ScrollSource,
} from './stick-to-bottom';
import { NEAR_BOTTOM_THRESHOLD_PX } from './scroll';
import type { MessageState } from './thread';

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
  newest: (message: { id: string; mine: boolean; state: MessageState }) => void;
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
        flicking: false,
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
    expect(
      sizeChangeAction({
        intent: true,
        pendingJump: false,
        olderPageRestore: false,
        flicking: false,
      }),
    ).toBe('pin');
    expect(
      sizeChangeAction({
        intent: false,
        pendingJump: false,
        olderPageRestore: false,
        flicking: false,
      }),
    ).toBe('leave');
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
    expect(
      sizeChangeAction({
        intent: true,
        pendingJump: true,
        olderPageRestore: false,
        flicking: false,
      }),
    ).toBe('leave');
  });

  it('an older-page restore beats the pin', () => {
    expect(
      sizeChangeAction({
        intent: true,
        pendingJump: false,
        olderPageRestore: true,
        flicking: false,
      }),
    ).toBe('leave');
  });

  it('an own send takes hold again; an incoming message or a re-render does not', () => {
    const own = { id: 'm2', mine: true, state: 'sending' as const };
    expect(intentAfterNewest({ intent: false, newest: own, previousNewestId: 'm1' })).toBe(true);
    const peer = { id: 'm3', mine: false, state: 'sent' as const };
    expect(intentAfterNewest({ intent: false, newest: peer, previousNewestId: 'm2' })).toBe(false);
    // The same own message re-rendering (a status or receipt change) never yanks.
    expect(intentAfterNewest({ intent: false, newest: own, previousNewestId: 'm2' })).toBe(false);
    expect(intentAfterNewest({ intent: true, newest: undefined, previousNewestId: null })).toBe(
      true,
    );
    const thread = simulatedThread();
    thread.newest({ id: 'a', mine: false, state: 'sent' });
    thread.gesture(0);
    thread.newest({ id: 'b', mine: true, state: 'sending' });
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

describe('R3: no pin during a flick', () => {
  it('a finger down, or a touch scroll within 150ms, is a flick; after 150ms it has settled', () => {
    expect(flickInProgress({ touching: true, msSinceTouchScroll: null })).toBe(true);
    expect(flickInProgress({ touching: false, msSinceTouchScroll: 40 })).toBe(true);
    expect(flickInProgress({ touching: false, msSinceTouchScroll: SCROLL_SETTLE_MS })).toBe(false);
    expect(flickInProgress({ touching: false, msSinceTouchScroll: null })).toBe(false);
  });

  it('a size change during momentum defers instead of pinning', () => {
    const flicking = flickInProgress({ touching: false, msSinceTouchScroll: 30 });
    expect(
      sizeChangeAction({ intent: true, pendingJump: false, olderPageRestore: false, flicking }),
    ).toBe('defer');
  });

  it('after settling within 120px it pins', () => {
    expect(
      settleDecision({
        intent: true,
        distanceFromBottom: NEAR_BOTTOM_THRESHOLD_PX,
        restoring: false,
      }),
    ).toEqual({ intent: true, action: 'pin' });
  });

  it('after settling past 120px the intent lets go and nothing pins', () => {
    expect(
      settleDecision({
        intent: true,
        distanceFromBottom: NEAR_BOTTOM_THRESHOLD_PX + 1,
        restoring: false,
      }),
    ).toEqual({ intent: false, action: 'leave' });
  });

  it('a pending jump or restore still owns the settled position', () => {
    expect(settleDecision({ intent: true, distanceFromBottom: 0, restoring: true })).toEqual({
      intent: true,
      action: 'leave',
    });
  });
});

describe('R4: only an own send from this device takes hold', () => {
  it('mine + local (outbox) -> true', () => {
    const local = { id: 'm2', mine: true, state: 'sending' as const };
    expect(sentFromThisDevice(local)).toBe(true);
    expect(intentAfterNewest({ intent: false, newest: local, previousNewestId: 'm1' })).toBe(true);
  });

  it('mine from another device while reading -> unchanged false', () => {
    const remote = { id: 'm3', mine: true, state: 'sent' as const };
    expect(sentFromThisDevice(remote)).toBe(false);
    expect(intentAfterNewest({ intent: false, newest: remote, previousNewestId: 'm2' })).toBe(
      false,
    );
    const thread = simulatedThread();
    thread.gesture(0);
    thread.newest(remote);
    expect(thread.intent()).toBe(false);
    expect(thread.metrics.scrollTop).toBe(0);
  });
});

describe('R5: an empty or failed older load unsticks the anchor', () => {
  it('load ended with the messages unchanged -> no restore, pinning works again', () => {
    const anchored = anchorAfterOlderLoad({
      anchored: true,
      loadEnded: true,
      messagesChanged: false,
    });
    expect(anchored).toBe(false);
    expect(
      sizeChangeAction({
        intent: true,
        pendingJump: false,
        olderPageRestore: anchored,
        flicking: false,
      }),
    ).toBe('pin');
  });

  it('a load still running, or one that brought rows, keeps the anchor', () => {
    expect(anchorAfterOlderLoad({ anchored: true, loadEnded: false, messagesChanged: false })).toBe(
      true,
    );
    expect(anchorAfterOlderLoad({ anchored: true, loadEnded: true, messagesChanged: true })).toBe(
      true,
    );
    expect(anchorAfterOlderLoad({ anchored: false, loadEnded: true, messagesChanged: false })).toBe(
      false,
    );
  });
});
