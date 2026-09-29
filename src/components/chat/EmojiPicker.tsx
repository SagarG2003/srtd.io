// The full emoji picker's body behind the reactions row's "+": a search field
// on top (matching the CLDR short name), a row of group tabs that stays put,
// and the grid grouped by Unicode group below it. Glyphs render as text in the
// app's emoji font stack (no images, no emoji library); the data is generated
// once from Unicode 15.0 (emoji-data.ts). This module and its data load through
// a dynamic import() (MessageActionMenu starts it when the menu opens), so
// neither is in the main chunk; the sheet / popover shell, its focus trap and
// its close rules live in MessageActionMenu. The grid is virtualized: fixed
// 44px rows, only the visible rows plus a 3-row buffer are rendered, and a
// group tab jumps by row index. Every control is at least 44x44. Tokens only,
// so light and dark stay at parity.

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
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

/** Every grid row (a group heading or a line of glyphs) is this tall. */
export const EMOJI_ROW_PX = 44;

/** Rows rendered past each edge of the visible window. */
export const EMOJI_ROW_BUFFER = 3;

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

/** One fixed-height row of the virtual grid. */
export type EmojiRow =
  | { kind: 'heading'; group: string }
  | { kind: 'glyphs'; emojis: readonly EmojiEntry[] };

/** The grid as rows: a heading then its glyph lines per section (or just result lines). Pure. */
export function emojiRows(
  sections: readonly EmojiSection[],
  columns: number,
  headings = true,
): EmojiRow[] {
  const perRow = Math.max(1, Math.floor(columns));
  const rows: EmojiRow[] = [];
  for (const section of sections) {
    if (headings) rows.push({ kind: 'heading', group: section.group });
    for (let i = 0; i < section.emojis.length; i += perRow) {
      rows.push({ kind: 'glyphs', emojis: section.emojis.slice(i, i + perRow) });
    }
  }
  return rows;
}

/** The row index each group's heading sits at: where its tab jumps. Pure. */
export function groupRowIndex(rows: readonly EmojiRow[]): Map<string, number> {
  const index = new Map<string, number>();
  rows.forEach((row, i) => {
    if (row.kind === 'heading') index.set(row.group, i);
  });
  return index;
}

/** The group whose heading is at or above the top of the window. Pure. */
export function groupAtRow(rows: readonly EmojiRow[], topRow: number): string | null {
  let current: string | null = null;
  for (let i = 0; i < rows.length && i <= topRow; i += 1) {
    const row = rows[i];
    if (row?.kind === 'heading') current = row.group;
  }
  return current;
}

/**
 * The rows to render for a scroll position: the visible ones plus a
 * EMOJI_ROW_BUFFER-row buffer each way, as [start, end). Pure.
 */
export function visibleRowRange(
  scrollTop: number,
  viewportHeight: number,
  rowCount: number,
): { start: number; end: number } {
  const first = Math.floor(Math.max(0, scrollTop) / EMOJI_ROW_PX);
  const visible = Math.ceil(Math.max(0, viewportHeight) / EMOJI_ROW_PX) + 1;
  const start = Math.max(0, first - EMOJI_ROW_BUFFER);
  const end = Math.min(rowCount, first + visible + EMOJI_ROW_BUFFER);
  return { start, end: Math.max(start, end) };
}

/** Glyph columns that fit a grid this wide (44px each, 4px side padding). Pure. */
export function gridColumns(width: number): number {
  return Math.max(1, Math.floor((width - 8) / EMOJI_ROW_PX));
}

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
        'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        EMOJI_GLYPH_TYPE,
      )}
    >
      <span aria-hidden="true">{props.entry.char}</span>
    </button>
  );
}

/** The search field (normal text selection, never under 16px on touch); `trailing` sits beside it. */
export function EmojiSearchField(props: {
  query: string;
  onQuery: (query: string) => void;
  layout: ChatLayout;
  trailing?: ReactNode;
}): ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-1 px-2 pt-2">
      <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-panel-2 px-3 text-fg-3 focus-within:ring-2 focus-within:ring-accent">
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
      {props.trailing}
    </div>
  );
}

/** The group tab row: one 44x44 tab per Unicode group; it sits outside the scroll. */
export function EmojiTabs(props: {
  query: string;
  activeGroup: string | null;
  onTab: (group: string) => void;
}): ReactElement {
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

/**
 * The virtual grid: a spacer as tall as every row, with only the rows in
 * visibleRowRange rendered at their offsets. Hook-free.
 */
export function EmojiVirtualGrid(props: {
  rows: readonly EmojiRow[];
  scrollTop: number;
  viewportHeight: number;
  onPick: (char: string) => void;
}): ReactElement {
  const { start, end } = visibleRowRange(props.scrollTop, props.viewportHeight, props.rows.length);
  return (
    <div
      data-emoji-rows={props.rows.length}
      className="relative"
      style={{ height: props.rows.length * EMOJI_ROW_PX }}
    >
      {props.rows.slice(start, end).map((row, offset) => {
        const index = start + offset;
        const top = index * EMOJI_ROW_PX;
        if (row.kind === 'heading') {
          return (
            <h3
              key={`h-${row.group}`}
              data-emoji-row={index}
              data-emoji-section={row.group}
              className={cn(
                'absolute inset-x-0 flex h-11 items-end px-3 pb-1 text-fg-3',
                EMOJI_GROUP_TYPE,
              )}
              style={{ top }}
            >
              {row.group}
            </h3>
          );
        }
        return (
          <div
            key={`r-${index}`}
            data-emoji-row={index}
            className="absolute inset-x-0 flex h-11 justify-start px-1"
            style={{ top }}
          >
            {row.emojis.map((entry) => (
              <EmojiButton key={entry.char} entry={entry} onPick={props.onPick} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The grid for a query: the result lines while a query is typed (or the empty
 * line), else every group with its heading. Hook-free.
 */
export function EmojiGrid(props: {
  query: string;
  onPick: (char: string) => void;
  columns: number;
  scrollTop: number;
  viewportHeight: number;
}): ReactElement {
  const searching = props.query.trim() !== '';
  const results = searching ? searchEmoji(props.query) : [];
  if (searching && results.length === 0) {
    return (
      <p data-emoji-empty="" className="px-4 py-6 text-center text-sm text-fg-3">
        {EMOJI_NO_RESULTS}
      </p>
    );
  }
  const rows = searching
    ? emojiRows([{ group: '', emojis: results }], props.columns, false)
    : emojiRows(SECTIONS, props.columns);
  return (
    <EmojiVirtualGrid
      rows={rows}
      scrollTop={props.scrollTop}
      viewportHeight={props.viewportHeight}
      onPick={props.onPick}
    />
  );
}

/**
 * The picker's contents inside the shell: search (with `trailing`, the
 * shell's close control, beside it), the group tabs, then the scrolling
 * virtual grid. Owns the query, the active tab and the scroll window.
 */
export function EmojiPickerPanel(props: {
  onPick: (char: string) => void;
  layout: ChatLayout;
  trailing?: ReactNode;
}): ReactElement {
  const [query, setQuery] = useState('');
  const [activeGroup, setActiveGroup] = useState<string | null>(SECTIONS[0]?.group ?? null);
  const [view, setView] = useState({ scrollTop: 0, height: 0, width: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const columns = gridColumns(view.width);
  const sectionRows = useMemo(() => emojiRows(SECTIONS, columns), [columns]);
  const headingRow = useMemo(() => groupRowIndex(sectionRows), [sectionRows]);

  // The window's size, before paint and on every resize of the grid.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const measure = (): void =>
      setView((v) =>
        v.height === el.clientHeight && v.width === el.clientWidth
          ? v
          : { ...v, height: el.clientHeight, width: el.clientWidth },
      );
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // A new query starts the list from the top.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = 0;
    setView((v) => (v.scrollTop === 0 ? v : { ...v, scrollTop: 0 }));
  }, [query]);

  const onTab = (group: string): void => {
    setQuery('');
    setActiveGroup(group);
    const top = (headingRow.get(group) ?? 0) * EMOJI_ROW_PX;
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = top;
    setView((v) => ({ ...v, scrollTop: top }));
  };
  // The tab follows the group at the top of the window.
  const onScroll = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const scrollTop = el.scrollTop;
    setView((v) => (v.scrollTop === scrollTop ? v : { ...v, scrollTop }));
    if (query.trim() !== '') return;
    const current = groupAtRow(sectionRows, Math.floor(scrollTop / EMOJI_ROW_PX));
    if (current !== null && current !== activeGroup) setActiveGroup(current);
  };

  return (
    <>
      <EmojiSearchField
        query={query}
        onQuery={setQuery}
        layout={props.layout}
        trailing={props.trailing}
      />
      <EmojiTabs query={query} activeGroup={activeGroup} onTab={onTab} />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-emoji-scroll=""
        className="relative min-h-0 flex-1 overflow-y-auto"
      >
        <EmojiGrid
          query={query}
          onPick={props.onPick}
          columns={columns}
          scrollTop={view.scrollTop}
          viewportHeight={view.height}
        />
      </div>
    </>
  );
}
