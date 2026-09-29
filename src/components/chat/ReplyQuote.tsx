// The quoted-reply box, shared by the bubble (a jump button) and the composer's
// reply draft (with a cancel control) so both read identically: an accent bar,
// a panel-3 box, the author in accent and a two-line preview. The composer's
// editing bar takes the same grammar in the warn token, and a quote of a
// deleted message reads its preview italic and muted. Tokens only.

import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export const REPLY_QUOTE_BOX = 'flex min-w-0 gap-2 overflow-hidden rounded-md bg-panel-3';

/** The rule and author ink: accent for a reply, warn for the editing bar. */
export type QuoteTone = 'accent' | 'warn';

function quoteLines(
  author: string,
  preview: string,
  tone: QuoteTone,
  deleted: boolean,
): ReactElement {
  return (
    <>
      <span
        className={cn(
          'w-[3px] shrink-0 self-stretch rounded-full',
          tone === 'warn' ? 'bg-warn' : 'bg-accent',
        )}
        aria-hidden="true"
      />
      <span className="flex min-w-0 flex-1 flex-col py-1 pr-2">
        <span
          className={cn(
            'line-clamp-1 [overflow-wrap:anywhere] text-xs font-medium',
            tone === 'warn' ? 'text-warn' : 'text-accent',
          )}
        >
          {author}
        </span>
        <span
          data-quote-deleted={deleted ? '' : undefined}
          className={cn(
            'line-clamp-2 [overflow-wrap:anywhere] text-xs',
            deleted ? 'italic text-fg-3' : 'text-fg-2',
          )}
        >
          {preview}
        </span>
      </span>
    </>
  );
}

/**
 * A quoted reply. With `onJump` the whole box is a 44px button (in a bubble);
 * otherwise a static box with an optional trailing control (the composer's
 * cancel).
 */
export function ReplyQuoteBox(props: {
  author: string;
  preview: string;
  onJump?: () => void;
  trailing?: ReactNode;
  className?: string;
  /** Rule and author ink; accent (a reply) unless given. */
  tone?: QuoteTone;
  /** The quoted message was deleted: the preview reads italic and muted. */
  deleted?: boolean;
}): ReactElement {
  const tone = props.tone ?? 'accent';
  const deleted = props.deleted === true;
  if (props.onJump !== undefined) {
    const onJump = props.onJump;
    return (
      <button
        type="button"
        aria-label="Go to quoted message"
        onClick={(e) => {
          e.stopPropagation();
          onJump();
        }}
        className={cn(REPLY_QUOTE_BOX, 'min-h-[44px] w-full text-left', props.className)}
      >
        {quoteLines(props.author, props.preview, tone, deleted)}
      </button>
    );
  }
  return (
    <div className={cn(REPLY_QUOTE_BOX, 'items-center', props.className)}>
      {quoteLines(props.author, props.preview, tone, deleted)}
      {props.trailing}
    </div>
  );
}
