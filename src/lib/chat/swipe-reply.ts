/** Movement (px) that decides the direction: right captures, anything else releases. */
export const SWIPE_LOCK_PX = 8;
/** The bubble follows the finger 1:1 up to here (px), then with resistance. */
export const SWIPE_FREE_PX = 80;
/** Share of the finger's travel the bubble follows beyond SWIPE_FREE_PX. */
export const SWIPE_RESISTANCE = 0.25;
/** Offset (px) at which a release replies. */
export const SWIPE_THRESHOLD_PX = 56;
/** Spring-back duration (ms) after a release or cancel. */
export const SWIPE_SPRING_MS = 180;
/** Reply icon scale and opacity transition (ms). */
export const SWIPE_ICON_MS = 120;
/** Haptic tick (ms) when the gesture arms. */
export const SWIPE_VIBRATE_MS = 10;

/** The only pointer fields the controller reads; React's PointerEvent satisfies it. */
export interface SwipePointerSample {
  clientX: number;
  clientY: number;
  /** 'mouse' | 'touch' | 'pen'; absent reads as touch. */
  pointerType?: string;
  pointerId?: number;
}

/** What the view paints: the bubble's translateX and the reply icon's state. */
export interface SwipeFrame {
  /** Bubble translateX in px (0 at rest). */
  offset: number;
  /** Past the threshold: the icon fills with the accent and a release replies. */
  armed: boolean;
  /** 0..1 toward the threshold; drives the icon's scale (0.6 to 1) and opacity. */
  progress: number;
  /** Spring back with a transition; false while dragging or under reduced motion. */
  animate: boolean;
}

export const SWIPE_REST: SwipeFrame = { offset: 0, armed: false, progress: 0, animate: false };

export interface SwipeReplyHandlers {
  onPointerDown: (event: SwipePointerSample) => void;
  onPointerMove: (event: SwipePointerSample) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

export interface SwipeReplyController {
  handlers: SwipeReplyHandlers;
  /**
   * Call at the start of a trailing click handler. Returns true (once) when the
   * click is the tail of a swipe and should be ignored.
   */
  consumeClickSuppression: () => boolean;
  /** True while a rightward swipe owns the pointer. */
  swiping: () => boolean;
  /** Abort without replying (a long-press fired, the list scrolled). */
  cancel: () => void;
  /** Clear state and listeners. */
  dispose: () => void;
}

export interface SwipeReplyOptions {
  /** Released past the threshold. Fires at most once per gesture. */
  onReply: () => void;
  /** Paint a frame (bubble offset, icon state). */
  onFrame: (frame: SwipeFrame) => void;
  /** The swipe locked in: capture the pointer and cancel any long-press timer. */
  onStart?: (pointerId: number | undefined) => void;
  /** False turns the gesture off (selection mode). */
  enabled?: () => boolean;
  /** prefers-reduced-motion: no spring, instant reset. */
  reducedMotion?: () => boolean;
  vibrate?: (ms: number) => void;
}

/** The bubble offset for a finger travel: 1:1 to 80px, 25% beyond, never left. */
export function swipeOffset(dx: number): number {
  if (dx <= 0) return 0;
  if (dx <= SWIPE_FREE_PX) return dx;
  return SWIPE_FREE_PX + (dx - SWIPE_FREE_PX) * SWIPE_RESISTANCE;
}

function defaultVibrate(ms: number): void {
  // Absent on iOS Safari: a no-op there.
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(ms);
  }
}

/**
 * Framework-free swipe-to-reply core, the sibling of createLongPressController.
 * Touch and pen only. A press is pending until it moves SWIPE_LOCK_PX: rightward
 * (and more horizontal than vertical) locks the swipe in, anything else releases
 * it for the list to scroll. A tap that never moves that far is not a swipe.
 */
export function createSwipeReplyController({
  onReply,
  onFrame,
  onStart,
  enabled = () => true,
  reducedMotion = () => false,
  vibrate = defaultVibrate,
}: SwipeReplyOptions): SwipeReplyController {
  let phase: 'idle' | 'pending' | 'swiping' = 'idle';
  let startX = 0;
  let startY = 0;
  let pointerId: number | undefined;
  let armed = false;
  let suppressClick = false;

  function attachScroll(): void {
    if (typeof window !== 'undefined') window.addEventListener('scroll', cancel, true);
  }

  function detachScroll(): void {
    if (typeof window !== 'undefined') window.removeEventListener('scroll', cancel, true);
  }

  /** Back to idle; springs the bubble home when it had moved. */
  function reset(): void {
    const moved = phase === 'swiping';
    phase = 'idle';
    armed = false;
    pointerId = undefined;
    detachScroll();
    if (moved) onFrame({ ...SWIPE_REST, animate: !reducedMotion() });
  }

  function cancel(): void {
    reset();
  }

  function samePointer(event: SwipePointerSample): boolean {
    return (
      pointerId === undefined || event.pointerId === undefined || event.pointerId === pointerId
    );
  }

  function onPointerDown(event: SwipePointerSample): void {
    reset();
    suppressClick = false;
    if ((event.pointerType ?? '') === 'mouse' || !enabled()) return;
    phase = 'pending';
    startX = event.clientX;
    startY = event.clientY;
    pointerId = event.pointerId;
    attachScroll();
  }

  function onPointerMove(event: SwipePointerSample): void {
    if (phase === 'idle' || !samePointer(event)) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (phase === 'pending') {
      if (dx * dx + dy * dy < SWIPE_LOCK_PX * SWIPE_LOCK_PX) return;
      if (dx <= 0 || Math.abs(dy) >= dx) {
        // Vertical or leftward: not ours. The list scrolls, long-press as before.
        reset();
        return;
      }
      phase = 'swiping';
      suppressClick = true;
      onStart?.(pointerId);
    }
    const offset = swipeOffset(dx);
    const nowArmed = offset >= SWIPE_THRESHOLD_PX;
    if (nowArmed && !armed) vibrate(SWIPE_VIBRATE_MS);
    armed = nowArmed;
    onFrame({
      offset,
      armed,
      progress: Math.min(1, offset / SWIPE_THRESHOLD_PX),
      animate: false,
    });
  }

  function onPointerUp(): void {
    const reply = phase === 'swiping' && armed;
    reset();
    if (reply) onReply();
  }

  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: cancel },
    consumeClickSuppression(): boolean {
      const value = suppressClick;
      suppressClick = false;
      return value;
    },
    swiping: () => phase === 'swiping',
    cancel,
    dispose(): void {
      reset();
      suppressClick = false;
    },
  };
}
