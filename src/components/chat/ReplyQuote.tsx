// The quoted-reply box, shared by the bubble (a jump button) and the composer's
// reply draft (with a cancel control) so both read identically: an accent bar,
// a panel-3 box, the author in accent and a two-line preview. Tokens only.

import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export const REPLY_QUOTE_BOX = 'flex min-w-0 gap-2 overflow-hidden rounded-md bg-panel-3';

function quoteLines(author: string, preview: string): ReactElement {
  return (
    <>
      <span className="w-[3px] shrink-0 self-stretch rounded-full bg-accent" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col py-1 pr-2">
        <span className="line-clamp-1 [overflow-wrap:anywhere] text-xs font-medium text-accent">
          {author}
        </span>
        <span className="line-clamp-2 [overflow-wrap:anywhere] text-xs text-fg-2">{preview}</span>
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
}): ReactElement {
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
        {quoteLines(props.author, props.preview)}
      </button>
    );
  }
  return (
    <div className={cn(REPLY_QUOTE_BOX, 'items-center', props.className)}>
      {quoteLines(props.author, props.preview)}
      {props.trailing}
    </div>
  );
}
