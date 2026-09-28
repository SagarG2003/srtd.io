import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSwipeReplyController,
  swipeOffset,
  SWIPE_FREE_PX,
  SWIPE_LOCK_PX,
  SWIPE_THRESHOLD_PX,
  SWIPE_VIBRATE_MS,
  type SwipeFrame,
  type SwipeReplyOptions,
} from '@/lib/chat/swipe-reply';

const touch = (x: number, y: number, pointerId = 1) => ({
  clientX: x,
  clientY: y,
  pointerType: 'touch',
  pointerId,
});

function setup(over: Partial<SwipeReplyOptions> = {}) {
  const frames: SwipeFrame[] = [];
  const onReply = vi.fn();
  const onStart = vi.fn();
  const vibrate = vi.fn();
  const c = createSwipeReplyController({
    onReply,
    onStart,
    vibrate,
    onFrame: (f) => frames.push(f),
    ...over,
  });
  return { c, frames, onReply, onStart, vibrate, last: () => frames[frames.length - 1] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('swipeOffset', () => {
  it('follows 1:1 to 80px, then with 25% resistance, never leftward', () => {
    expect(swipeOffset(-20)).toBe(0);
    expect(swipeOffset(40)).toBe(40);
    expect(swipeOffset(SWIPE_FREE_PX)).toBe(80);
    expect(swipeOffset(120)).toBe(90);
    expect(swipeOffset(200)).toBe(110);
  });
});

describe('createSwipeReplyController', () => {
  it('a rightward move captures the gesture and follows the finger on X only', () => {
    const { c, onStart, last } = setup();
    c.handlers.onPointerDown(touch(10, 10));
    c.handlers.onPointerMove(touch(10 + SWIPE_LOCK_PX - 1, 10));
    expect(onStart).not.toHaveBeenCalled();
    expect(c.swiping()).toBe(false);
    c.handlers.onPointerMove(touch(40, 14));
    expect(onStart).toHaveBeenCalledWith(1);
    expect(c.swiping()).toBe(true);
    expect(last()).toEqual({ offset: 30, armed: false, progress: 30 / 56, animate: false });
    c.dispose();
  });

  it('a vertical or leftward move releases the gesture', () => {
    const { c, onStart, frames } = setup();
    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerMove(touch(3, 12));
    c.handlers.onPointerMove(touch(90, 12));
    expect(onStart).not.toHaveBeenCalled();
    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerMove(touch(-12, 0));
    c.handlers.onPointerMove(touch(90, 0));
    c.handlers.onPointerUp();
    expect(onStart).not.toHaveBeenCalled();
    expect(frames).toEqual([]);
    c.dispose();
  });

  it('arms at the threshold with one haptic tick, disarms when pulled back', () => {
    const { c, vibrate, last } = setup();
    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerMove(touch(SWIPE_THRESHOLD_PX - 1, 0));
    expect(last()?.armed).toBe(false);
    c.handlers.onPointerMove(touch(SWIPE_THRESHOLD_PX, 0));
    expect(last()).toMatchObject({ armed: true, progress: 1 });
    c.handlers.onPointerMove(touch(70, 0));
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith(SWIPE_VIBRATE_MS);
    c.handlers.onPointerMove(touch(30, 0));
    expect(last()?.armed).toBe(false);
    c.dispose();
  });

  it('resists beyond 80px', () => {
    const { c, last } = setup();
    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerMove(touch(160, 0));
    expect(last()?.offset).toBe(100);
    c.dispose();
  });

  it('release past the threshold replies once and springs back', () => {
    const { c, onReply, last } = setup();
    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerMove(touch(70, 0));
    c.handlers.onPointerUp();
    c.handlers.onPointerUp();
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(last()).toEqual({ offset: 0, armed: false, progress: 0, animate: true });
    expect(c.consumeClickSuppression()).toBe(true);
    expect(c.consumeClickSuppression()).toBe(false);
    c.dispose();
  });

  it('release below the threshold springs back without replying', () => {
    const { c, onReply, last } = setup();
    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerMove(touch(40, 0));
    c.handlers.onPointerUp();
    expect(onReply).not.toHaveBeenCalled();
    expect(last()).toMatchObject({ offset: 0, animate: true });
  });

  it('pointercancel and window scroll cancel without replying', () => {
    const listeners: Array<() => void> = [];
    vi.stubGlobal('window', {
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: () => {},
    });
    const { c, onReply, last } = setup();
    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerMove(touch(70, 0));
    listeners.forEach((fn) => fn());
    expect(last()?.offset).toBe(0);
    c.handlers.onPointerUp();
    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerMove(touch(70, 0));
    c.handlers.onPointerCancel();
    c.handlers.onPointerUp();
    expect(onReply).not.toHaveBeenCalled();
  });

  it('ignores mouse, and does nothing while disabled', () => {
    const { c, onStart, frames } = setup();
    c.handlers.onPointerDown({ clientX: 0, clientY: 0, pointerType: 'mouse', pointerId: 1 });
    c.handlers.onPointerMove({ clientX: 90, clientY: 0, pointerType: 'mouse', pointerId: 1 });
    c.handlers.onPointerUp();
    const off = setup({ enabled: () => false });
    off.c.handlers.onPointerDown(touch(0, 0));
    off.c.handlers.onPointerMove(touch(90, 0));
    off.c.handlers.onPointerUp();
    expect(onStart).not.toHaveBeenCalled();
    expect(frames).toEqual([]);
    expect(off.onReply).not.toHaveBeenCalled();
  });

  it('pen swipes like touch', () => {
    const { c, onReply } = setup();
    c.handlers.onPointerDown({ clientX: 0, clientY: 0, pointerType: 'pen', pointerId: 2 });
    c.handlers.onPointerMove({ clientX: 70, clientY: 0, pointerType: 'pen', pointerId: 2 });
    c.handlers.onPointerUp();
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('reduced motion resets instantly', () => {
    const { c, last } = setup({ reducedMotion: () => true });
    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerMove(touch(70, 0));
    c.handlers.onPointerUp();
    expect(last()).toEqual({ offset: 0, armed: false, progress: 0, animate: false });
  });

  it('a tap under 8px is not a swipe and leaves the click alone', () => {
    const { c, onStart, onReply } = setup();
    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerMove(touch(5, 3));
    c.handlers.onPointerUp();
    expect(onStart).not.toHaveBeenCalled();
    expect(onReply).not.toHaveBeenCalled();
    expect(c.consumeClickSuppression()).toBe(false);
  });

  it('cancel (a completed long-press) stops a pending press from becoming a swipe', () => {
    const { c, onStart } = setup();
    c.handlers.onPointerDown(touch(0, 0));
    c.cancel();
    c.handlers.onPointerMove(touch(90, 0));
    c.handlers.onPointerUp();
    expect(onStart).not.toHaveBeenCalled();
  });

  it('a new press clears a stale click suppression', () => {
    const { c } = setup();
    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerMove(touch(30, 0));
    c.handlers.onPointerUp();
    c.handlers.onPointerDown(touch(0, 0));
    c.handlers.onPointerUp();
    expect(c.consumeClickSuppression()).toBe(false);
  });

  it('ignores a second pointer', () => {
    const { c, last } = setup();
    c.handlers.onPointerDown(touch(0, 0, 1));
    c.handlers.onPointerMove(touch(30, 0, 1));
    c.handlers.onPointerMove(touch(200, 0, 2));
    expect(last()?.offset).toBe(30);
  });
});
