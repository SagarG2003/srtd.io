// Small chat-local pieces for marks and multi-select: the bubble badge, the
// selection checkbox, and the lock glyph for own marked messages. Colours are
// design tokens only, so light and dark stay at parity.

import type { ReactElement } from 'react';
import { IconCheck } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { canChangePriority, markBadgeLabel, type ChatMark, type MarkType } from '@/lib/chat/marks';

const BADGE_TONE: Record<MarkType, string> = {
  commitment: 'border-good bg-good-soft text-good',
  decision: 'border-accent-line bg-accent-soft text-accent',
  pending: 'border-warn bg-panel-3 text-warn',
};

const PILL = 'inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium';

/** A plain, non-interactive mark pill in the type's tone (pin board rows). */
export function MarkPill(props: { type: MarkType; label: string }): ReactElement {
  return (
    <span data-mark-pill={props.type} className={cn(PILL, 'shrink-0', BADGE_TONE[props.type])}>
      {props.label}
    </span>
  );
}

/**
 * The mark badge on a bubble. Commitment and decision are plain labels; a
 * stamped mark of any type is a plain label with its stamp word appended
 * ("Commitment · Delivered"). An open pending badge is a button that opens the
 * priority chooser; its visible pill is small, and an invisible after-element
 * extends the hit area to at least 44x44.
 */
export function MarkBadge(props: {
  mark: ChatMark | undefined;
  onChangePriority?: () => void;
}): ReactElement {
  const label = markBadgeLabel(props.mark);
  if (props.mark === undefined || label === '') return <></>;
  const pill = cn(PILL, BADGE_TONE[props.mark.type]);
  if (canChangePriority(props.mark) && props.onChangePriority !== undefined) {
    const onChange = props.onChangePriority;
    return (
      <button
        type="button"
        data-mark-badge={props.mark.type}
        aria-label={`${label}. Change priority`}
        onClick={(e) => {
          e.stopPropagation();
          onChange();
        }}
        className={cn(
          pill,
          "relative mb-1 min-w-[44px] justify-center after:absolute after:-inset-x-1 after:-inset-y-3 after:content-['']",
        )}
      >
        {label}
      </button>
    );
  }
  return (
    <span data-mark-badge={props.mark.type} className={cn(pill, 'mb-1')}>
      {label}
    </span>
  );
}

/** Lock glyph (24 viewbox, currentColor) for own messages a mark keeps from delete. */
export function IconLock({
  size = 18,
  className,
}: {
  size?: number;
  className?: string;
}): ReactElement {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

/** A 44x44 selection checkbox for one own message. */
export function SelectCheckbox(props: { checked: boolean; onToggle: () => void }): ReactElement {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.checked}
      aria-label={props.checked ? 'Deselect message' : 'Select message'}
      onClick={props.onToggle}
      className="flex h-11 w-11 shrink-0 items-center justify-center self-center rounded-full"
    >
      <span
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full border-2 transition-colors',
          props.checked
            ? 'border-accent bg-accent text-accent-fg'
            : 'border-border-strong bg-panel',
        )}
      >
        {props.checked ? <IconCheck size={14} /> : null}
      </span>
    </button>
  );
}

/** The lock shown in place of a checkbox on an own marked message. */
export function SelectLock(): ReactElement {
  return (
    <span
      data-select-lock=""
      title="Marked messages cannot be deleted"
      className="flex h-11 w-11 shrink-0 items-center justify-center self-center text-fg-3"
    >
      <IconLock size={18} />
      <span className="sr-only">Marked messages cannot be deleted</span>
    </span>
  );
}
