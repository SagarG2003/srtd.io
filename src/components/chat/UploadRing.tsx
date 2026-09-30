// The WhatsApp upload control on an uploading photo, album, file or voice
// note: an X inside a dark circle, with a ring around it that fills with the
// upload's progress. Tapping it cancels the send (no confirm). While progress
// is unknown (queued, waiting, backoff, offline) the ring is an indeterminate
// arc that spins; with reduced motion it stays a static partial arc.
//
// It draws on the overlay tokens (a dark disc, light ink, the same values in
// light and dark), so it reads the same over a photo, on the own bubble's fill
// and on a peer bubble, in both themes. The button carries data-upload-ring so
// the own-bubble restyle (MessageThread OWN_BUBBLE_CONTENT) leaves it alone.
// Only opacity and the ring's stroke ever change; its box is fixed at 48px.

import type { ReactElement } from 'react';
import { IconX } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

/** The ring's box (px); the tap target is the whole circle (>= 44x44). */
export const UPLOAD_RING_SIZE = 48;
const STROKE = 3;
const RADIUS = (UPLOAD_RING_SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** The indeterminate arc's share of the ring. */
const ARC = 0.25;

/** The stroke offset for a progress 0..1 (null: the indeterminate arc). Pure. */
export function ringDashOffset(progress: number | null): number {
  const shown = progress === null ? ARC : Math.min(Math.max(progress, 0), 1);
  return CIRCUMFERENCE * (1 - shown);
}

export function UploadRing({
  progress,
  onCancel,
  className,
  hidden = false,
}: {
  /** Upload progress 0..1; null while unknown (the ring spins). */
  progress: number | null;
  onCancel?: (() => void) | undefined;
  className?: string | undefined;
  /** Faded out (upload done): kept in place for the crossfade, not focusable. */
  hidden?: boolean;
}): ReactElement {
  const indeterminate = progress === null;
  return (
    <button
      type="button"
      data-upload-ring=""
      data-upload-progress={indeterminate ? 'unknown' : String(Math.round(progress * 100))}
      aria-label="Cancel upload"
      aria-hidden={hidden ? true : undefined}
      tabIndex={hidden ? -1 : undefined}
      // The press never reaches the bubble (no long-press, no swipe).
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (!hidden) onCancel?.();
      }}
      className={cn(
        'relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-overlay-fg',
        'transition-[opacity,visibility] duration-150 motion-reduce:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-overlay-fg',
        hidden ? 'pointer-events-none invisible opacity-0' : 'visible opacity-100',
        className,
      )}
    >
      <span aria-hidden="true" className="absolute inset-0 rounded-full bg-overlay opacity-60" />
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${UPLOAD_RING_SIZE} ${UPLOAD_RING_SIZE}`}
        className={cn(
          'absolute inset-0 h-12 w-12 -rotate-90',
          indeterminate && 'animate-spin motion-reduce:animate-none',
        )}
      >
        <circle
          cx={UPLOAD_RING_SIZE / 2}
          cy={UPLOAD_RING_SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          className="text-overlay-dot"
        />
        <circle
          data-upload-arc=""
          cx={UPLOAD_RING_SIZE / 2}
          cy={UPLOAD_RING_SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={ringDashOffset(progress)}
          className="text-overlay-fg transition-[stroke-dashoffset] duration-150 motion-reduce:transition-none"
        />
      </svg>
      <IconX size={18} className="relative" />
    </button>
  );
}
