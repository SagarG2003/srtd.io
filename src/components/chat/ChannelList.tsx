import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { CountBadge } from '@/components/ui/CountBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { SelectCheck } from '@/components/ui/SelectCheck';
import { popoverClass } from '@/components/ui/popover-classes';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { ActionRow, useLongPress } from '@/components/ui';
import { IconChat, IconEllipsis, IconPlus, IconTrash, IconUsers } from '@/components/ui/icons';
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
  /** A row was long-pressed (or right-clicked): open its menu at the row. */
  onLongPress?: (channel: ChannelSummary, rect: DOMRect | null) => void;
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
    <ul className="flex flex-col">
      {props.channels.map((channel) => (
        <li key={channel.channelId}>
          <ChannelCard
            channel={channel}
            selected={channel.channelId === props.selectedChannelId}
            summary={summaryFor(channel.channelId)}
            nowMs={nowMs}
            timeZone={timeZone}
            onSelect={props.onSelect}
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

/** Skeleton rows shown while the list loads; enough to fill a phone screen. */
export const SKELETON_ROWS = 6;

/**
 * The loading body: placeholder rows with the real row's box (padding, min
 * height, bottom rule) and a 48px avatar disc, so swapping in the list shifts
 * nothing. Reuses the repo's animate-pulse + bg-panel-2 skeleton pattern.
 */
export function channelListSkeleton(): ReactElement {
  return (
    <ul className="flex flex-col" aria-busy="true" aria-label="Loading conversations">
      {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
        <li key={i}>
          <div
            data-skeleton-row
            className="flex w-full items-center gap-3.5 border-b border-border px-4 py-2.5 min-h-[72px] animate-pulse"
          >
            <div className="h-12 w-12 shrink-0 rounded-full bg-panel-2" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="h-3.5 w-1/2 rounded bg-panel-2" />
              <div className="h-3 w-3/4 rounded bg-panel-2" />
            </div>
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

/** Row state that picks the row tint. */
export interface ChannelRowState {
  /** Desktop: this chat is open in the thread pane. */
  selected: boolean;
  unread: boolean;
  /** Select mode is on. */
  selecting: boolean;
  /** Select mode: this row is checked. */
  checked: boolean;
}

/**
 * The dense row's container classes: full width, no card, a hairline rule under
 * each row. Checked and unread rows take the accent tint; the open chat on
 * desktop takes panel-2. Token classes only, so light and dark stay at parity.
 */
export function channelRowClass(state: ChannelRowState): string {
  return cn(
    'group flex w-full items-center border-b border-border transition-colors hover:bg-panel-2',
    state.selecting && state.checked
      ? 'bg-accent-soft'
      : state.unread
        ? 'bg-accent-soft'
        : state.selected && !state.selecting
          ? 'bg-panel-2'
          : undefined,
  );
}

/** The row's tap target: avatar, two text lines, full row height. */
export const CHANNEL_ROW_BUTTON =
  'flex min-w-0 flex-1 select-none items-center gap-3.5 px-4 min-h-[72px] py-2.5 text-left [-webkit-touch-callout:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent';

/** The 48px row avatar; a group with no picture shows the people glyph, not initials. */
function channelAvatar(channel: ChannelSummary): ReactElement {
  if (channel.channelType === 'group' && channel.avatarUrl === null) {
    return (
      <span
        data-group-avatar=""
        aria-hidden="true"
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-panel-3 text-fg-2"
      >
        <IconUsers size={20} />
      </span>
    );
  }
  return (
    <Avatar
      name={channel.title}
      {...(channel.avatarUrl !== null ? { src: channel.avatarUrl } : {})}
      size="row"
    />
  );
}

/**
 * The inside of one dense row: optional select circle, avatar, then name + time
 * over preview + unread count. Hook-free so the row's states are snapshot tested.
 */
export function channelRowBody(props: {
  channel: ChannelSummary;
  summary: ConversationSummary | undefined;
  nowMs: number;
  timeZone: string;
  selecting: boolean;
  checked: boolean;
}): ReactElement {
  const { channel, summary } = props;
  const hasMessage = summary !== undefined && summary.lastMessageTs > 0;
  const unread = summary?.unread ?? 0;
  const isUnread = unread > 0;
  const preview = hasMessage ? previewLine(summary) : 'No messages yet';
  const time = hasMessage
    ? formatRelativeTime(summary.lastMessageTs, props.nowMs, props.timeZone)
    : '';
  return (
    <>
      {props.selecting ? <SelectCheck checked={props.checked} /> : null}
      {channelAvatar(channel)}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[16px] leading-tight text-fg',
              isUnread ? 'font-semibold' : 'font-medium',
            )}
          >
            {channel.title}
          </span>
          {time !== '' ? (
            <span
              className={cn(
                'shrink-0 font-mono text-xs tabular-nums',
                isUnread ? 'text-accent' : 'text-fg-3',
              )}
            >
              {time}
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm',
              hasMessage ? 'text-fg-2' : 'text-fg-3',
            )}
          >
            {preview}
          </span>
          {isUnread ? <CountBadge count={unread} className="shrink-0" /> : null}
        </span>
      </span>
    </>
  );
}

/**
 * A dense, full-width conversation row. A touch long-press (moving or
 * scrolling cancels it), right-click, Shift+F10, or the hover ⋯ at the row's
 * end (pointer devices only) opens the row menu; the trailing click is
 * swallowed so a long-press never also opens the chat. In select mode a
 * leading check circle shows and a tap toggles.
 */
export function ChannelCard(props: {
  channel: ChannelSummary;
  selected: boolean;
  summary: ConversationSummary | undefined;
  nowMs: number;
  timeZone: string;
  onSelect: (channel: ChannelSummary) => void;
  /** Present in select mode: whether this row is checked. */
  checked?: boolean;
  onToggle?: (channelId: string) => void;
  onLongPress?: (channel: ChannelSummary, rect: DOMRect | null) => void;
}): ReactElement {
  const { channel, summary } = props;
  const rowRef = useRef<HTMLButtonElement>(null);
  const selecting = props.onToggle !== undefined;
  const hoverMenu = useMediaQuery(HOVER_POINTER_QUERY);
  const menuEnabled = !selecting && props.onLongPress !== undefined;
  const openMenu = (anchor?: DOMRect): void => {
    if (selecting || props.onLongPress === undefined) return;
    // The menu's backdrop takes the trailing pointerup, so no click to swallow.
    clearClickSuppression();
    props.onLongPress(channel, anchor ?? rowRef.current?.getBoundingClientRect() ?? null);
  };
  // Mouse holds never open the menu (right-click and ⋯ do); touch is unchanged.
  const { handlers, consumeClickSuppression, cancel, clearClickSuppression } = useLongPress(
    () => openMenu(),
    { ignoreMouse: true },
  );
  const checked = props.checked === true;
  return (
    <div
      className={channelRowClass({
        selected: props.selected,
        unread: (summary?.unread ?? 0) > 0,
        selecting,
        checked,
      })}
    >
      <button
        ref={rowRef}
        type="button"
        {...(menuEnabled ? handlers : {})}
        onContextMenu={(e: MouseEvent) => {
          if (!menuEnabled) return;
          e.preventDefault();
          cancel();
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
          props.onSelect(channel);
        }}
        aria-label={channel.title}
        {...(selecting ? { 'aria-pressed': checked } : {})}
        className={CHANNEL_ROW_BUTTON}
      >
        {channelRowBody({
          channel,
          summary,
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
          className="mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-fg-3 opacity-0 hover:bg-panel-3 hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover:opacity-100 group-focus-within:opacity-100"
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
                    onClick={props.onNewChat}
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
                onNewChat: props.onNewChat,
                summaryFor,
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

  return (
    <>
      {channelListContent({
        ...props,
        search,
        onSearchChange: setSearch,
        summaryFor,
        isHidden,
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
