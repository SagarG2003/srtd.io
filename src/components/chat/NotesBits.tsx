// Personal notes' small pieces: the notebook glyph, its accent-soft rounded
// square (chat home tile, thread header, search rows), and the "Saved from"
// line a saved copy shows in place of "Forwarded". Tokens only, no motion.

import { createContext, useContext } from 'react';
import type { ReactElement } from 'react';
import { cn } from '@/lib/cn';
import type { ThreadMessage } from '@/lib/chat/thread';
import type { SavedFromLine } from '@/lib/chat/saved-from';
import { SaveToNotesGlyph } from '@/components/chat/MessageActionMenu';

/** The notebook glyph (stroke 1.7, like the icon set). */
export function NotesGlyph(props: { size?: number }): ReactElement {
  const size = props.size ?? 22;
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 3h10l3 3v15H6z" />
      <path d="M9 9h7M9 13h7M9 17h4" />
    </svg>
  );
}

/** The notes photo slot's sizes: the 76px tile, the 48px search row, the 40px header. */
const NOTES_AVATAR_BOX = {
  tile: 'h-[76px] w-[76px] rounded-[18px]',
  row: 'h-12 w-12 rounded-[12px]',
  header: 'h-10 w-10 rounded-[12px]',
} as const;

const NOTES_GLYPH_SIZE = { tile: 34, row: 24, header: 22 } as const;

/** The accent-soft rounded square with the notebook, in place of a photo. */
export function NotesAvatar(props: { size: keyof typeof NOTES_AVATAR_BOX }): ReactElement {
  return (
    <span
      data-notes-avatar=""
      className={cn(
        'flex shrink-0 items-center justify-center bg-accent-soft text-accent',
        NOTES_AVATAR_BOX[props.size],
      )}
    >
      <NotesGlyph size={NOTES_GLYPH_SIZE[props.size]} />
    </span>
  );
}

/** What a notes thread's bubbles read for their "Saved from" line. */
export interface SavedFromWiring {
  lineFor: (message: ThreadMessage) => SavedFromLine | null;
  /** Open the source in its chat (the ?channel=&message= deep link). */
  onOpen: (line: Extract<SavedFromLine, { kind: 'source' }>) => void;
}

const SavedFromContext = createContext<SavedFromWiring | null>(null);

/** Provided around a notes thread only; every other chat reads null. */
export const SavedFromProvider = SavedFromContext.Provider;

export function useSavedFrom(): SavedFromWiring | null {
  return useContext(SavedFromContext);
}

/**
 * The line above a saved copy's body: "Saved from <chat> · <sender>", a 44px
 * tall link to the source, or the plain "Saved message" when the source can
 * no longer be read. Own and incoming inks, like "Forwarded".
 */
export function SavedFromLabel(props: {
  line: SavedFromLine;
  mine: boolean;
  onOpen: SavedFromWiring['onOpen'];
}): ReactElement {
  const { line } = props;
  const ink = props.mine ? 'text-accent-fg' : 'text-fg-2';
  const body = (
    <>
      <SaveToNotesGlyph size={14} />
      <span className="min-w-0 truncate">{line.label}</span>
    </>
  );
  if (line.kind === 'unreadable') {
    return (
      <span
        data-saved-from="unreadable"
        className={cn('mb-1 flex items-center gap-1.5 text-[13px] leading-[18px]', ink)}
      >
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-saved-from="source"
      aria-label={`${line.label}, open the original message`}
      onClick={(event) => {
        event.stopPropagation();
        props.onOpen(line);
      }}
      className={cn(
        '-mb-2 -mt-3 flex min-h-[44px] max-w-full items-center gap-1.5 rounded-md text-left text-[13px] leading-[18px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        ink,
      )}
    >
      {body}
    </button>
  );
}
