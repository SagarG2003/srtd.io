import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
  type ReactElement,
} from 'react';
import { isNearBottom } from '@/lib/chat/scroll';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import {
  IconChat,
  IconChevronLeft,
  IconClock,
  IconEllipsis,
  IconForward,
  IconRotateCcw,
  IconSettings,
  IconTickDouble,
  IconTickSingle,
  IconUsers,
} from '@/components/ui/icons';
import { useLongPress, type LongPressHandlers } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/use-media-query';
import type { ChannelSummary, ChatProfile } from '@/lib/chat-reads';
import { breaksRun, isTimeGap, replyPreview, type ThreadMessage } from '@/lib/chat/thread';
import { classifyAttachment, type ReplyQuote } from '@/lib/chat/attachments';
import { useChatAttachments } from '@/lib/chat/use-chat-attachments';
import { formatMessageTime } from '@/lib/chat/time-format';
import type { PresignCache } from '@/lib/asset-presign';
import { Composer, type ComposerSend } from '@/components/chat/Composer';
import { MessageAttachments } from '@/components/chat/MessageAttachments';
import { SharedPostCards } from '@/components/chat/PostCard';
import { MessageActionMenu } from '@/components/chat/MessageActionMenu';
import { SharedBriefCards } from '@/components/chat/BriefCard';
import { MarkBadge, SelectCheckbox, SelectLock } from '@/components/chat/MarkBits';
import { MarkStrip, MarksSheet, PrioritySheet } from '@/components/chat/MarksSheet';
import { SelectionBar } from '@/components/chat/SelectionBar';
import { ReplyQuoteBox } from '@/components/chat/ReplyQuote';
import { withDaySeparators } from '@/components/chat/day-separators';
import { ForwardPicker, type ForwardSendResult } from '@/components/chat/ForwardPicker';
import {
  FORWARDED_LABEL,
  canDeleteSelection,
  canForward,
  pruneThreadSelection,
  selectedForForward,
  threadSelectable,
} from '@/lib/chat/forward';
import {
  markMenuOptions,
  toggleSelected,
  type ChatMark,
  type FindOlderOutcome,
  type MarkPriority,
  type MarkType,
  type SelectionRole,
} from '@/lib/chat/marks';
import type { WriteResult } from '@/lib/chat/record';

interface MessageThreadProps {
  title: string;
  /** Header avatar src (the DM peer's); absent or null falls back to initials. */
  avatarUrl?: string | null;
  /** Header second line for a DM (the workspace name); absent shows presence instead. */
  subtitle?: string;
  /** Sender display info keyed by Sorted user id; batched read, never per-row. */
  profiles: Map<string, ChatProfile>;
  messages: ThreadMessage[];
  loading: boolean;
  /** An older page is loading (scroll-to-top); renders a slim row at the top. */
  loadingOlder?: boolean;
  /** Whether scrolling to the top should request an older page. */
  hasMore?: boolean;
  onLoadOlder?: () => void;
  /** The newest message is on screen; the thread advances the read cursor. */
  onNewestVisible?: () => void;
  /** The workspace IANA zone every timestamp renders in. */
  timeZone: string;
  /** False when sending is impossible (no channel selected). */
  canSend: boolean;
  onSend: ComposerSend;
  /** Every mark of the channel keyed by message id (resolved included); absent = no marks UI. */
  marks?: Map<string, ChatMark>;
  /** Marked messages read from the record, for sheet rows beyond loaded history. */
  markedMessages?: Map<string, ThreadMessage>;
  /** Mark a message, or change an open pending mark's priority (same type). */
  onSetMark?: (messageId: string, type: MarkType, priority: MarkPriority) => Promise<WriteResult>;
  /** Stamp an open mark (Delivered / Closed / Completed). */
  onResolveMark?: (messageId: string) => Promise<WriteResult>;
  /** Return a stamped mark to open. */
  onReopenMark?: (messageId: string) => Promise<WriteResult>;
  /** The caller's user id; the pin board names their own stamps "You". */
  currentUserId?: string;
  /** Delete own messages for everyone; absent hides "Select". */
  onDeleteMessages?: (
    messageIds: readonly string[],
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** Load older pages until a message is present (jump-to). */
  onEnsureLoaded?: (messageId: string) => Promise<FindOlderOutcome>;
  /** Re-run a failed send with the same message id. */
  onRetry?: (messageId: string) => void;
  /** Present on small screens only; renders a back affordance to the list. */
  onBack?: () => void;
  /** Present for group channels only; opens the group management panel. */
  onOpenInfo?: () => void;
  /** True for group channels; drives per-run avatars and sender names. Absent = DM. */
  isGroup?: boolean;
  /** Sorted user ids currently typing (peers only); drives the indicator row. */
  typingUserIds: string[];
  /** Forwarded to the composer so each keystroke broadcasts a typing signal. */
  onTyping?: () => void;
  /** DM peer presence; absent for groups. Renders a header status line when available. */
  presence?: { online: boolean; lastTimeMs: number | null; available: boolean };
  /** True only for DM threads; gates seen ticks on own bubbles. */
  showTicks?: boolean;
  /** Add or remove the current user's reaction on a message. */
  onToggleReaction?: (messageId: string, emoji: string, currentlyMine: boolean) => void;
  /** Chats the forward picker lists (every chat the caller is in); absent hides Forward. */
  forwardChannels?: readonly ChannelSummary[];
  /** Forward messages to chats; absent hides Forward. */
  onForward?: (
    messages: readonly ThreadMessage[],
    targets: ChannelSummary[],
  ) => Promise<ForwardSendResult>;
}

/** Devices that get the hover ⋯ control (a mouse or trackpad, not touch). */
export const HOVER_POINTER_QUERY = '(hover: hover) and (pointer: fine)';

/**
 * Whether a keydown on a focused bubble (or channel row) opens its action menu:
 * Enter or Space on the element itself, or Shift+F10 / the ContextMenu key. Keys
 * bubbling up from a control inside (quoted reply, reaction badge) are ignored.
 */
export function keyOpensMenu(event: {
  key: string;
  shiftKey: boolean;
  target: unknown;
  currentTarget: unknown;
}): boolean {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) return true;
  if (event.target !== event.currentTarget) return false;
  return event.key === 'Enter' || event.key === ' ';
}

/** A voice note alone (no text, cards or other files): it takes the text-bubble layout. */
export function isVoiceOnly(
  message: Pick<ThreadMessage, 'body' | 'attachments' | 'sharedPostIds' | 'sharedBriefIds'>,
): boolean {
  const [only] = message.attachments;
  return (
    message.attachments.length === 1 &&
    only !== undefined &&
    classifyAttachment(only.mime) === 'audio' &&
    message.body.trim() === '' &&
    message.sharedPostIds.length === 0 &&
    message.sharedBriefIds.length === 0
  );
}

/** Scroll positions within this many px of the top request the older page. */
const LOAD_OLDER_THRESHOLD_PX = 80;

/** How long a jumped-to message stays highlighted. */
const JUMP_HIGHLIGHT_MS = 2000;

/** Toast when jump-to cannot bring the message into the loaded history. */
export const JUMP_NOT_LOADED_TOAST = 'Message is older than loaded history';

const NO_MARKS: Map<string, ChatMark> = new Map();

/** Selection-mode state for one row, when selection mode is on. */
export interface RowSelection {
  role: SelectionRole;
  checked: boolean;
  onToggle: () => void;
}

/**
 * Coarse "last seen" label from a timestamp, bucketed minutes/hours/days. Null
 * (no known last-seen) reads as a plain 'Offline'. Computed at render against a
 * supplied now so there is no timer or interval driving the header. Beyond a
 * day it shows the workspace-zone clock time of the last visit.
 */
export function lastSeenLabel(lastTimeMs: number | null, nowMs: number, timeZone: string): string {
  if (lastTimeMs === null) return 'Offline';
  const mins = Math.floor((nowMs - lastTimeMs) / 60000);
  if (mins < 1) return 'last seen just now';
  if (mins < 60) return `last seen ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `last seen ${hours}h ago`;
  return `last seen ${Math.floor(hours / 24)}d ago at ${formatMessageTime(lastTimeMs, timeZone)}`;
}

/**
 * Human label for who is typing, capped so the row never grows: one or two known
 * names are spelled out, otherwise a count or a generic phrase. Returns null
 * when nobody is typing so the indicator renders nothing.
 */
function typingLabel(ids: string[], profiles: Map<string, ChatProfile>): string | null {
  if (ids.length === 0) return null;
  if (ids.length === 1) {
    const name = profiles.get(ids[0] as string)?.displayName;
    return `${name ?? 'Someone'} is typing`;
  }
  if (ids.length === 2) {
    const a = profiles.get(ids[0] as string)?.displayName;
    const b = profiles.get(ids[1] as string)?.displayName;
    return a !== undefined && b !== undefined ? `${a} and ${b} are typing` : '2 people are typing';
  }
  return 'Several people are typing';
}

/**
 * Slim, non-scrolling typing row shown just above the composer. The three dots
 * animate opacity-only via `animate-pulse` with staggered arbitrary delays (no
 * translate/rotate, no custom keyframes), and all colours are design tokens so
 * light and dark are at parity.
 */
function TypingIndicator(props: {
  ids: string[];
  profiles: Map<string, ChatProfile>;
}): ReactElement | null {
  const label = typingLabel(props.ids, props.profiles);
  if (label === null) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 px-4 py-1.5 text-xs text-fg-3">
      <span className="flex items-center gap-1" aria-hidden="true">
        <span className="h-1.5 w-1.5 rounded-full bg-fg-3 animate-pulse [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 rounded-full bg-fg-3 animate-pulse [animation-delay:150ms]" />
        <span className="h-1.5 w-1.5 rounded-full bg-fg-3 animate-pulse [animation-delay:300ms]" />
      </span>
      <span>{label}</span>
    </div>
  );
}

function senderName(message: ThreadMessage, profiles: Map<string, ChatProfile>): string {
  if (message.mine) return 'You';
  const profile = message.senderUserId !== null ? profiles.get(message.senderUserId) : undefined;
  return profile?.displayName ?? 'Unknown';
}

function senderAvatarProps(
  message: ThreadMessage,
  profiles: Map<string, ChatProfile>,
): { src: string } | Record<string, never> {
  const profile = message.senderUserId !== null ? profiles.get(message.senderUserId) : undefined;
  return profile?.avatarUrl != null ? { src: profile.avatarUrl } : {};
}

/**
 * The footer label for a bubble: the server time on the workspace clock once
 * the message is recorded, 'Sending' while the record write is in flight or
 * retrying (shown as a clock, the label is for screen readers), and 'Not sent'
 * once the background retries gave up (the Retry control sits beside it).
 */
export function bubbleTimeLabel(message: ThreadMessage, timeZone: string): string {
  if (message.state === 'sending') return 'Sending';
  if (message.state === 'failed') return 'Not sent';
  return formatMessageTime(message.createdAt, timeZone);
}

/** What the line under an own bubble shows; null renders no line. */
export type BubbleStatus = 'sending' | 'failed' | 'delivered' | 'read';

/**
 * The status line under a bubble: a clock while sending and 'Not sent' once
 * failed (any bubble in the run), else Delivered / Read for own DM messages on
 * the LAST bubble of a run only.
 */
export function bubbleStatus(
  message: Pick<ThreadMessage, 'mine' | 'state' | 'status'>,
  opts: { showTicks: boolean; tail: boolean },
): BubbleStatus | null {
  if (message.state === 'sending') return 'sending';
  if (message.state === 'failed') return 'failed';
  if (!message.mine || !opts.showTicks || !opts.tail) return null;
  return message.status === 'read' ? 'read' : 'delivered';
}

/**
 * The line itself, right-aligned under own bubbles. Token colours only (Read in
 * the accent), so light and dark stay at parity; no animation.
 */
function StatusLine({ status }: { status: BubbleStatus }): ReactElement {
  return (
    <span data-status={status} className="flex items-center gap-1 text-[11px] text-fg-3">
      {status === 'sending' ? (
        <span role="img" aria-label="Sending">
          <IconClock size={12} />
        </span>
      ) : null}
      {status === 'failed' ? <span className="text-bad">Not sent</span> : null}
      {status === 'delivered' ? (
        <>
          <span>Delivered</span>
          <IconTickSingle />
        </>
      ) : null}
      {status === 'read' ? (
        <span className="inline-flex items-center gap-1 text-accent">
          <span>Read</span>
          <IconTickDouble />
        </span>
      ) : null}
    </span>
  );
}

/**
 * The bubble shell: own on the solid accent (the primary Button's fill and ink),
 * peer on panel-2, no border. 18px radius; the 4px tail corner on the sender side
 * only on the last bubble of a run.
 */
export function bubbleClass(state: {
  mine: boolean;
  tail: boolean;
  sending: boolean;
  failed: boolean;
  checked: boolean;
  voiceOnly: boolean;
}): string {
  return cn(
    'relative min-w-0 select-none [-webkit-touch-callout:none] rounded-[18px] px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
    state.voiceOnly && 'min-w-[220px]',
    state.mine ? 'bg-accent text-accent-fg' : 'bg-panel-2 text-fg',
    state.tail && (state.mine ? 'rounded-br-[4px]' : 'rounded-bl-[4px]'),
    state.sending && 'opacity-70',
    state.failed && 'border border-bad',
    state.checked && 'ring-2 ring-accent ring-offset-2 ring-offset-bg',
  );
}

/** Message body text at 15px; the ink comes from the bubble (fg or accent-fg). */
const BODY_TEXT = 'whitespace-pre-wrap [overflow-wrap:anywhere] text-[15px] leading-[1.4]';

/**
 * One message row in the thread. Own messages (`message.mine`) right-align on
 * the solid accent, no avatar and no sender name. Peer messages left-align; in a
 * group the run head carries the avatar + sender name above the bubble, while
 * tucked replies reserve an aligned gutter. No time inside the bubble: the time
 * label sits above a run (ThreadBody) and the status line (sending clock, Not
 * sent, or Delivered / Read on the run's last own DM bubble) sits under it. A
 * failed own send offers a 44px Retry beside the bubble; reactions hang as one
 * small badge over the tail edge. Rows in a run sit 2px apart, runs 10px.
 * Pure and hook-free: long-press wiring is owned by the MessageRow wrapper and
 * passed in via `press`, so the unit test can call this directly. All colours
 * are design tokens, so light and dark stay at parity.
 */
export function MessageBubble(props: {
  message: ThreadMessage;
  profiles: Map<string, ChatProfile>;
  cache: PresignCache;
  presignEnabled: boolean;
  showTicks: boolean;
  isGroup: boolean;
  head: boolean;
  /** Last bubble of its run: tail corner and the Delivered / Read line. */
  tail: boolean;
  timeZone: string;
  onBadgeClick: () => void;
  onRetry?: (messageId: string) => void;
  onJumpToMessage?: (messageId: string) => void;
  /** The message's mark; drives the badge. */
  mark?: ChatMark | undefined;
  /** Opens the priority chooser from an open pending badge. */
  onChangePriority?: () => void;
  /** Present while selection mode is on. */
  selection?: RowSelection;
  bubbleRef?: Ref<HTMLDivElement>;
  press?: {
    handlers: LongPressHandlers;
    onContextMenu: (event: MouseEvent) => void;
    consumeClick: () => boolean;
    /** Keyboard open (Enter / Space / Shift+F10), anchored to the bubble. */
    onKeyOpen: () => void;
    /** Present on hover pointer devices: the ⋯ control, anchored to itself. */
    onMore?: (anchor: DOMRect) => void;
  };
}): ReactElement {
  const { message, profiles, cache, presignEnabled, showTicks, isGroup, head, tail } = props;
  const { onBadgeClick } = props;
  const { bubbleRef, press, timeZone } = props;
  const mine = message.mine;
  const reply = message.reply;
  const name = senderName(message, profiles);
  const showMeta = isGroup && !mine && head;
  const gutter = isGroup && !mine && !head;
  const hasReactions = message.reactions.length > 0;
  const failed = message.state === 'failed';
  const sending = message.state === 'sending';
  const selection = props.selection;
  const voiceOnly = isVoiceOnly(message);
  const textOnly =
    message.body.trim() !== '' &&
    message.attachments.length === 0 &&
    message.sharedPostIds.length === 0 &&
    message.sharedBriefIds.length === 0;
  const totalReactions = message.reactions.reduce((sum, r) => sum + r.count, 0);
  const distinctEmojis = message.reactions.map((r) => r.emoji).join('');
  const status = bubbleStatus(message, { showTicks, tail });
  const onMore = selection === undefined ? press?.onMore : undefined;
  return (
    <li
      data-msg-id={message.id}
      data-state={message.state}
      data-selection={selection?.role}
      className={cn(
        'group flex items-start gap-2 px-4',
        head ? 'pt-2.5' : 'pt-0.5',
        mine ? 'flex-row-reverse' : 'flex-row',
        hasReactions && 'mb-3',
      )}
    >
      {selection?.role === 'selectable' ? (
        <SelectCheckbox checked={selection.checked} onToggle={selection.onToggle} />
      ) : null}
      {selection?.role === 'locked' ? <SelectLock /> : null}
      {showMeta ? <Avatar name={name} {...senderAvatarProps(message, profiles)} size="md" /> : null}
      {gutter ? <span className="w-[26px] shrink-0" aria-hidden="true" /> : null}
      <div className={cn('flex min-w-0 max-w-[76%] flex-col gap-1', mine && 'items-end')}>
        {showMeta ? <span className="text-sm font-medium text-fg">{name}</span> : null}
        <div
          ref={bubbleRef}
          data-bubble=""
          role="group"
          tabIndex={0}
          aria-label={`${mine ? 'Your message' : `Message from ${name}`}, ${bubbleTimeLabel(message, timeZone)}`}
          {...press?.handlers}
          onContextMenu={press?.onContextMenu}
          onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
            if (selection !== undefined || press === undefined || !keyOpensMenu(e)) return;
            e.preventDefault();
            press.onKeyOpen();
          }}
          onClickCapture={(e) => {
            if (selection !== undefined) {
              e.preventDefault();
              e.stopPropagation();
              if (selection.role === 'selectable') selection.onToggle();
              return;
            }
            if (press?.consumeClick()) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          className={bubbleClass({
            mine,
            tail,
            sending,
            failed,
            checked: selection?.checked === true,
            voiceOnly,
          })}
        >
          <MarkBadge
            mark={props.mark}
            {...(props.onChangePriority !== undefined && selection === undefined
              ? { onChangePriority: props.onChangePriority }
              : {})}
          />
          {message.forwarded === true ? <ForwardedLabel mine={mine} /> : null}
          {reply !== null ? (
            <ReplyQuoteBox
              author={
                reply.authorUserId !== null
                  ? (profiles.get(reply.authorUserId)?.displayName ?? 'Member')
                  : 'Member'
              }
              preview={reply.preview}
              onJump={() => props.onJumpToMessage?.(reply.id)}
              className="mb-1"
            />
          ) : null}
          {textOnly ? (
            <p className={BODY_TEXT}>{message.body}</p>
          ) : voiceOnly ? (
            <MessageAttachments
              attachments={message.attachments}
              cache={cache}
              presignEnabled={presignEnabled}
            />
          ) : (
            <>
              {message.body.trim() !== '' ? <p className={BODY_TEXT}>{message.body}</p> : null}
              <MessageAttachments
                attachments={message.attachments}
                cache={cache}
                presignEnabled={presignEnabled}
              />
              <SharedPostCards postIds={message.sharedPostIds} />
              <SharedBriefCards briefIds={message.sharedBriefIds} />
            </>
          )}
          {hasReactions ? (
            <button
              type="button"
              onClick={onBadgeClick}
              className={cn(
                'absolute -bottom-2.5 inline-flex items-center gap-0.5 rounded-full border border-border bg-panel px-1.5 py-0.5 text-xs',
                mine ? 'right-2' : 'left-2',
              )}
            >
              <span aria-hidden="true">{distinctEmojis}</span>
              {totalReactions > 1 ? (
                <span className="text-[11px] text-fg-3">{totalReactions}</span>
              ) : null}
            </button>
          ) : null}
        </div>
        {status !== null ? <StatusLine status={status} /> : null}
      </div>
      {onMore !== undefined ? (
        <button
          type="button"
          data-more=""
          aria-label="Message actions"
          aria-haspopup="menu"
          onClick={(e) => onMore(e.currentTarget.getBoundingClientRect())}
          className="flex h-11 w-11 shrink-0 items-center justify-center self-center rounded-full text-fg-3 opacity-0 hover:bg-panel-2 hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <IconEllipsis size={20} />
        </button>
      ) : null}
      {failed && mine ? (
        <IconButton
          label="Retry sending"
          className="shrink-0 self-center text-bad hover:bg-bad-soft hover:text-bad"
          onClick={() => props.onRetry?.(message.id)}
        >
          <IconRotateCcw size={18} />
        </IconButton>
      ) : null}
    </li>
  );
}

/** The small "Forwarded" line above a forwarded message's body (own and incoming). */
export function ForwardedLabel(props: { mine?: boolean } = {}): ReactElement {
  return (
    <span
      data-forwarded=""
      className={cn(
        'mb-1 flex items-center gap-1 text-xs leading-none',
        props.mine === true ? 'text-accent-fg' : 'text-fg-2',
      )}
    >
      <IconForward size={12} />
      {FORWARDED_LABEL}
    </span>
  );
}

/** One rendered row of the thread list, grouped once before the first paint. */
export type ThreadRow =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'time'; key: string; label: string }
  | { kind: 'message'; message: ThreadMessage; head: boolean; tail: boolean };

/**
 * The thread's render list: day pills, then runs. A run is consecutive messages
 * from one sender with no day pill and no 10-minute gap between neighbours; its
 * first message is the head, its last the tail. A centred time label (workspace
 * clock) goes above a run that starts a new day or follows a 10-minute gap.
 * Pure, so the list is grouped in one pass and never re-groups after painting.
 */
export function threadRows(
  messages: readonly ThreadMessage[],
  nowMs: number,
  timeZone: string,
): ThreadRow[] {
  const items = withDaySeparators(messages, nowMs, timeZone);
  const rows: ThreadRow[] = [];
  items.forEach((item, k) => {
    if (item.kind === 'day') {
      rows.push(item);
      return;
    }
    const { message, index } = item;
    const prev = messages[index - 1];
    const next = messages[index + 1];
    const afterDay = items[k - 1]?.kind === 'day';
    const beforeDay = items[k + 1]?.kind === 'day';
    const head = afterDay || breaksRun(prev, message);
    const tail = next === undefined || beforeDay || breaksRun(message, next);
    if (afterDay || (prev !== undefined && isTimeGap(prev, message))) {
      const label = formatMessageTime(
        message.time > 0 ? message.time : message.createdAt,
        timeZone,
      );
      if (label !== '') rows.push({ kind: 'time', key: `time-${message.id}`, label });
    }
    rows.push({ kind: 'message', message, head, tail });
  });
  return rows;
}

/** The centred run time label: mono, tabular, tertiary. No motion. */
export function TimeLabel({ label }: { label: string }): ReactElement {
  return (
    <li className="flex justify-center pt-2.5">
      <span className="font-mono text-[11px] tabular-nums text-fg-3">{label}</span>
    </li>
  );
}

/**
 * Thin wrapper that owns the long-press / right-click wiring for one bubble and
 * keeps MessageBubble pure. The bubble's rect is captured on open so the floating
 * action menu can anchor to it.
 */
function MessageRow(props: {
  message: ThreadMessage;
  profiles: Map<string, ChatProfile>;
  cache: PresignCache;
  presignEnabled: boolean;
  showTicks: boolean;
  isGroup: boolean;
  head: boolean;
  tail: boolean;
  timeZone: string;
  onOpen: (message: ThreadMessage, rect: DOMRect | null) => void;
  onRetry?: (messageId: string) => void;
  onJumpToMessage?: (messageId: string) => void;
  mark: ChatMark | undefined;
  onChangePriority?: (messageId: string) => void;
  selection?: RowSelection;
  /** Hover pointer device: render the ⋯ control. */
  hoverMenu: boolean;
}): ReactElement {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const selecting = props.selection !== undefined;
  const bubbleRect = (): DOMRect | null => bubbleRef.current?.getBoundingClientRect() ?? null;
  // Mouse holds never open the menu (right-click and ⋯ do); touch is unchanged.
  const { handlers, consumeClickSuppression, cancel, clearClickSuppression } = useLongPress(
    () => open(bubbleRect()),
    { ignoreMouse: true },
  );
  function open(anchor: DOMRect | null): void {
    if (selecting) return;
    // The menu's backdrop takes the trailing pointerup, so no click to swallow.
    clearClickSuppression();
    props.onOpen(props.message, anchor);
  }
  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    cancel();
    open(bubbleRect());
  };
  const onChangePriority = props.onChangePriority;
  return (
    <MessageBubble
      message={props.message}
      profiles={props.profiles}
      cache={props.cache}
      presignEnabled={props.presignEnabled}
      showTicks={props.showTicks}
      isGroup={props.isGroup}
      head={props.head}
      tail={props.tail}
      timeZone={props.timeZone}
      bubbleRef={bubbleRef}
      press={{
        handlers,
        onContextMenu,
        consumeClick: consumeClickSuppression,
        onKeyOpen: () => open(bubbleRect()),
        ...(props.hoverMenu ? { onMore: (anchor: DOMRect) => open(anchor) } : {}),
      }}
      {...(props.onRetry !== undefined ? { onRetry: props.onRetry } : {})}
      {...(props.onJumpToMessage !== undefined ? { onJumpToMessage: props.onJumpToMessage } : {})}
      mark={props.mark}
      {...(onChangePriority !== undefined
        ? { onChangePriority: () => onChangePriority(props.message.id) }
        : {})}
      {...(props.selection !== undefined ? { selection: props.selection } : {})}
      onBadgeClick={() => props.onOpen(props.message, bubbleRect())}
    />
  );
}

function ThreadBody(
  props: Pick<
    MessageThreadProps,
    | 'title'
    | 'messages'
    | 'loading'
    | 'loadingOlder'
    | 'hasMore'
    | 'onLoadOlder'
    | 'onNewestVisible'
    | 'profiles'
    | 'onToggleReaction'
    | 'onRetry'
    | 'timeZone'
  > & {
    cache: PresignCache;
    presignEnabled: boolean;
    showTicks: boolean;
    isGroup: boolean;
    onReply: (message: ThreadMessage) => void;
    marks: Map<string, ChatMark>;
    /** Present while selection mode is on. */
    selection?: { selected: ReadonlySet<string>; onToggle: (id: string) => void };
    /** Menu "Mark as ..." picked; absent hides mark actions. */
    onMark?: (message: ThreadMessage, type: MarkType) => void;
    /** Menu "Select" picked; absent hides it. */
    onStartSelect?: (message: ThreadMessage) => void;
    /** Menu "Forward" picked; absent hides it. */
    onForwardMessage?: (message: ThreadMessage) => void;
    onChangePriority?: (messageId: string) => void;
    /** A jump-to request (seq makes a repeat of the same id fire again). */
    jumpRequest: { id: string; seq: number } | null;
    onEnsureLoaded?: (messageId: string) => Promise<FindOlderOutcome>;
  },
): ReactElement {
  const { onNewestVisible, jumpRequest } = props;
  const [menu, setMenu] = useState<{ message: ThreadMessage; rect: DOMRect | null } | null>(null);
  const hoverMenu = useMediaQuery(HOVER_POINTER_QUERY);
  const toast = useToast();
  const listRef = useRef<HTMLUListElement>(null);
  // Tracks whether we have already snapped a freshly opened conversation to the
  // latest message, and whether the reader is currently parked at the bottom.
  const didInitialScrollRef = useRef(false);
  const atBottomRef = useRef(true);
  // The scroll height before an older page was requested, so the prepended rows
  // do not move what the reader was looking at.
  const anchorHeightRef = useRef<number | null>(null);
  const newestIdRef = useRef<string | null>(null);
  // A jump target waiting for its older page to render.
  const pendingJumpRef = useRef<string | null>(null);
  const ensureLoadedRef = useRef(props.onEnsureLoaded);
  ensureLoadedRef.current = props.onEnsureLoaded;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  /** Scroll a loaded message into view and ring it; false when it is not rendered. */
  const reveal = useCallback((id: string, highlightMs: number): boolean => {
    const el = listRef.current?.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
    if (el == null) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const flash = el.querySelector('[data-bubble]') ?? el;
    const ring = ['ring-2', 'ring-accent', 'ring-inset'];
    flash.classList.add(...ring);
    window.setTimeout(() => flash.classList.remove(...ring), highlightMs);
    return true;
  }, []);
  // Jump-to: reveal at once when loaded, else page older history (capped) and
  // reveal once the page carrying it renders.
  useEffect(() => {
    if (jumpRequest === null) return;
    const id = jumpRequest.id;
    if (reveal(id, JUMP_HIGHLIGHT_MS)) return;
    const ensure = ensureLoadedRef.current;
    if (ensure === undefined) {
      toastRef.current.show({ title: JUMP_NOT_LOADED_TOAST });
      return;
    }
    pendingJumpRef.current = id;
    atBottomRef.current = false;
    void ensure(id).then((outcome) => {
      if (pendingJumpRef.current !== id) return;
      if (outcome !== 'found') {
        pendingJumpRef.current = null;
        toastRef.current.show({
          title: outcome === 'error' ? 'Could not load older messages' : JUMP_NOT_LOADED_TOAST,
        });
        return;
      }
      if (reveal(id, JUMP_HIGHLIGHT_MS)) pendingJumpRef.current = null;
    });
  }, [jumpRequest, reveal]);
  // Reset on conversation switch so a fresh thread always lands at the latest
  // message even if the previous one was scrolled up. `title` is the only
  // per-conversation identifier reaching this component. Declared BEFORE the
  // messages effect so the reset commits first on a switch.
  useLayoutEffect(() => {
    didInitialScrollRef.current = false;
    atBottomRef.current = true;
    anchorHeightRef.current = null;
    newestIdRef.current = null;
  }, [props.title]);
  // Keep the latest message in view: instant pre-paint snap on first load (no
  // top-flash), then a smooth follow for own sends or when already at bottom.
  // After an older page is prepended, restore the reader's position instead.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el === null || props.messages.length === 0) return;
    if (pendingJumpRef.current !== null) {
      // A jump owns the scroll position while its pages land.
      anchorHeightRef.current = null;
      if (reveal(pendingJumpRef.current, JUMP_HIGHLIGHT_MS)) pendingJumpRef.current = null;
      return;
    }
    if (anchorHeightRef.current !== null) {
      el.scrollTop += el.scrollHeight - anchorHeightRef.current;
      anchorHeightRef.current = null;
      return;
    }
    const last = props.messages[props.messages.length - 1];
    if (!didInitialScrollRef.current) {
      el.scrollTop = el.scrollHeight;
      didInitialScrollRef.current = true;
    } else if (last !== undefined && (last.mine || atBottomRef.current)) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
    if (last !== undefined && atBottomRef.current && newestIdRef.current !== last.id) {
      newestIdRef.current = last.id;
      onNewestVisible?.();
    }
  }, [props.messages, onNewestVisible, reveal]);
  const scrollToMessage = (id: string): void => {
    const el = listRef.current?.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
    if (el == null) {
      toast.show({ title: 'That message is not loaded here' });
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const flash = el.querySelector('[data-bubble]') ?? el;
    const ring = ['ring-2', 'ring-accent', 'ring-inset'];
    flash.classList.add(...ring);
    window.setTimeout(() => flash.classList.remove(...ring), 1200);
  };
  if (props.loading) return threadSkeleton();
  if (props.messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col justify-center">
        <EmptyState
          icon={<IconChat size={22} />}
          title="No messages yet"
          description="Say hello."
        />
      </div>
    );
  }
  const nowMs = Date.now();
  return (
    <>
      <ul
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const wasAtBottom = atBottomRef.current;
          atBottomRef.current = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
          if (atBottomRef.current && !wasAtBottom) {
            const last = props.messages[props.messages.length - 1];
            if (last !== undefined && newestIdRef.current !== last.id) {
              newestIdRef.current = last.id;
              props.onNewestVisible?.();
            }
          }
          if (
            el.scrollTop <= LOAD_OLDER_THRESHOLD_PX &&
            props.hasMore === true &&
            props.loadingOlder !== true &&
            anchorHeightRef.current === null
          ) {
            anchorHeightRef.current = el.scrollHeight;
            props.onLoadOlder?.();
          }
        }}
        className="flex-1 overflow-y-auto py-2"
      >
        {props.loadingOlder === true ? (
          <li className="px-4 py-2 text-center text-xs text-fg-3">Loading earlier messages</li>
        ) : null}
        {threadRows(props.messages, nowMs, props.timeZone).map((row) => {
          if (row.kind === 'day') return <DayPill key={row.key} label={row.label} />;
          if (row.kind === 'time') return <TimeLabel key={row.key} label={row.label} />;
          const { message } = row;
          return (
            <MessageRow
              key={message.id}
              message={message}
              profiles={props.profiles}
              cache={props.cache}
              presignEnabled={props.presignEnabled}
              showTicks={props.showTicks}
              isGroup={props.isGroup}
              head={row.head}
              tail={row.tail}
              timeZone={props.timeZone}
              onOpen={(m, rect) => setMenu({ message: m, rect })}
              hoverMenu={hoverMenu}
              onJumpToMessage={scrollToMessage}
              mark={props.marks.get(message.id)}
              {...(props.onChangePriority !== undefined
                ? { onChangePriority: props.onChangePriority }
                : {})}
              {...(props.selection !== undefined
                ? {
                    selection: rowSelection(message, props.selection),
                  }
                : {})}
              {...(props.onRetry !== undefined ? { onRetry: props.onRetry } : {})}
            />
          );
        })}
      </ul>
      <MessageActionMenu
        open={menu !== null}
        onClose={() => setMenu(null)}
        anchor={menu?.rect ?? null}
        mine={menu?.message.mine ?? false}
        currentReaction={menu ? (menu.message.reactions.find((r) => r.mine)?.emoji ?? null) : null}
        canCopy={menu ? menu.message.body.trim() !== '' : false}
        markOptions={
          menu && props.onMark !== undefined
            ? markMenuOptions(menu.message, props.marks.get(menu.message.id))
            : []
        }
        onMark={(type) => {
          if (menu) props.onMark?.(menu.message, type);
        }}
        canForward={
          menu !== null && props.onForwardMessage !== undefined && canForward(menu.message)
        }
        onForward={() => {
          if (menu) props.onForwardMessage?.(menu.message);
        }}
        canSelect={props.onStartSelect !== undefined}
        onSelect={() => {
          if (menu) props.onStartSelect?.(menu.message);
        }}
        onReact={(emoji) => {
          if (menu && menu.message.state === 'sent')
            props.onToggleReaction?.(
              menu.message.id,
              emoji,
              menu.message.reactions.find((r) => r.mine)?.emoji === emoji,
            );
        }}
        onReply={() => {
          if (menu) props.onReply(menu.message);
        }}
        onCopy={() => {
          if (menu) {
            void navigator.clipboard?.writeText(menu.message.body);
            toast.show({ title: 'Message copied' });
          }
        }}
      />
    </>
  );
}

/** One day pill between messages ("Today", "Yesterday", "D MMM"). No motion. */
export function DayPill({ label }: { label: string }): ReactElement {
  return (
    <li role="separator" aria-label={label} className="flex justify-center">
      <span className="self-center my-2 rounded-full border border-border bg-panel-2 px-2.5 py-0.5 text-[11px] font-medium text-fg-3">
        {label}
      </span>
    </li>
  );
}

/** Placeholder bubble widths for the loading thread, alternating sides. */
export const THREAD_SKELETON_WIDTHS = ['w-[55%]', 'w-[40%]', 'w-[70%]', 'w-[45%]', 'w-[60%]'];

/** The loading thread: five alternating pulse bubbles, no text, never the empty state. */
export function threadSkeleton(): ReactElement {
  return (
    <ul
      aria-busy="true"
      aria-label="Loading messages"
      className="flex flex-1 flex-col gap-3 overflow-hidden px-4 py-4"
    >
      {THREAD_SKELETON_WIDTHS.map((width, i) => (
        <li
          key={width}
          data-skeleton-bubble=""
          className={cn(
            'h-10 animate-pulse rounded-[14px] bg-panel-2',
            width,
            i % 2 === 1 && 'self-end',
          )}
        />
      ))}
    </ul>
  );
}

/** Selection-mode state for one row: any recorded message can be checked. */
function rowSelection(
  message: ThreadMessage,
  selection: { selected: ReadonlySet<string>; onToggle: (id: string) => void },
): RowSelection {
  return {
    role: threadSelectable(message) ? 'selectable' : 'none',
    checked: selection.selected.has(message.id),
    onToggle: () => selection.onToggle(message.id),
  };
}

/** The thread pane: header (+ optional back), message list, and composer. */
export function MessageThread(props: MessageThreadProps): ReactElement {
  const { canAttach, presignEnabled, presignCache, uploadFile, transcribe, canTranscribe } =
    useChatAttachments();
  const [replyDraft, setReplyDraft] = useState<{ authorName: string; quote: ReplyQuote } | null>(
    null,
  );
  const toast = useToast();
  const marks = props.marks ?? NO_MARKS;
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marksOpen, setMarksOpen] = useState(false);
  const [priorityFor, setPriorityFor] = useState<{
    messageId: string;
    mode: 'mark' | 'change';
  } | null>(null);
  const [priorityBusy, setPriorityBusy] = useState(false);
  const [jumpRequest, setJumpRequest] = useState<{ id: string; seq: number } | null>(null);
  const [forwardFor, setForwardFor] = useState<ThreadMessage[] | null>(null);

  // A conversation switch leaves selection mode and closes the marks surfaces.
  useEffect(() => {
    setSelecting(false);
    setSelected(new Set());
    setMarksOpen(false);
    setPriorityFor(null);
    setJumpRequest(null);
    setForwardFor(null);
  }, [props.title]);

  // A delete or a new mark landing meanwhile drops ids that are no longer selectable.
  useEffect(() => {
    setSelected((prev) => {
      const next = pruneThreadSelection(prev, props.messages);
      return next.size === prev.size ? prev : next;
    });
  }, [props.messages]);

  const messagesById = useMemo(
    () => new Map(props.messages.map((m) => [m.id, m])),
    [props.messages],
  );
  const markedMessages = props.markedMessages;
  const messageFor = useCallback(
    (id: string): ThreadMessage | undefined => messagesById.get(id) ?? markedMessages?.get(id),
    [messagesById, markedMessages],
  );

  const onSetMark = props.onSetMark;
  const applyMark = async (
    messageId: string,
    type: MarkType,
    priority: MarkPriority,
  ): Promise<void> => {
    if (onSetMark === undefined) return;
    const result = await onSetMark(messageId, type, priority);
    if (!result.ok) toast.show({ title: result.message });
  };

  const onDeleteMessages = props.onDeleteMessages;
  const onForward = props.onForward;
  const forwardChannels = props.forwardChannels;
  const canForwardHere = onForward !== undefined && forwardChannels !== undefined;
  const exitSelection = (): void => {
    setSelecting(false);
    setSelected(new Set());
  };
  const handleReply = (message: ThreadMessage): void => {
    const preview = replyPreview(message);
    setReplyDraft({
      authorName: senderName(message, props.profiles),
      quote: { id: message.id, authorUserId: message.senderUserId, preview },
    });
  };
  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border bg-panel px-2 md:px-4">
        {props.onBack !== undefined ? (
          <IconButton label="Back to conversations" onClick={props.onBack}>
            <IconChevronLeft size={20} />
          </IconButton>
        ) : null}
        {props.isGroup === true ? (
          <span
            aria-hidden="true"
            className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-panel-3 text-fg-2"
          >
            <IconUsers size={14} />
          </span>
        ) : (
          <Avatar
            name={props.title}
            size="row"
            {...(props.avatarUrl != null ? { src: props.avatarUrl } : {})}
            presence={
              props.presence !== undefined && props.presence.available && props.presence.online
                ? 'online'
                : undefined
            }
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="block truncate text-[15px] font-semibold leading-tight text-fg">
            {props.title}
          </span>
          {props.subtitle !== undefined ? (
            <span className="truncate text-xs text-fg-3">{props.subtitle}</span>
          ) : props.presence !== undefined && props.presence.available ? (
            <span className="truncate text-xs text-fg-3">
              {props.presence.online
                ? 'Online'
                : lastSeenLabel(props.presence.lastTimeMs, Date.now(), props.timeZone)}
            </span>
          ) : null}
        </div>
        {props.onOpenInfo !== undefined ? (
          <IconButton label="Group info" onClick={props.onOpenInfo}>
            <IconSettings size={20} />
          </IconButton>
        ) : null}
      </div>
      {props.marks !== undefined && !selecting ? (
        <MarkStrip marks={marks} onOpen={() => setMarksOpen(true)} />
      ) : null}
      <ThreadBody
        title={props.title}
        marks={marks}
        jumpRequest={jumpRequest}
        {...(props.onEnsureLoaded !== undefined ? { onEnsureLoaded: props.onEnsureLoaded } : {})}
        {...(onSetMark !== undefined && !selecting
          ? {
              onMark: (message: ThreadMessage, type: MarkType) => {
                if (type === 'pending') {
                  setPriorityFor({ messageId: message.id, mode: 'mark' });
                  return;
                }
                void applyMark(message.id, type, null);
              },
              onChangePriority: (messageId: string) =>
                setPriorityFor({ messageId, mode: 'change' }),
            }
          : {})}
        {...(onDeleteMessages !== undefined && !selecting
          ? {
              onStartSelect: (message: ThreadMessage) => {
                setSelecting(true);
                setSelected(threadSelectable(message) ? new Set([message.id]) : new Set());
              },
            }
          : {})}
        {...(canForwardHere && !selecting
          ? { onForwardMessage: (message: ThreadMessage) => setForwardFor([message]) }
          : {})}
        {...(selecting
          ? {
              selection: {
                selected,
                onToggle: (id: string) => setSelected((prev) => toggleSelected(prev, id)),
              },
            }
          : {})}
        messages={props.messages}
        loading={props.loading}
        profiles={props.profiles}
        cache={presignCache}
        presignEnabled={presignEnabled}
        showTicks={props.showTicks ?? false}
        isGroup={props.isGroup ?? false}
        timeZone={props.timeZone}
        onReply={handleReply}
        {...(props.loadingOlder !== undefined ? { loadingOlder: props.loadingOlder } : {})}
        {...(props.hasMore !== undefined ? { hasMore: props.hasMore } : {})}
        {...(props.onLoadOlder !== undefined ? { onLoadOlder: props.onLoadOlder } : {})}
        {...(props.onNewestVisible !== undefined ? { onNewestVisible: props.onNewestVisible } : {})}
        {...(props.onRetry !== undefined ? { onRetry: props.onRetry } : {})}
        {...(props.onToggleReaction !== undefined
          ? { onToggleReaction: props.onToggleReaction }
          : {})}
      />
      <TypingIndicator ids={props.typingUserIds} profiles={props.profiles} />
      {selecting && onDeleteMessages !== undefined ? (
        <SelectionBar
          count={selected.size}
          canDelete={canDeleteSelection(selected, props.messages, marks)}
          {...(canForwardHere
            ? { onForward: () => setForwardFor(selectedForForward(selected, props.messages)) }
            : {})}
          onCancel={exitSelection}
          onDelete={async () => {
            const result = await onDeleteMessages([...selected]);
            if (result.ok) exitSelection();
            return result;
          }}
        />
      ) : (
        <Composer
          onSend={props.onSend}
          disabled={!props.canSend}
          onTyping={props.onTyping}
          onCancelReply={() => setReplyDraft(null)}
          {...(replyDraft !== null ? { reply: replyDraft } : {})}
          {...(canAttach ? { uploadFile } : {})}
          {...(canTranscribe ? { transcribe } : {})}
        />
      )}
      {props.marks !== undefined &&
      props.onResolveMark !== undefined &&
      props.onReopenMark !== undefined ? (
        <MarksSheet
          open={marksOpen}
          onClose={() => setMarksOpen(false)}
          marks={marks}
          messageFor={messageFor}
          profiles={props.profiles}
          currentUserId={props.currentUserId ?? ''}
          timeZone={props.timeZone}
          onJump={(id) => {
            setMarksOpen(false);
            setJumpRequest((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 }));
          }}
          onResolve={props.onResolveMark}
          onReopen={props.onReopenMark}
        />
      ) : null}
      {onForward !== undefined && forwardChannels !== undefined ? (
        <ForwardPicker
          open={forwardFor !== null && forwardFor.length > 0}
          onClose={() => setForwardFor(null)}
          channels={forwardChannels}
          onSend={(targets) =>
            // A source deleted while the picker was open is no longer forwardable.
            onForward(
              (forwardFor ?? []).filter((m) => messagesById.has(m.id)),
              targets,
            )
          }
          onSent={() => {
            setForwardFor(null);
            exitSelection();
          }}
        />
      ) : null}
      <PrioritySheet
        open={priorityFor !== null}
        title={priorityFor?.mode === 'change' ? 'Change priority' : 'Mark as Pending'}
        current={
          priorityFor?.mode === 'change' ? marks.get(priorityFor.messageId)?.priority : undefined
        }
        busy={priorityBusy}
        onClose={() => setPriorityFor(null)}
        onChoose={(priority) => {
          const target = priorityFor;
          if (target === null) return;
          setPriorityBusy(true);
          void applyMark(target.messageId, 'pending', priority).finally(() => {
            setPriorityBusy(false);
            setPriorityFor(null);
          });
        }}
      />
    </div>
  );
}
