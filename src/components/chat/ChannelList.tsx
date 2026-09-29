import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { countBadgeText } from '@/components/ui/CountBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { SelectCheck } from '@/components/ui/SelectCheck';
import { popoverClass } from '@/components/ui/popover-classes';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { ActionRow, useLongPress } from '@/components/ui';
import { IconChat, IconEllipsis, IconPlus, IconTrash } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/use-media-query';
import { filterChannelsByName } from '@/lib/channel-filter';
import type { ChannelSummary } from '@/lib/chat-reads';
import { useChatStore } from '@/components/chat/ChatStoreProvider';
import {
  selectConversation,
  selectHidden,
  type ChatLoadStatus,
  type ConversationSummary,
} from '@/lib/chat/chat-store';
import {
  deleteChatFailedMessage,
  deleteChatsTitle,
  type ClearRunResult,
} from '@/lib/chat/clear-flow';
import { sortChannelsByRecency } from '@/lib/chat/sort-conversations';
import { formatRelativeTime } from '@/lib/chat/format-relative-time';
import { workspaceTimeZone } from '@/lib/chat/time-format';
import { draftText, draftsVersion, subscribeDrafts } from '@/lib/chat/drafts';
import { mentionNamesIn, resolveMentionPreview, splitAllMentions } from '@/lib/chat/mentions';
import { leaveSelectionThen } from '@/lib/chat/forward';
import {
  COARSE_POINTER_QUERY,
  DRAFT_PREFIX_TYPE,
  NO_TOUCH_SELECT,
  useChatLayout,
  type ChatLayout,
} from '@/components/chat/chat-type';

/** Per-channel draft text lookup ('' when the chat has no draft). */
type DraftLookup = (channelId: string) => string;

/** The label before a chat's unsent draft in its preview line. */
export const DRAFT_PREFIX = 'Draft: ';

/**
 * The draft a row previews: a chat's non-empty draft text, only while that chat
 * is not the one open (the open chat shows its draft in the composer). Pure.
 */
export function rowDraft(draft: string, open: boolean): string | null {
  return !open && draft.trim() !== '' ? draft : null;
}

/**
 * A stored draft as its list line: its @[uuid] tokens read "@Name" from this
 * workspace's registry only. Pure over the registry.
 */
export function draftLine(stored: string, workspaceId: string | null): string {
  return resolveMentionPreview(stored, mentionNamesIn(workspaceId));
}

/** A list line with each real "@all" token drawn bold (the ink stays the line's own). */
export function boldAllMentions(text: string): ReactNode {
  const runs = splitAllMentions(text);
  if (runs.every((run) => !run.all)) return text;
  return runs.map((run, i) =>
    run.all ? (
      <span key={i} data-mention-all="" className="font-bold">
        {run.text}
      </span>
    ) : (
      run.text
    ),
  );
}

/** Per-channel store lookup the cards read (preview, time, unread). */
type SummaryLookup = (channelId: string) => ConversationSummary | undefined;

/** Whether a channel is hidden (deleted for the caller, nothing newer since). */
type HiddenLookup = (channelId: string) => boolean;

/** Select mode (Apple Messages pattern): check chats, then delete them for me. */
export interface ChannelSelectMode {
  active: boolean;
  selectedIds: ReadonlySet<string>;
  onStart: () => void;
  onCancel: () => void;
  onToggle: (channelId: string) => void;
  /** Opens the confirm for the checked chats. */
  onDelete: () => void;
}

interface ChannelListProps {
  channels: readonly ChannelSummary[];
  /**
   * The store's load status. Rows (and the empty state) render only when
   * 'ready'; 'loading' shows skeleton rows and 'error' the Retry state.
   */
  status: ChatLoadStatus;
  /** Re-run the failed load (the error state's Retry). */
  onRetry: () => void;
  selectedChannelId: string | null;
  onSelect: (channel: ChannelSummary) => void;
  /** Opens the New chat sheet (header "+" and empty-state action). */
  onNewChat: () => void;
  /** The workspace IANA zone the card dates render in; the browser zone when absent. */
  timeZone?: string;
  /**
   * Delete chats for the caller only (sequential, stops at the first failure);
   * absent hides long-press delete and the Select control.
   */
  onDeleteChats?: (channels: ChannelSummary[]) => Promise<ClearRunResult<ChannelSummary>>;
  /** The open workspace: a Draft line resolves names from its registry only. */
  workspaceId?: string | null;
}

interface ChannelListBodyProps extends Omit<ChannelListProps, 'status' | 'onRetry'> {
  /** Whether any conversations exist before the search filter is applied. */
  hasChannels: boolean;
  /** Read-only store summaries; absent in pure tests (every card reads empty). */
  summaryFor?: SummaryLookup;
  /** Clock for relative-time labels; defaults to 0 when no summary is supplied. */
  nowMs?: number;
  /** Present while select mode is on: rows show a leading check and tap toggles. */
  selecting?: { selectedIds: ReadonlySet<string>; onToggle: (channelId: string) => void };
  /** Unsent draft text per chat; absent in pure tests (no drafts). */
  draftFor?: DraftLookup;
  /** A row was long-pressed (or right-clicked): open its menu at the row. */
  onLongPress?: (channel: ChannelSummary, rect: DOMRect | null) => void;
  /** The list's input, read once per list (never per row); touch when absent. */
  input?: ChannelListInput;
}

/**
 * What the rows need to know about the input, read by ChannelList once (one
 * listener per list, not one per row) and handed to every row.
 */
export interface ChannelListInput {
  /** The size table (touch or laptop). */
  layout: ChatLayout;
  /** A fine hover pointer: the row's hover ⋯ shows. */
  hoverMenu: boolean;
  /** A touch-first pointer: long-press owns the row menu, contextmenu is suppressed. */
  coarsePointer: boolean;
}

/** Pure tests and first renders without a list: the touch table, no hover. */
export const DEFAULT_LIST_INPUT: ChannelListInput = {
  layout: 'touch',
  hoverMenu: false,
  coarsePointer: false,
};

/** The list's input: one layout listener and two media queries for the whole list. */
export function useChannelListInput(): ChannelListInput {
  const layout = useChatLayout();
  const hoverMenu = useMediaQuery(HOVER_POINTER_QUERY);
  const coarsePointer = useMediaQuery(COARSE_POINTER_QUERY);
  return useMemo(() => ({ layout, hoverMenu, coarsePointer }), [layout, hoverMenu, coarsePointer]);
}

/**
 * The channel list body. Pure and exported so its three states are unit tested:
 * the zero-state when no conversations exist (with a real "New chat" action), a
 * distinct "No matches" state when a search hides every conversation, and one row
 * per channel otherwise.
 */
export function channelListView(props: ChannelListBodyProps): ReactElement {
  if (!props.hasChannels) {
    return (
      <EmptyState
        icon={<IconChat size={24} />}
        title="No conversations yet"
        description="Messages from your team will show up here."
        action={
          <Button size="lg" variant="primary" onClick={props.onNewChat}>
            New chat
          </Button>
        }
      />
    );
  }
  if (props.channels.length === 0) {
    return (
      <div className="px-4 py-12 text-center">
        <p className="text-sm text-fg-2">No matches</p>
        <p className="mt-1 text-xs text-fg-3">Try a different name or clear the search.</p>
      </div>
    );
  }
  const summaryFor: SummaryLookup = props.summaryFor ?? (() => undefined);
  const nowMs = props.nowMs ?? 0;
  const timeZone = workspaceTimeZone(props.timeZone);
  return (
    <ul className={CHANNEL_TILE_GRID}>
      {props.channels.map((channel) => (
        <li
          key={channel.channelId}
          className={tileKind(channel) === 'wide' ? 'col-span-2 min-w-0' : 'min-w-0'}
        >
          <ChannelCard
            channel={channel}
            selected={channel.channelId === props.selectedChannelId}
            summary={summaryFor(channel.channelId)}
            draft={rowDraft(
              props.draftFor?.(channel.channelId) ?? '',
              channel.channelId === props.selectedChannelId,
            )}
            nowMs={nowMs}
            timeZone={timeZone}
            onSelect={props.onSelect}
            input={props.input ?? DEFAULT_LIST_INPUT}
            {...(props.selecting !== undefined
              ? {
                  checked: props.selecting.selectedIds.has(channel.channelId),
                  onToggle: props.selecting.onToggle,
                }
              : {})}
            {...(props.onLongPress !== undefined ? { onLongPress: props.onLongPress } : {})}
          />
        </li>
      ))}
    </ul>
  );
}

/** Skeleton tiles shown while the list loads; enough to fill a phone screen. */
export const SKELETON_ROWS = 6;

/** The skeleton's tile kinds: two wide group tiles and four square DM tiles. */
const SKELETON_KINDS: readonly TileKind[] = [
  'wide',
  'square',
  'square',
  'wide',
  'square',
  'square',
];

/**
 * The loading body: placeholder tiles with the real tiles' boxes (wide 120px
 * with a 72px rounded-square photo, square 170px with a 48px disc), so swapping
 * in the list shifts nothing. Reuses the repo's animate-pulse + bg-panel-2
 * skeleton pattern.
 */
export function channelListSkeleton(): ReactElement {
  return (
    <ul className={CHANNEL_TILE_GRID} aria-busy="true" aria-label="Loading conversations">
      {SKELETON_KINDS.slice(0, SKELETON_ROWS).map((kind, i) => (
        <li key={i} className={kind === 'wide' ? 'col-span-2 min-w-0' : 'min-w-0'}>
          <div
            data-skeleton-row={kind}
            className={cn(tileBoxClass(kind), 'border-border bg-panel animate-pulse')}
          >
            {kind === 'wide' ? (
              <>
                <div className="h-[72px] w-[72px] shrink-0 rounded-[14px] bg-panel-2" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="h-3.5 w-1/2 rounded bg-panel-2" />
                  <div className="h-3 w-3/4 rounded bg-panel-2" />
                </div>
              </>
            ) : (
              <>
                <div className="h-12 w-12 shrink-0 rounded-full bg-panel-2" />
                <div className="mt-2 h-3.5 w-2/3 rounded bg-panel-2" />
                <div className="mt-2 h-3 w-full rounded bg-panel-2" />
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The error body: the load failed, so no partial list; Retry re-runs it. */
export function channelListError(onRetry: () => void): ReactElement {
  return (
    <EmptyState
      icon={<IconChat size={24} />}
      title="Couldn't load conversations"
      description="Check your connection and try again."
      action={
        <Button size="lg" variant="primary" className="min-w-[44px]" onClick={onRetry}>
          Retry
        </Button>
      }
    />
  );
}

/**
 * Build the preview line: an optional sender prefix before the last message. A
 * channel whose last message is known only by time (outside the preview scan)
 * reads as an empty line rather than "No messages yet".
 */
export function previewLine(summary: ConversationSummary): string {
  if (summary.lastMessageText === '') return '';
  const prefix = summary.lastMessagePrefix !== undefined ? `${summary.lastMessagePrefix}: ` : '';
  return `${prefix}${summary.lastMessageText}`;
}

/** Devices that get the hover ⋯ control (a mouse or trackpad, not touch). */
const HOVER_POINTER_QUERY = '(hover: hover) and (pointer: fine)';

/** Shift+F10 or the ContextMenu key opens a focused row's menu (Enter still opens the chat). */
export function rowMenuKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
}

/** A home tile's shape: a group channel is wide (both columns), a DM is square. */
export type TileKind = 'wide' | 'square';

/** The tile a channel renders as: group -> wide, DM -> square. Pure. */
export function tileKind(channel: Pick<ChannelSummary, 'channelType'>): TileKind {
  return channel.channelType === 'group' ? 'wide' : 'square';
}

/** The unread pill's text, or null when there is nothing unread (no pill). Pure. */
export function unreadPillText(unread: number): string | null {
  return unread > 0 ? countBadgeText(unread) : null;
}

/** The home grid: two fluid columns, 8px gaps, 12px side padding. */
export const CHANNEL_TILE_GRID =
  'grid grid-flow-row-dense grid-cols-[repeat(2,minmax(0,1fr))] gap-2 px-3';

/** Tile type: name 16/600, preview 14/19, time 12 (same on touch and laptop). */
export const TILE_NAME_TYPE = 'text-[16px] leading-[20px] font-semibold';
export const TILE_PREVIEW_TYPE = 'text-[14px] leading-[19px] font-normal';
export const TILE_TIME_TYPE = 'font-sans text-xs font-normal tabular-nums';

/**
 * The wide tile's 72px rounded-square (radius 14) group photo: the shared
 * Avatar (photo or initials fallback, unchanged) resized in place, so the box
 * is final on first paint.
 */
export const GROUP_TILE_PHOTO =
  'flex h-[72px] w-[72px] shrink-0 [&>*]:!h-[72px] [&>*]:!w-[72px] [&>*]:!rounded-[14px] [&>*]:!text-xl';

/** The unread pill: 22px min, radius 11, accent fill, 12/700. */
export const TILE_PILL =
  'inline-flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-[11px] bg-accent px-1.5 text-xs font-bold leading-none tabular-nums text-accent-fg';

/**
 * A tile's box: hairline border, radius 14, padding 12 and its fixed height
 * (wide 120 as a row, square 170 as a column). Shared by the skeleton so
 * swapping in the list shifts nothing.
 */
export function tileBoxClass(kind: TileKind): string {
  return cn(
    'flex w-full rounded-[14px] border p-3',
    kind === 'wide' ? 'h-[120px] items-center gap-3' : 'h-[170px] flex-col items-stretch',
  );
}

/** Tile state that picks the tile fill. */
export interface ChannelRowState {
  kind: TileKind;
  /** Desktop: this chat is open in the thread pane. */
  selected: boolean;
  /** Select mode is on. */
  selecting: boolean;
  /** Select mode: this tile is checked. */
  checked: boolean;
}

/**
 * The tile's tap target classes: the whole tile is one button. Panel fill with
 * a hairline border; a checked tile takes the accent tint, the open chat on
 * desktop takes panel-2. Token classes only, so light and dark stay at parity.
 */
export function channelRowClass(state: ChannelRowState): string {
  const checked = state.selecting && state.checked;
  const open = state.selected && !state.selecting;
  return cn(
    tileBoxClass(state.kind),
    CHANNEL_ROW_BUTTON,
    checked ? 'border-accent-line bg-accent-soft' : 'border-border',
    checked ? undefined : open ? 'bg-panel-2' : 'bg-panel hover:bg-panel-2',
  );
}

/**
 * The tile's contextmenu on a touch-first pointer: the native menu and callout
 * never show (the long-press opens the tile menu). A laptop's right-click is
 * left alone here. Pure.
 */
export function chatRowContextMenu(
  coarsePointer: boolean,
): ((event: { preventDefault: () => void }) => void) | undefined {
  return coarsePointer ? (event) => event.preventDefault() : undefined;
}

/** The tile button's behaviour: no text selection, no iOS callout, focus ring. */
export const CHANNEL_ROW_BUTTON = cn(
  'min-w-0 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
  NO_TOUCH_SELECT,
);

/** The unread pill, or nothing when the count is 0. */
function unreadPill(unread: number): ReactElement | null {
  const text = unreadPillText(unread);
  return text === null ? null : (
    <span data-unread-pill="" className={TILE_PILL}>
      {text}
    </span>
  );
}

/**
 * The inside of one tile. Wide (group): 72px rounded-square photo, then name +
 * time + pill over a 3-line preview. Square (DM): 48px disc + pill, name, a
 * 2-line preview, time pinned to the bottom. The avatar URL is on the summary
 * before the tile mounts (one batched list read), so a tile with a photo paints
 * the photo first, never the initials. Hook-free so the tile's states are
 * snapshot tested.
 */
export function channelRowBody(props: {
  channel: ChannelSummary;
  summary: ConversationSummary | undefined;
  /** The chat's unsent draft (not open): the preview reads "Draft: <text>". */
  draft?: string | null;
  nowMs: number;
  timeZone: string;
  selecting: boolean;
  checked: boolean;
}): ReactElement {
  const { channel, summary } = props;
  const kind = tileKind(channel);
  const hasMessage = summary !== undefined && summary.lastMessageTs > 0;
  const unread = summary?.unread ?? 0;
  const preview = hasMessage ? previewLine(summary) : 'No messages yet';
  const draft = props.draft ?? null;
  const time = hasMessage
    ? formatRelativeTime(summary.lastMessageTs, props.nowMs, props.timeZone)
    : '';
  const clamp = kind === 'wide' ? 'line-clamp-3' : 'line-clamp-2';
  const name = (
    <span className={cn('min-w-0 truncate text-fg', TILE_NAME_TYPE)}>{channel.title}</span>
  );
  const timeNode =
    time !== '' ? <span className={cn('shrink-0 text-fg-2', TILE_TIME_TYPE)}>{time}</span> : null;
  const check = props.selecting ? <SelectCheck checked={props.checked} /> : null;
  const previewNode =
    draft !== null ? (
      <span
        data-draft-preview=""
        className={cn('min-w-0 break-words text-fg-2', clamp, TILE_PREVIEW_TYPE)}
      >
        <span className={cn('text-accent', DRAFT_PREFIX_TYPE)}>{DRAFT_PREFIX}</span>
        {boldAllMentions(draft)}
      </span>
    ) : (
      <span
        className={cn(
          'min-w-0 break-words',
          clamp,
          TILE_PREVIEW_TYPE,
          hasMessage ? 'text-fg-2' : 'text-fg-3',
        )}
      >
        {boldAllMentions(preview)}
      </span>
    );
  if (kind === 'wide') {
    return (
      <>
        <span data-group-photo="" className={GROUP_TILE_PHOTO}>
          <Avatar
            name={channel.title}
            {...(channel.avatarUrl !== null ? { src: channel.avatarUrl } : {})}
            size="row"
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="flex min-w-0 flex-1">{name}</span>
            {timeNode}
            {unreadPill(unread)}
            {check}
          </span>
          {previewNode}
        </span>
      </>
    );
  }
  return (
    <>
      <span className="flex items-start justify-between gap-2">
        <span className="shrink-0">
          <Avatar
            name={channel.title}
            {...(channel.avatarUrl !== null ? { src: channel.avatarUrl } : {})}
            size="row"
          />
        </span>
        <span className="flex items-center gap-2">
          {unreadPill(unread)}
          {check}
        </span>
      </span>
      <span className="mt-2 flex min-w-0">{name}</span>
      <span className="mt-0.5 flex min-w-0">{previewNode}</span>
      {timeNode !== null ? <span className="mt-auto flex">{timeNode}</span> : null}
    </>
  );
}

/**
 * One conversation tile; the whole tile is one button ("Open <name>"). A touch
 * long-press (moving or scrolling cancels it), right-click, Shift+F10, or the
 * hover ⋯ in the tile's corner (pointer devices only) opens the tile menu; the
 * trailing click is swallowed so a long-press never also opens the chat. In
 * select mode a check circle shows and a tap toggles.
 */
export function ChannelCard(props: {
  channel: ChannelSummary;
  selected: boolean;
  summary: ConversationSummary | undefined;
  /** The chat's unsent draft when it is not open; null or absent shows the last message. */
  draft?: string | null;
  nowMs: number;
  timeZone: string;
  onSelect: (channel: ChannelSummary) => void;
  /** The list's input (hover, coarse), read once by the list. */
  input: ChannelListInput;
  /** Present in select mode: whether this tile is checked. */
  checked?: boolean;
  onToggle?: (channelId: string) => void;
  onLongPress?: (channel: ChannelSummary, rect: DOMRect | null) => void;
}): ReactElement {
  const { channel, summary } = props;
  const rowRef = useRef<HTMLButtonElement>(null);
  const selecting = props.onToggle !== undefined;
  const { hoverMenu, coarsePointer } = props.input;
  const menuEnabled = !selecting && props.onLongPress !== undefined;
  // This gesture's hold already opened the menu; reset on every pointerdown.
  const holdFiredRef = useRef(false);
  const openMenu = (anchor?: DOMRect): void => {
    if (selecting || props.onLongPress === undefined) return;
    // The menu's backdrop takes the trailing pointerup, so no click to swallow.
    clearClickSuppression();
    props.onLongPress(channel, anchor ?? rowRef.current?.getBoundingClientRect() ?? null);
  };
  // Mouse holds never open the menu (right-click and ⋯ do); touch is unchanged.
  const { handlers, consumeClickSuppression, cancel, clearClickSuppression } = useLongPress(
    () => {
      holdFiredRef.current = true;
      openMenu();
    },
    { ignoreMouse: true },
  );
  const checked = props.checked === true;
  return (
    <div
      className={cn('group relative', NO_TOUCH_SELECT)}
      // Touch-first: the native menu and callout never show on a tile.
      onContextMenu={chatRowContextMenu(coarsePointer)}
    >
      <button
        ref={rowRef}
        type="button"
        {...(menuEnabled
          ? {
              ...handlers,
              onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
                holdFiredRef.current = false;
                handlers.onPointerDown(e);
              },
            }
          : {})}
        onContextMenu={(e: MouseEvent) => {
          if (coarsePointer) e.preventDefault();
          if (!menuEnabled) return;
          e.preventDefault();
          cancel();
          // Touch-first: a contextmenu that beats the hold timer acts as the hold, once.
          if (coarsePointer && holdFiredRef.current) return;
          holdFiredRef.current = true;
          openMenu();
        }}
        onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
          if (!menuEnabled || !rowMenuKey(e)) return;
          e.preventDefault();
          openMenu();
        }}
        onClick={() => {
          if (consumeClickSuppression()) return;
          if (selecting) {
            props.onToggle?.(channel.channelId);
            return;
          }
          // A thread selecting messages exits that first (history.back()).
          leaveSelectionThen(() => props.onSelect(channel));
        }}
        aria-label={`Open ${channel.title}`}
        {...(selecting ? { 'aria-pressed': checked } : {})}
        className={channelRowClass({
          kind: tileKind(channel),
          selected: props.selected,
          selecting,
          checked,
        })}
      >
        {channelRowBody({
          channel,
          summary,
          draft: props.draft ?? null,
          nowMs: props.nowMs,
          timeZone: props.timeZone,
          selecting,
          checked,
        })}
      </button>
      {menuEnabled && hoverMenu ? (
        <button
          type="button"
          data-more=""
          aria-label={`Actions for ${channel.title}`}
          aria-haspopup="menu"
          onClick={(e) => openMenu(e.currentTarget.getBoundingClientRect())}
          className="absolute bottom-1 right-1 flex h-11 w-11 items-center justify-center rounded-md bg-panel text-fg-3 opacity-0 hover:bg-panel-3 hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <IconEllipsis size={20} />
        </button>
      ) : null}
    </div>
  );
}

interface ChannelListContentProps extends ChannelListProps {
  search: string;
  onSearchChange: (value: string) => void;
  /** Read-only store summaries; absent in pure tests (every card reads empty). */
  summaryFor?: SummaryLookup;
  /** Clock for relative-time labels, threaded to the cards. */
  nowMs?: number;
  /** Hidden-chat lookup; absent in pure tests (nothing is hidden). */
  isHidden?: HiddenLookup;
  /** Select mode controls; absent hides the Select control. */
  select?: ChannelSelectMode;
  /** Row long-press; absent disables the row menu. */
  onLongPress?: (channel: ChannelSummary, rect: DOMRect | null) => void;
  /** Unsent draft text per chat; absent in pure tests (no drafts). */
  draftFor?: DraftLookup;
  /** The list's input, read once by ChannelList; touch when absent. */
  input?: ChannelListInput;
}

/**
 * The rows the list shows, most recent first. A hidden chat (deleted for the
 * caller, nothing newer since) is left out of the plain list, but a name
 * search still finds it so it can be reopened.
 */
export function visibleChannels(
  channels: readonly ChannelSummary[],
  summaryFor: SummaryLookup,
  isHidden: HiddenLookup,
  search: string,
): ChannelSummary[] {
  const ordered = sortChannelsByRecency(channels, summaryFor);
  if (search.trim() === '') return ordered.filter((c) => !isHidden(c.channelId));
  return filterChannelsByName(ordered, search);
}

/** Header in select mode: the checked count and Cancel. */
function selectHeader(select: ChannelSelectMode): ReactElement {
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-3 md:px-6">
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
        {`${select.selectedIds.size} selected`}
      </span>
      <Button variant="ghost" size="lg" onClick={select.onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/** Bottom bar in select mode (SelectionBar styling): one Delete, disabled at 0. */
function selectBar(select: ChannelSelectMode): ReactElement {
  return (
    <div className="flex items-center gap-2 border-t border-border bg-panel px-4 py-3">
      <Button
        variant="danger"
        size="lg"
        className="ml-auto"
        disabled={select.selectedIds.size === 0}
        onClick={select.onDelete}
      >
        <IconTrash size={18} />
        Delete
      </Button>
    </div>
  );
}

/**
 * The full channel list pane: the shared SectionHeader (controlled name search +
 * accent "+" New chat, no sort, no chips) above the body. While loading the body
 * is skeleton rows and on error a Retry state; Select, rows and the empty state
 * appear only once the store is ready, already hidden-filtered and sorted. Pure (no
 * hooks) so the search wiring and the single-header guarantee are unit tested by
 * walking the returned tree; ChannelList owns the search state.
 */
export function channelListContent(props: ChannelListContentProps): ReactElement {
  const summaryFor: SummaryLookup = props.summaryFor ?? (() => undefined);
  const isHidden: HiddenLookup = props.isHidden ?? (() => false);
  const ready = props.status === 'ready';
  const hasChannels = ready && props.channels.some((c) => !isHidden(c.channelId));
  const select = ready ? props.select : undefined;
  const selecting = select?.active === true ? select : undefined;
  // New chat from a thread selecting messages exits that first (history.back()).
  const newChat = (): void => leaveSelectionThen(props.onNewChat);
  return (
    <div className="flex h-full flex-col">
      {selecting !== undefined ? (
        selectHeader(selecting)
      ) : (
        <div className="border-b border-border pb-3">
          <SectionHeader
            search={{
              value: props.search,
              onChange: props.onSearchChange,
              placeholder: 'Search conversations',
            }}
            primaryAction={{
              node: (
                <>
                  {select !== undefined && hasChannels ? (
                    <Button variant="ghost" size="lg" onClick={select.onStart}>
                      Select
                    </Button>
                  ) : null}
                  <Button
                    variant="primary"
                    size="lg"
                    aria-label="New chat"
                    className="w-11 px-0"
                    onClick={newChat}
                  >
                    <IconPlus size={18} />
                  </Button>
                </>
              ),
            }}
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {props.status === 'loading'
          ? channelListSkeleton()
          : props.status === 'error'
            ? channelListError(props.onRetry)
            : channelListView({
                channels: visibleChannels(props.channels, summaryFor, isHidden, props.search),
                hasChannels: hasChannels || props.search.trim() !== '',
                selectedChannelId: props.selectedChannelId,
                onSelect: props.onSelect,
                onNewChat: newChat,
                summaryFor,
                ...(props.draftFor !== undefined ? { draftFor: props.draftFor } : {}),
                ...(selecting !== undefined
                  ? {
                      selecting: {
                        selectedIds: selecting.selectedIds,
                        onToggle: selecting.onToggle,
                      },
                    }
                  : {}),
                ...(props.onLongPress !== undefined && selecting === undefined
                  ? { onLongPress: props.onLongPress }
                  : {}),
                ...(props.nowMs !== undefined ? { nowMs: props.nowMs } : {}),
                ...(props.timeZone !== undefined ? { timeZone: props.timeZone } : {}),
                ...(props.input !== undefined ? { input: props.input } : {}),
              })}
      </div>
      {selecting !== undefined ? selectBar(selecting) : null}
    </div>
  );
}

/**
 * The small menu a long-pressed row opens: one danger "Delete chat" row. Fixed
 * over the list (portal) and placed under the row, or above it when there is no
 * room; closes on backdrop tap, Escape, scroll or resize. Design tokens only.
 */
function ChannelRowMenu(props: {
  anchor: DOMRect | null;
  onClose: () => void;
  onDelete: () => void;
}): ReactElement | null {
  const { anchor, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const [shown, setShown] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (anchor === null || el === null) {
      setCoords(null);
      return;
    }
    const { width, height } = el.getBoundingClientRect();
    let top = anchor.bottom + 4;
    if (top + height > window.innerHeight - 8) top = Math.max(8, anchor.top - height - 4);
    const left = Math.max(8, Math.min(anchor.left + 12, window.innerWidth - width - 8));
    setCoords({ top, left });
  }, [anchor]);

  // Enter motion: flip to shown once the menu has been placed.
  const placed = coords !== null;
  useEffect(() => {
    if (!placed) {
      setShown(false);
      return;
    }
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [placed]);

  // Focus the first item once placed; hand focus back on close if nothing took it.
  useEffect(() => {
    if (!placed) return;
    const previous = document.activeElement;
    ref.current?.querySelector('button')?.focus({ preventScroll: true });
    return () => {
      const current = document.activeElement;
      const idle = current === null || current === document.body;
      if (idle && previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [placed]);

  useEffect(() => {
    if (anchor === null) return;
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  if (anchor === null) return null;
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={ref}
        role="menu"
        aria-label="Chat actions"
        className={cn(
          'fixed z-50 min-w-[200px] origin-top-left whitespace-nowrap',
          popoverClass(shown),
        )}
        style={{
          top: coords?.top ?? 0,
          left: coords?.left ?? 0,
          visibility: coords === null ? 'hidden' : 'visible',
        }}
      >
        <div role="menuitem">
          <ActionRow
            icon={<IconTrash />}
            label="Delete chat"
            danger
            onClick={() => {
              onClose();
              props.onDelete();
            }}
          />
        </div>
      </div>
    </>,
    document.body,
  );
}

/** Confirm body: the delete is local to the caller and undone by a new message. */
export const DELETE_CHATS_MESSAGE =
  'Hidden for you only. It comes back if someone sends a new message.';

/**
 * The delete-for-me confirm, or null when nothing is pending. Hook-free so the
 * confirm and cancel wiring are unit tested by calling the dialog's handlers.
 */
export function deleteChatsConfirm(props: {
  channels: readonly ChannelSummary[] | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement | null {
  if (props.channels === null) return null;
  return (
    <ConfirmDialog
      title={deleteChatsTitle(props.channels.length)}
      message={DELETE_CHATS_MESSAGE}
      confirmLabel="Delete"
      busyLabel="Deleting"
      destructive
      busy={props.busy}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  );
}

/** Scrollable channel list pane with the shared search/create header. */
export function ChannelList(props: ChannelListProps): ReactElement {
  const listWorkspaceId = props.workspaceId ?? null;
  const [search, setSearch] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ channel: ChannelSummary; rect: DOMRect | null } | null>(null);
  const [confirm, setConfirm] = useState<ChannelSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { state } = useChatStore();
  const summaryFor = useCallback<SummaryLookup>(
    (channelId) => selectConversation(state, channelId),
    [state],
  );
  const isHidden = useCallback<HiddenLookup>(
    (channelId) => selectHidden(state, channelId),
    [state],
  );
  // Drafts live outside React; re-read the rows whenever one changes.
  const drafts = useSyncExternalStore(subscribeDrafts, draftsVersion, draftsVersion);
  const draftFor = useCallback<DraftLookup>(
    (channelId) => draftLine(draftText(channelId), listWorkspaceId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafts, listWorkspaceId],
  );
  const onDeleteChats = props.onDeleteChats;
  const closeMenu = useCallback(() => setMenu(null), []);
  const exitSelect = (): void => {
    setSelecting(false);
    setSelectedIds(new Set());
  };

  async function runDelete(list: ChannelSummary[]): Promise<void> {
    if (onDeleteChats === undefined || busy || list.length === 0) return;
    setBusy(true);
    const result = await onDeleteChats(list);
    setBusy(false);
    setConfirm(null);
    if (result.ok) {
      exitSelect();
      return;
    }
    toast.show({ title: deleteChatFailedMessage(result.failed.title) });
    // The chats before the failed one are gone; keep the rest checked.
    const at = list.findIndex((c) => c.channelId === result.failed.channelId);
    setSelectedIds(new Set(list.slice(Math.max(0, at)).map((c) => c.channelId)));
  }

  // One layout listener (and hover / coarse query) for the whole list.
  const input = useChannelListInput();
  return (
    <>
      {channelListContent({
        ...props,
        input,
        search,
        onSearchChange: setSearch,
        summaryFor,
        isHidden,
        draftFor,
        nowMs: Date.now(),
        ...(onDeleteChats !== undefined
          ? {
              select: {
                active: selecting,
                selectedIds,
                onStart: () => {
                  setMenu(null);
                  setSelectedIds(new Set());
                  setSelecting(true);
                },
                onCancel: exitSelect,
                onToggle: (channelId: string) =>
                  setSelectedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(channelId)) next.delete(channelId);
                    else next.add(channelId);
                    return next;
                  }),
                onDelete: () =>
                  setConfirm(props.channels.filter((c) => selectedIds.has(c.channelId))),
              },
              onLongPress: (channel: ChannelSummary, rect: DOMRect | null) =>
                setMenu({ channel, rect }),
            }
          : {}),
      })}
      {onDeleteChats !== undefined ? (
        <>
          <ChannelRowMenu
            anchor={menu?.rect ?? null}
            onClose={closeMenu}
            onDelete={() => {
              if (menu !== null) setConfirm([menu.channel]);
            }}
          />
          {deleteChatsConfirm({
            channels: confirm,
            busy,
            onCancel: () => setConfirm(null),
            onConfirm: () => void runDelete(confirm ?? []),
          })}
        </>
      ) : null}
    </>
  );
}
