// The quoted-reply box, shared by the bubble (a jump button) and the composer's
// reply draft (with a cancel control) so both read identically: an accent bar,
// a panel-3 box, the author in accent and a two-line preview. The composer's
// editing bar takes the same grammar in the warn token, and a quote of a
// deleted message reads its preview italic and muted. Tokens only.

import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { QUOTE_AUTHOR_TYPE, QUOTE_TEXT_TYPE } from '@/components/chat/chat-type';

export const REPLY_QUOTE_BOX = 'flex min-w-0 gap-2 overflow-hidden rounded-md bg-panel-3';

/** The rule and author ink: accent for a reply, warn for the editing bar. */
export type QuoteTone = 'accent' | 'warn';

function quoteLines(
  author: string,
  preview: string,
  tone: QuoteTone,
  deleted: boolean,
  inBubble: boolean,
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
            'line-clamp-1 [overflow-wrap:anywhere]',
            inBubble ? QUOTE_AUTHOR_TYPE : 'text-xs font-medium',
            tone === 'warn' ? 'text-warn' : 'text-accent',
          )}
        >
          {author}
        </span>
        <span
          data-quote-deleted={deleted ? '' : undefined}
          className={cn(
            'line-clamp-2 [overflow-wrap:anywhere]',
            inBubble ? QUOTE_TEXT_TYPE : 'text-xs',
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
  /** Inside a bubble: the chat type scale's quote sizes (the composer bars keep theirs). */
  inBubble?: boolean;
}): ReactElement {
  const tone = props.tone ?? 'accent';
  const deleted = props.deleted === true;
  const inBubble = props.inBubble === true;
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
        {quoteLines(props.author, props.preview, tone, deleted, inBubble)}
      </button>
    );
  }
  return (
    <div className={cn(REPLY_QUOTE_BOX, 'items-center', props.className)}>
      {quoteLines(props.author, props.preview, tone, deleted, inBubble)}
      {props.trailing}
    </div>
  );
}
