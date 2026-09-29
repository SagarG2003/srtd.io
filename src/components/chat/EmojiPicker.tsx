// The full emoji picker behind the reactions row's "+". A search field on top
// (matching the CLDR short name), a row of group tabs that stays put, and the
// grid grouped by Unicode group below it. Glyphs render as text in the app's
// emoji font stack (no images, no emoji library); the data is generated once
// from Unicode 15.0 (emoji-data.ts). Touch opens it as a bottom sheet that
// moves on Y only; the laptop layout opens a popover anchored to the menu that
// fades (opacity only). Every control is at least 44x44. Tokens only, so light
// and dark stay at parity.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, Ref } from 'react';
import { createPortal } from 'react-dom';
import { IconSearch } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { EMOJI, EMOJI_GROUPS, type EmojiEntry } from '@/components/chat/emoji-data';
import {
  EMOJI_GLYPH_TYPE,
  EMOJI_GROUP_TYPE,
  EMOJI_SEARCH_TYPE,
  sized,
  type ChatLayout,
} from '@/components/chat/chat-type';

/** The empty result line. */
export const EMOJI_NO_RESULTS = 'No emoji found';

/** The search field's placeholder. */
export const EMOJI_SEARCH_PLACEHOLDER = 'Search emoji';

/** One group of the grid. */
export interface EmojiSection {
  group: string;
  emojis: readonly EmojiEntry[];
}

/**
 * The emoji whose CLDR short name matches every word of the query (any order,
 * case-insensitive, each word a substring of the name). An empty query matches
 * nothing: the grouped grid shows instead. Pure.
 */
export function searchEmoji(query: string, list: readonly EmojiEntry[] = EMOJI): EmojiEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return list.filter((entry) => {
    const name = entry.name.toLowerCase();
    return words.every((word) => name.includes(word));
  });
}

/** The grid's sections, one per Unicode group, in Unicode order. Pure. */
export function emojiSections(list: readonly EmojiEntry[] = EMOJI): EmojiSection[] {
  return EMOJI_GROUPS.map((group) => ({
    group,
    emojis: list.filter((entry) => entry.group === group),
  })).filter((section) => section.emojis.length > 0);
}

/** A group's tab glyph: its first emoji. */
export function groupTabGlyph(section: EmojiSection): string {
  return section.emojis[0]?.char ?? '';
}

const SECTIONS = emojiSections();

/** One 44x44 glyph button. */
function EmojiButton(props: { entry: EmojiEntry; onPick: (char: string) => void }): ReactElement {
  return (
    <button
      type="button"
      data-emoji={props.entry.char}
      aria-label={props.entry.name}
      title={props.entry.name}
      onClick={() => props.onPick(props.entry.char)}
      className={cn(
        'flex h-11 w-11 items-center justify-center rounded-lg hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        EMOJI_GLYPH_TYPE,
      )}
    >
      <span aria-hidden="true">{props.entry.char}</span>
    </button>
  );
}

const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(44px,1fr))] justify-items-center';

/** The picker's props shared by its parts. */
interface PickerPartProps {
  query: string;
  onQuery: (query: string) => void;
  onPick: (char: string) => void;
  layout: ChatLayout;
  activeGroup: string | null;
  onTab: (group: string) => void;
}

/** The search field (normal text selection, never under 16px on touch). */
export function EmojiSearchField(
  props: Pick<PickerPartProps, 'query' | 'onQuery' | 'layout'>,
): ReactElement {
  return (
    <div className="shrink-0 px-2 pt-2">
      <label className="flex h-11 items-center gap-2 rounded-lg border border-border bg-panel-2 px-3 text-fg-3 focus-within:ring-2 focus-within:ring-accent">
        <IconSearch size={16} />
        <input
          type="search"
          data-emoji-search=""
          aria-label={EMOJI_SEARCH_PLACEHOLDER}
          placeholder={EMOJI_SEARCH_PLACEHOLDER}
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
          autoComplete="off"
          className={cn(
            'min-w-0 flex-1 select-text bg-transparent text-fg placeholder:text-fg-3 focus:outline-none',
            sized(EMOJI_SEARCH_TYPE, props.layout),
          )}
        />
      </label>
    </div>
  );
}

/** The group tab row: one 44x44 tab per Unicode group; it sits outside the scroll. */
export function EmojiTabs(
  props: Pick<PickerPartProps, 'query' | 'activeGroup' | 'onTab'>,
): ReactElement {
  const searching = props.query.trim() !== '';
  return (
    <div
      role="tablist"
      aria-label="Emoji groups"
      data-emoji-tabs=""
      className="flex shrink-0 justify-between overflow-x-auto border-b border-border px-1"
    >
      {SECTIONS.map((section) => (
        <button
          key={section.group}
          type="button"
          role="tab"
          aria-label={section.group}
          aria-selected={!searching && props.activeGroup === section.group}
          data-emoji-tab={section.group}
          onClick={() => props.onTab(section.group)}
          className={cn(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg opacity-60 hover:bg-panel-2 aria-selected:bg-panel-3 aria-selected:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            EMOJI_GLYPH_TYPE,
          )}
        >
          <span aria-hidden="true">{groupTabGlyph(section)}</span>
        </button>
      ))}
    </div>
  );
}

/** The grid: the search results while a query is typed, else every group in order. */
export function EmojiGrid(props: Pick<PickerPartProps, 'query' | 'onPick'>): ReactElement {
  if (props.query.trim() !== '') {
    const results = searchEmoji(props.query);
    if (results.length === 0) {
      return (
        <p data-emoji-empty="" className="px-4 py-6 text-center text-sm text-fg-3">
          {EMOJI_NO_RESULTS}
        </p>
      );
    }
    return (
      <div data-emoji-results="" className={cn(GRID, 'p-1')}>
        {results.map((entry) => (
          <EmojiButton key={entry.char} entry={entry} onPick={props.onPick} />
        ))}
      </div>
    );
  }
  return (
    <>
      {SECTIONS.map((section) => (
        <section key={section.group} data-emoji-section={section.group} className="px-1">
          <h3 className={cn('px-2 pb-1 pt-3 text-fg-3', EMOJI_GROUP_TYPE)}>{section.group}</h3>
          <div className={GRID}>
            {section.emojis.map((entry) => (
              <EmojiButton key={entry.char} entry={entry} onPick={props.onPick} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/**
 * The picker's contents: search on top, the group tabs, then the scrolling
 * grid. Hook-free: the query, the active tab and the handlers come in.
 */
export function EmojiPickerBody(
  props: PickerPartProps & { scrollRef?: Ref<HTMLDivElement>; onScroll?: () => void },
): ReactElement {
  return (
    <>
      <EmojiSearchField query={props.query} onQuery={props.onQuery} layout={props.layout} />
      <EmojiTabs query={props.query} activeGroup={props.activeGroup} onTab={props.onTab} />
      <div
        ref={props.scrollRef}
        onScroll={props.onScroll}
        data-emoji-scroll=""
        className="relative min-h-0 flex-1 overflow-y-auto"
      >
        <EmojiGrid query={props.query} onPick={props.onPick} />
      </div>
    </>
  );
}

/** The laptop popover's size. */
const POPOVER_WIDTH = 352;
const POPOVER_HEIGHT = 400;

/**
 * Where the laptop popover sits: above the anchor (the action menu) when there
 * is room, else below it, else pinned inside the viewport; aligned to the
 * anchor's left edge and kept 8px inside. Pure.
 */
export function popoverPosition(
  anchor: Pick<DOMRect, 'top' | 'bottom' | 'left'>,
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const above = anchor.top - POPOVER_HEIGHT - 8;
  const below = anchor.bottom + 8;
  const top =
    above >= 8
      ? above
      : below + POPOVER_HEIGHT <= viewport.height - 8
        ? below
        : Math.max(8, viewport.height - POPOVER_HEIGHT - 8);
  const left = Math.max(8, Math.min(anchor.left, viewport.width - POPOVER_WIDTH - 8));
  return { top, left };
}

/**
 * The picker. Touch: a bottom sheet over a dim, translateY only, the safe-area
 * inset kept clear. Laptop: a popover anchored to `anchor`, opacity only. A
 * pick calls onPick (the caller reacts and closes the picker and the menu);
 * Escape or the dim closes just the picker.
 */
export function EmojiPicker(props: {
  open: boolean;
  onClose: () => void;
  onPick: (char: string) => void;
  layout: ChatLayout;
  /** The laptop popover's anchor (the menu's rect); ignored on touch. */
  anchor: DOMRect | null;
}): ReactElement | null {
  const { open, onClose, layout } = props;
  const [query, setQuery] = useState('');
  const [activeGroup, setActiveGroup] = useState<string | null>(SECTIONS[0]?.group ?? null);
  const [shown, setShown] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) return;
    setQuery('');
    setActiveGroup(SECTIONS[0]?.group ?? null);
  }, [open]);

  // Entrance: flip after mount so the one transition runs.
  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  const position = useMemo(
    () =>
      props.anchor !== null && typeof window !== 'undefined'
        ? popoverPosition(props.anchor, { width: window.innerWidth, height: window.innerHeight })
        : null,
    [props.anchor],
  );

  // A new query starts the list from the top.
  useLayoutEffect(() => {
    if (scrollRef.current !== null) scrollRef.current.scrollTop = 0;
  }, [query]);

  if (!open) return null;

  const onTab = (group: string): void => {
    setQuery('');
    setActiveGroup(group);
    const list = scrollRef.current;
    const target = list?.querySelector(`[data-emoji-section="${CSS.escape(group)}"]`);
    if (list != null && target instanceof HTMLElement) list.scrollTop = target.offsetTop;
  };
  // The tab follows the section at the top of the list.
  const onScroll = (): void => {
    const list = scrollRef.current;
    if (list === null || query.trim() !== '') return;
    let current: string | null = null;
    for (const node of Array.from(list.querySelectorAll<HTMLElement>('[data-emoji-section]'))) {
      if (node.offsetTop <= list.scrollTop + 1) current = node.dataset.emojiSection ?? current;
    }
    if (current !== null && current !== activeGroup) setActiveGroup(current);
  };

  const body = (
    <EmojiPickerBody
      query={query}
      onQuery={setQuery}
      onPick={props.onPick}
      layout={layout}
      activeGroup={activeGroup}
      onTab={onTab}
      scrollRef={scrollRef}
      onScroll={onScroll}
    />
  );

  if (layout === 'laptop') {
    return createPortal(
      <>
        <div data-emoji-dismiss="" className="fixed inset-0 z-[60]" onClick={onClose} />
        <div
          role="dialog"
          aria-label="Emoji picker"
          data-emoji-picker="laptop"
          className={cn(
            'fixed z-[60] flex h-[400px] w-[352px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-xl border border-border-strong bg-panel shadow-2xl transition-opacity duration-fast motion-reduce:transition-none',
            shown ? 'opacity-100 ease-enter' : 'opacity-0 ease-exit',
          )}
          style={{ top: position?.top ?? 8, left: position?.left ?? 8 }}
        >
          {body}
        </div>
      </>,
      document.body,
    );
  }
  return createPortal(
    <div data-emoji-dismiss="" className="fixed inset-0 z-[60] bg-black/45" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Emoji picker"
        aria-modal="true"
        data-emoji-picker="touch"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'absolute inset-x-0 bottom-0 flex h-[70vh] flex-col overflow-hidden rounded-t-2xl border-t border-border-strong bg-panel pb-[env(safe-area-inset-bottom)] shadow-2xl transition-transform duration-base motion-reduce:transition-none',
          shown ? 'translate-y-0 ease-enter' : 'translate-y-full ease-exit',
        )}
      >
        {body}
      </div>
    </div>,
    document.body,
  );
}
