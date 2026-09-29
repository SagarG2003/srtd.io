import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type Ref,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { isNearBottom } from '@/lib/chat/scroll';
import {
  APP_ENTITY_ROUTES,
  classify,
  currentOrigin,
  displayUrl,
  tokenize,
} from '@/lib/chat/message-links';
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
  IconTrash,
  IconUsers,
} from '@/components/ui/icons';
import { useLongPress } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/use-media-query';
import type { ChannelSummary, ChatProfile } from '@/lib/chat-reads';
import { breaksRun, isTimeGap, replyPreview, type ThreadMessage } from '@/lib/chat/thread';
import { classifyAttachment, splitAlbum, type ReplyQuote } from '@/lib/chat/attachments';
import { useChatAttachments } from '@/lib/chat/use-chat-attachments';
import { formatMessageTime } from '@/lib/chat/time-format';
import {
  createSwipeReplyController,
  SWIPE_SPRING_MS,
  type SwipeFrame,
  type SwipeReplyController,
} from '@/lib/chat/swipe-reply';
import type { PresignCache } from '@/lib/asset-presign';
import { roleLabel } from '@/components/pages/settings/members-data';
import { Composer, type ComposerSend } from '@/components/chat/Composer';
import { MessageAttachments } from '@/components/chat/MessageAttachments';
import {
  ImageLightbox,
  type LightboxDetails,
  type LightboxImage,
} from '@/components/ui/ImageLightbox';
import { SharedPostCards } from '@/components/chat/PostCard';
import {
  PostRefChip,
  postRefKey,
  useChipBatch,
  type PostRefPost,
} from '@/components/chat/PostRefChip';
import { FilterStrip } from '@/components/chat/FilterStrip';
import { MessageActionMenu } from '@/components/chat/MessageActionMenu';
import { SharedBriefCards } from '@/components/chat/BriefCard';
import { MarkBadge, SelectCheckbox, SelectLock } from '@/components/chat/MarkBits';
import { MarkStrip, MarksSheet, PrioritySheet } from '@/components/chat/MarksSheet';
import { useOpenPosts } from '@/lib/chat/use-open-posts';
import { useViewerSide } from '@/lib/chat/viewer-role';
import { ContactSheet } from '@/components/chat/ContactSheet';
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
  openPostsHeading,
  toggleSelected,
  type ChatMark,
  type FindOlderOutcome,
  type MarkPriority,
  type MarkType,
  type SelectionRole,
} from '@/lib/chat/marks';
import type { WriteResult } from '@/lib/chat/record';
import {
  aboutState,
  admitRows,
  chipPostIds,
  chipTargetFor,
  createCardExpectation,
  filterRows,
  holdingFirstPage,
  hydrationDeadline,
  newestCardFor,
  parentIndexOf,
  replyForSend,
  rowReady,
  type PageGate,
} from '@/lib/chat/post-refs';
import { useWorkspace } from '@/lib/workspace-context';

interface MessageThreadProps {
  title: string;
  /** The open channel; a DM's header opens the Contact sheet over its reads. */
  channelId?: string;
  /** Header avatar src (the DM peer's); absent or null falls back to initials. */
  avatarUrl?: string | null;
  /** The workspace name, the tail of a DM header's resting second line. */
  subtitle?: string;
  /** The DM peer's raw workspace role; labelled via roleLabel, null when unknown. */
  role?: string | null;
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
  /**
   * Re-run a failed send with the same message id; on a send whose files were
   * lost to a reload it is the Remove (the thread drops the entry).
   */
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

/** Users who asked for less motion: the swipe resets without a spring. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Pointer handlers on a bubble: the long-press and swipe-to-reply controllers, composed. */
export interface BubblePointerHandlers {
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

/**
 * The swipe-to-reply icon: sits behind the bubble's resting left edge and is
 * revealed as the bubble slides right. 32px circle, panel-3 idle, accent when
 * armed (data-armed). Scale and opacity are painted per frame by MessageRow;
 * at rest the classes hold it at scale 0.6, opacity 0. No other motion.
 */
export function SwipeReplyIcon(props: {
  iconRef?: Ref<HTMLSpanElement> | undefined;
}): ReactElement {
  return (
    <span
      ref={props.iconRef}
      aria-hidden="true"
      data-swipe-icon=""
      className="pointer-events-none absolute inset-y-0 left-0 my-auto flex h-8 w-8 scale-[.6] items-center justify-center rounded-full bg-panel-3 text-fg-2 opacity-0 transition-[transform,opacity] duration-[120ms] motion-reduce:transition-none data-[armed]:bg-accent data-[armed]:text-accent-fg"
    >
      <svg
        width={18}
        height={18}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M9 7L4 12l5 5" />
        <path d="M4 12h11a5 5 0 0 1 5 5v1" />
      </svg>
    </span>
  );
}

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

/**
 * What sits under the thread header: the filter strip while one post's
 * conversation is shown, else the open-loops strip (threads with marks, not
 * while selecting), else nothing.
 */
export function threadStripSlot(input: {
  filtering: boolean;
  hasMarks: boolean;
  selecting: boolean;
}): 'filter' | 'loops' | null {
  if (input.filtering) return 'filter';
  return input.hasMarks && !input.selecting ? 'loops' : null;
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

/** The message carries at least one image: its bubble renders the album layout. */
export function hasAlbum(message: Pick<ThreadMessage, 'attachments'>): boolean {
  return message.attachments.some((a) => classifyAttachment(a.mime) === 'image');
}

/**
 * What the thread's one image viewer shows for a message: its album images (a
 * local preview stands in for an own instant send still uploading), plus the
 * bottom bar's sender and HH:mm on the workspace clock. Pure.
 */
export function threadLightbox(
  message: ThreadMessage,
  profiles: Map<string, ChatProfile>,
  timeZone: string,
): { images: LightboxImage[]; details: LightboxDetails } {
  const images = splitAlbum(message.attachments).images.map((a) => {
    const src = a.local?.previewUrl;
    return { assetId: a.assetId, name: a.name, ...(src != null ? { src } : {}) };
  });
  return {
    images,
    details: {
      sender: senderName(message, profiles),
      time: formatMessageTime(messageTimeSource(message), timeZone),
    },
  };
}

/**
 * A bubble's KEY chip when its reply target is a card message and the post is
 * in the thread's batch. A reply without a chip keeps its quote: a plain
 * parent, a post the viewer cannot see, or (a live row only; page rows wait
 * for their chips) a post still being read.
 */
export type BubbleChip = {
  kind: 'chip';
  post: PostRefPost;
  workspaceKey: string | null;
  onTap: () => void;
};

/** What a bubble's cards and chip hand back to the thread. */
export interface BubblePostRefs {
  chip?: BubbleChip | undefined;
  /** Hold on a card or the sheet's "Talk about". */
  onTalkAbout?: ((postId: string, messageId: string) => void) | undefined;
  /** Tap on a card's KEY: show only that post's conversation. */
  onShowPost?: ((postId: string) => void) | undefined;
}

/** The chip for a message, from its target and the batch lookup; undefined keeps the quote. */
export function bubbleChip(
  target: { postId: string; cardMessageId?: string } | null,
  post: PostRefPost | null | undefined,
  context: {
    workspaceKey: string | null;
    onShowPost: (postId: string, cardMessageId?: string) => void;
  },
): BubbleChip | undefined {
  if (target === null || post == null) return undefined;
  return {
    kind: 'chip',
    post,
    workspaceKey: context.workspaceKey,
    onTap: () => context.onShowPost(target.postId, target.cardMessageId),
  };
}

/** Toast when the About post turns out not to be readable here. */
export const ABOUT_UNAVAILABLE_TOAST = 'That post is not available here';

/** Toast when a chip's card cannot be brought into the loaded history. */
export const CARD_NOT_LOADED_TOAST = "That post's card is not loaded here";

/** Toast when a share cannot be sent (no open conversation). */
export const SHARE_UNAVAILABLE_TOAST = 'Could not share right now';

/** The filtered thread's empty line: nothing about the post is loaded yet. */
export function filterEmptyLabel(refLabel: string | null): string {
  return `No messages about ${refLabel ?? 'this post'} loaded yet`;
}

/**
 * The About reply a send may carry: only while the About bar shows its post.
 * Pending (the read is in flight) or gone (RLS, failed read) carries none.
 */
export function aboutReplyFor(
  about: { cardMessageId: string } | null,
  post: PostRefPost | null | undefined,
  card: ThreadMessage | undefined,
): ReplyQuote | null {
  return aboutState(post) === 'visible' ? aboutQuote(about, card) : null;
}

/**
 * Enter one post's conversation. With a card for it loaded, at once (About on
 * its newest card). Otherwise the chip's card is paged in first; only when it
 * is found does the filter apply (About on that card); else a toast, no filter.
 */
export async function openPostFilter(input: {
  postId: string;
  cardMessageId: string | undefined;
  rows: readonly ThreadMessage[];
  ensureLoaded: ((messageId: string) => Promise<FindOlderOutcome>) | undefined;
  apply: (postId: string, cardMessageId: string | null) => void;
  toast: (title: string) => void;
}): Promise<void> {
  const card = newestCardFor(input.rows, input.postId);
  if (card !== null) {
    input.apply(input.postId, card.id);
    return;
  }
  if (input.cardMessageId === undefined || input.ensureLoaded === undefined) {
    input.toast(CARD_NOT_LOADED_TOAST);
    return;
  }
  const outcome = await input.ensureLoaded(input.cardMessageId);
  if (outcome === 'found') input.apply(input.postId, input.cardMessageId);
  else input.toast(CARD_NOT_LOADED_TOAST);
}

/**
 * The reply quote the About card stands for in a send: the card message's
 * sender and preview when it is loaded, else a generic card label.
 */
export function aboutQuote(
  about: { cardMessageId: string } | null,
  card: ThreadMessage | undefined,
): ReplyQuote | null {
  if (about === null) return null;
  return {
    id: about.cardMessageId,
    authorUserId: card?.senderUserId ?? null,
    preview: card !== undefined ? replyPreview(card) : 'Shared post',
  };
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

/** A DM header's second line while the peer is typing. */
export const HEADER_TYPING = 'typing…';

/**
 * The DM header's second line, in priority order: 'typing…' while the peer
 * types, else "<role label> · <workspace>" (the workspace alone when the role is
 * unknown). Online shows as the dot on the header photo, not as text. Without a
 * workspace name it falls back to the role alone, then (offline only) the
 * last-seen line. Groups keep no second line.
 */
export function dmHeaderLine(input: {
  isGroup: boolean;
  peerTyping: boolean;
  presence: { online: boolean; lastTimeMs: number | null; available: boolean } | undefined;
  role: string | null;
  workspaceName: string | undefined;
  timeZone: string;
  nowMs?: number;
}): string | null {
  if (input.isGroup) return null;
  if (input.peerTyping) return HEADER_TYPING;
  const presence = input.presence?.available === true ? input.presence : undefined;
  const role = input.role !== null ? roleLabel(input.role) : null;
  if (input.workspaceName !== undefined) {
    return role !== null ? `${role} · ${input.workspaceName}` : input.workspaceName;
  }
  if (role !== null) return role;
  if (presence !== undefined && !presence.online) {
    return lastSeenLabel(presence.lastTimeMs, input.nowMs ?? Date.now(), input.timeZone);
  }
  return null;
}

/**
 * The DM header photo's presence: 'online' draws the 10px good dot (panel ring)
 * at its bottom-right while the peer is present and presence is known.
 */
export function headerAvatarPresence(
  presence: { online: boolean; available: boolean } | undefined,
): 'online' | undefined {
  return presence !== undefined && presence.available && presence.online ? 'online' : undefined;
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

/**
 * The header's photo and name block. In a DM with `onOpenContact` it is one
 * 44px-tall button spanning both that opens the Contact sheet; groups (and a
 * DM without the handler) keep the plain block. Hook-free.
 */
export function ThreadHeaderIdentity(props: {
  isGroup: boolean;
  title: string;
  avatarUrl: string | null;
  presence: 'online' | undefined;
  headerLine: string | null;
  onOpenContact?: () => void;
}): ReactElement {
  const photo = props.isGroup ? (
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
      {...(props.avatarUrl !== null ? { src: props.avatarUrl } : {})}
      presence={props.presence}
    />
  );
  const text = (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
      <span className="block truncate text-[15px] font-semibold leading-tight text-fg">
        {props.title}
      </span>
      {props.headerLine !== null ? (
        <span data-header-line="" className="truncate text-xs text-fg-3">
          {props.headerLine}
        </span>
      ) : null}
    </span>
  );
  if (!props.isGroup && props.onOpenContact !== undefined) {
    return (
      <button
        type="button"
        data-contact-open=""
        aria-label={`Contact info for ${props.title}`}
        onClick={props.onOpenContact}
        className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {photo}
        {text}
      </button>
    );
  }
  return (
    <>
      {photo}
      {text}
    </>
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
 * The one timestamp a message's time label and aria-label both read: the server
 * createdAt, or the Agora time only while createdAt is absent (provisional).
 */
export function messageTimeSource(
  message: Pick<ThreadMessage, 'createdAt' | 'time'>,
): string | number {
  return message.createdAt !== '' ? message.createdAt : message.time;
}

/**
 * The footer label for a bubble: the server time on the workspace clock once
 * the message is recorded, 'Sending' while the record write is in flight or
 * retrying (shown as a clock, the label is for screen readers), and 'Not sent'
 * once the background retries gave up (the Retry control sits beside it).
 */
export function bubbleTimeLabel(message: ThreadMessage, timeZone: string): string {
  if (message.state === 'sending') return 'Sending';
  if (message.state === 'failed') return message.filesMissing === true ? FILES_MISSING : 'Not sent';
  return formatMessageTime(messageTimeSource(message), timeZone);
}

/** The status of a send whose picked files did not survive a reload. */
export const FILES_MISSING = 'Photos not sent';

/** What the line under an own bubble shows; null renders no line. */
export type BubbleStatus = 'sending' | 'failed' | 'files-missing' | 'delivered' | 'read';

/**
 * The status line under a bubble: a clock while sending and 'Not sent' once
 * failed (any bubble in the run), else Delivered / Read for own DM messages on
 * the LAST bubble of a run only.
 */
export function bubbleStatus(
  message: Pick<ThreadMessage, 'mine' | 'state' | 'status' | 'filesMissing'>,
  opts: { showTicks: boolean; tail: boolean },
): BubbleStatus | null {
  if (message.state === 'sending') return 'sending';
  if (message.state === 'failed') return message.filesMissing === true ? 'files-missing' : 'failed';
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
      {status === 'files-missing' ? <span className="text-bad">{FILES_MISSING}</span> : null}
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
 * The bubble shell: own on the bubble-own fill (the accent in light, a deeper
 * accent in dark so accent-fg ink clears 4.5:1), peer on panel-2, no border.
 * 18px radius; the 4px tail corner on the sender side only on the last bubble
 * of a run.
 */
export function bubbleClass(state: {
  mine: boolean;
  tail: boolean;
  sending: boolean;
  failed: boolean;
  checked: boolean;
  voiceOnly: boolean;
  /** Image album: 3px padding around the album, at least 240px wide. */
  album?: boolean;
}): string {
  return cn(
    'relative min-w-0 select-none [-webkit-touch-callout:none] rounded-[18px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
    state.album === true ? 'min-w-[240px] p-[3px]' : 'px-3 py-2',
    state.voiceOnly && 'min-w-[220px]',
    state.mine ? 'bg-bubble-own text-accent-fg' : 'bg-panel-2 text-fg',
    state.tail && (state.mine ? 'rounded-br-[4px]' : 'rounded-bl-[4px]'),
    state.sending && 'opacity-70',
    state.failed && 'border border-bad',
    state.checked && 'ring-2 ring-accent ring-offset-2 ring-offset-bg',
  );
}

/**
 * Own-bubble inner content (reply quote, file chips, shared cards, voice note)
 * restyled for the solid fill without touching the shared child components:
 * ink goes accent-fg (secondary at opacity-80), surfaces a white/16 overlay,
 * the quote rule and played waveform white/70, icons follow currentColor. White
 * is accent-fg's value in both themes. Peer bubbles never get this class.
 */
export const OWN_BUBBLE_CONTENT = cn(
  '[&_.bg-panel]:bg-white/[.16] [&_.bg-panel-3]:bg-white/[.16] [&_.border-border]:border-white/[.16]',
  '[&_button:hover]:bg-white/[.24] [&_a:hover>span]:bg-white/[.24]',
  '[&_.bg-accent]:bg-white/70 [&_.bg-accent.text-accent-fg]:bg-white/[.16] [&_.bg-fg-3]:bg-white/40',
  '[&_.text-fg]:text-accent-fg [&_.text-accent]:text-accent-fg',
  '[&_.text-fg-2]:text-accent-fg [&_.text-fg-2]:opacity-80',
  '[&_.text-fg-3]:text-accent-fg [&_.text-fg-3]:opacity-80',
);

/** Link ink per side: accent on a peer bubble, accent-fg on the solid own bubble. */
export function bodyLinkClass(mine: boolean): string {
  return cn('underline', mine ? 'text-accent-fg' : 'text-accent');
}

/**
 * A message body as text runs and links. External urls open in a new tab and
 * show without the scheme; links to this app's own post or brief pages are
 * router links that open in-app. The whole link text is the tap target. Pure:
 * the origin is read at call time, so the first paint is final.
 */
export function renderMessageBody(
  body: string,
  mine: boolean,
  origin: string | null = currentOrigin(),
): ReactNode[] {
  const className = bodyLinkClass(mine);
  return tokenize(body).map((segment, i) => {
    if (segment.kind === 'text') return segment.text;
    const target = classify(segment.url, origin, APP_ENTITY_ROUTES);
    const label = displayUrl(segment.url);
    return target.kind === 'external' ? (
      <a
        key={i}
        data-msg-link=""
        href={segment.url}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {label}
      </a>
    ) : (
      <Link key={i} data-msg-link="" to={target.path} className={className}>
        {label}
      </Link>
    );
  });
}

/** Whether a pointer went down on a link in the body: the link handles the tap. */
export function isLinkTarget(target: unknown): boolean {
  return (
    typeof Element !== 'undefined' &&
    target instanceof Element &&
    target.closest('[data-msg-link]') !== null
  );
}

/** Message body text at 17px / 22px; the ink comes from the bubble (fg or accent-fg). */
export const BODY_TEXT = 'whitespace-pre-wrap [overflow-wrap:anywhere] text-[17px] leading-[22px]';

/** The in-bubble quote's author and preview at 14px / 18px (the composer draft is unchanged). */
export const BUBBLE_QUOTE_TEXT = '[&_.text-xs]:text-[14px] [&_.text-xs]:leading-[18px]';

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
  /** Directly under a TimeLabel or DayPill, which carries the gap: no top padding. */
  afterLabel?: boolean;
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
  /** Tap on an album tile: open the thread's image viewer at that index. */
  onOpenImage?: (index: number) => void;
  /** The KEY chip and the cards' talk-about / filter hooks. */
  postRefs?: BubblePostRefs | undefined;
  bubbleRef?: Ref<HTMLDivElement>;
  /** Swipe right to reply (touch and pen); off while selecting. */
  swipe?: { iconRef?: Ref<HTMLSpanElement> };
  press?: {
    handlers: BubblePointerHandlers;
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
  const album = hasAlbum(message);
  // Album bubbles pad 3px around the album; the rest keeps the text inset.
  const albumInset = 'px-[9px] pt-[5px]';
  const hasBody = message.body.trim() !== '';
  const hasCards = message.sharedPostIds.length > 0 || message.sharedBriefIds.length > 0;
  const textOnly =
    message.body.trim() !== '' &&
    message.attachments.length === 0 &&
    message.sharedPostIds.length === 0 &&
    message.sharedBriefIds.length === 0;
  const totalReactions = message.reactions.reduce((sum, r) => sum + r.count, 0);
  const distinctEmojis = message.reactions.map((r) => r.emoji).join('');
  const status = bubbleStatus(message, { showTicks, tail });
  const onMore = selection === undefined ? press?.onMore : undefined;
  const swipe = selection === undefined ? props.swipe : undefined;
  const chip = props.postRefs?.chip;
  const cardRefs = {
    messageId: message.id,
    onTalkAbout: props.postRefs?.onTalkAbout,
    onShowPost: props.postRefs?.onShowPost,
  };
  return (
    <li
      data-msg-id={message.id}
      data-state={message.state}
      data-selection={selection?.role}
      className={cn(
        'group flex items-start gap-2 px-4',
        head ? (props.afterLabel === true ? 'pt-0' : 'pt-2.5') : 'pt-0.5',
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
      <div className={cn('relative flex min-w-0 max-w-[76%] flex-col gap-1', mine && 'items-end')}>
        {showMeta ? <span className="text-sm font-medium text-fg">{name}</span> : null}
        {swipe !== undefined ? <SwipeReplyIcon iconRef={swipe.iconRef} /> : null}
        <div
          ref={bubbleRef}
          data-bubble=""
          data-swipe-reply={swipe !== undefined ? '' : undefined}
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
          className={cn(
            bubbleClass({
              mine,
              tail,
              sending,
              failed,
              checked: selection?.checked === true,
              voiceOnly,
              album,
            }),
            // The browser keeps vertical pans (the list scrolls); a horizontal
            // move is left to the swipe controller.
            swipe !== undefined && 'touch-pan-y touch-pinch-zoom',
          )}
        >
          <div className={album ? cn(albumInset, 'empty:hidden') : 'contents'}>
            <MarkBadge
              mark={props.mark}
              {...(props.onChangePriority !== undefined && selection === undefined
                ? { onChangePriority: props.onChangePriority }
                : {})}
            />
            {message.forwarded === true ? <ForwardedLabel mine={mine} /> : null}
          </div>
          <div data-bubble-content="" className={cn('contents', mine && OWN_BUBBLE_CONTENT)}>
            {chip?.kind === 'chip' ? (
              <PostRefChip
                post={chip.post}
                workspaceKey={chip.workspaceKey}
                onTap={chip.onTap}
                className={album ? 'mx-[9px]' : '-mb-1.5 -mt-2'}
              />
            ) : chip === undefined && reply !== null ? (
              <ReplyQuoteBox
                author={
                  reply.authorUserId !== null
                    ? (profiles.get(reply.authorUserId)?.displayName ?? 'Member')
                    : 'Member'
                }
                preview={reply.preview}
                onJump={() => props.onJumpToMessage?.(reply.id)}
                className={cn(BUBBLE_QUOTE_TEXT, album ? 'mx-[9px] mb-1 mt-[5px]' : 'mb-1')}
              />
            ) : null}
            {textOnly ? (
              <p className={BODY_TEXT}>{renderMessageBody(message.body, mine)}</p>
            ) : voiceOnly ? (
              <MessageAttachments
                attachments={message.attachments}
                cache={cache}
                presignEnabled={presignEnabled}
              />
            ) : album ? (
              <>
                <MessageAttachments
                  attachments={message.attachments}
                  cache={cache}
                  presignEnabled={presignEnabled}
                  album
                  caption={
                    hasBody ? (
                      <p className={BODY_TEXT}>{renderMessageBody(message.body, mine)}</p>
                    ) : undefined
                  }
                  onImageClick={(_attachment, index) => props.onOpenImage?.(index)}
                />
                {hasCards ? (
                  <div className="flex flex-col px-[9px] pb-[5px]">
                    <SharedPostCards postIds={message.sharedPostIds} {...cardRefs} />
                    <SharedBriefCards briefIds={message.sharedBriefIds} />
                  </div>
                ) : null}
              </>
            ) : (
              <>
                {hasBody ? (
                  <p className={BODY_TEXT}>{renderMessageBody(message.body, mine)}</p>
                ) : null}
                <MessageAttachments
                  attachments={message.attachments}
                  cache={cache}
                  presignEnabled={presignEnabled}
                />
                <SharedPostCards postIds={message.sharedPostIds} {...cardRefs} />
                <SharedBriefCards briefIds={message.sharedBriefIds} />
              </>
            )}
          </div>
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
                <span className={cn('text-[11px]', mine ? 'text-fg-2' : 'text-fg-3')}>
                  {totalReactions}
                </span>
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
      {failed && mine && message.filesMissing === true ? (
        <IconButton
          label="Remove message"
          className="shrink-0 self-center text-bad hover:bg-bad-soft hover:text-bad"
          onClick={() => props.onRetry?.(message.id)}
        >
          <IconTrash size={18} />
        </IconButton>
      ) : failed && mine ? (
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
 * With `times: false` (one post's conversation) the time labels drop.
 */
export function threadRows(
  messages: readonly ThreadMessage[],
  nowMs: number,
  timeZone: string,
  opts: { times?: boolean } = {},
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
    if (opts.times !== false && (afterDay || (prev !== undefined && isTimeGap(prev, message)))) {
      const label = formatMessageTime(messageTimeSource(message), timeZone);
      if (label !== '') rows.push({ kind: 'time', key: `time-${message.id}`, label });
    }
    rows.push({ kind: 'message', message, head, tail });
  });
  return rows;
}

/** The centred run time label: mono, tabular, tertiary. No motion. */
export function TimeLabel({ label }: { label: string }): ReactElement {
  return (
    <li className="flex justify-center pb-1.5 pt-2.5">
      <span className="font-mono text-[11px] tabular-nums text-fg-3">{label}</span>
    </li>
  );
}

/**
 * The message list: a flex column so the leading spacer (mt-auto) takes the
 * slack above the first message and a short thread pins to the bottom. Never
 * justify-end on the scroll container; the spacer collapses to 0 on overflow.
 */
export const THREAD_LIST_CLASS = 'flex flex-1 flex-col overflow-y-auto py-2';

/**
 * The list's children in order: the bottom-pin spacer, the older-page row, then
 * the grouped rows. A message row learns whether it sits directly under a time
 * label or day pill (afterLabel) so the label carries the gap. With `loadOlder`
 * (the per-post filter) a 44px "Load older" row sits at the top instead of the
 * scroll-to-top request. Pure.
 */
export function threadListItems(
  rows: readonly ThreadRow[],
  loadingOlder: boolean,
  renderMessage: (
    row: Extract<ThreadRow, { kind: 'message' }>,
    afterLabel: boolean,
  ) => ReactElement,
  loadOlder?: () => void,
  /** The filtered thread with no rows: this line sits under the Load older row. */
  emptyNote?: string,
): ReactElement[] {
  const items: ReactElement[] = [
    <li key="thread-spacer" aria-hidden="true" data-thread-spacer="" className="mt-auto" />,
  ];
  if (loadOlder !== undefined && !loadingOlder) {
    items.push(
      <li key="load-older" className="flex justify-center px-4">
        <button
          type="button"
          data-load-older=""
          onClick={loadOlder}
          className="flex min-h-[44px] items-center rounded-md px-4 text-xs font-medium text-accent transition-colors hover:bg-panel-2"
        >
          Load older
        </button>
      </li>,
    );
  }
  if (loadingOlder) {
    items.push(
      <li key="loading-older" className="px-4 py-2 text-center text-xs text-fg-3">
        Loading earlier messages
      </li>,
    );
  }
  rows.forEach((row, i) => {
    if (row.kind === 'day') items.push(<DayPill key={row.key} label={row.label} />);
    else if (row.kind === 'time') items.push(<TimeLabel key={row.key} label={row.label} />);
    else items.push(renderMessage(row, i > 0 && rows[i - 1]?.kind !== 'message'));
  });
  if (rows.length === 0 && emptyNote !== undefined) {
    items.push(
      <li
        key="filter-empty"
        data-filter-empty=""
        className="px-4 py-6 text-center text-sm text-fg-3"
      >
        {emptyNote}
      </li>,
    );
  }
  return items;
}

/**
 * Thin wrapper that owns the long-press / right-click and swipe-to-reply wiring
 * for one bubble and keeps MessageBubble pure. The bubble's rect is captured on
 * open so the floating action menu can anchor to it. Swipe frames are painted
 * straight onto the bubble and icon (translateX, scale, opacity), no re-render.
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
  afterLabel: boolean;
  timeZone: string;
  onOpen: (message: ThreadMessage, rect: DOMRect | null) => void;
  onRetry?: (messageId: string) => void;
  onJumpToMessage?: (messageId: string) => void;
  mark: ChatMark | undefined;
  onChangePriority?: (messageId: string) => void;
  selection?: RowSelection;
  /** Hover pointer device: render the ⋯ control. */
  hoverMenu: boolean;
  /** prefers-reduced-motion: the swipe resets without a spring. */
  reducedMotion: boolean;
  /** Swiped past the threshold: the same reply path as the menu's Reply. */
  onSwipeReply: (message: ThreadMessage) => void;
  onOpenImage: (message: ThreadMessage, index: number) => void;
  postRefs?: BubblePostRefs | undefined;
}): ReactElement {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLSpanElement>(null);
  const selecting = props.selection !== undefined;
  const latest = useRef(props);
  latest.current = props;
  const bubbleRect = (): DOMRect | null => bubbleRef.current?.getBoundingClientRect() ?? null;
  const swipeRef = useRef<SwipeReplyController | null>(null);
  // Mouse holds never open the menu (right-click and ⋯ do); touch is unchanged.
  // A completed long-press ends any pending swipe for that touch.
  const { handlers, consumeClickSuppression, cancel, clearClickSuppression } = useLongPress(
    () => {
      swipeRef.current?.cancel();
      open(bubbleRect());
    },
    { ignoreMouse: true },
  );
  if (swipeRef.current === null) {
    swipeRef.current = createSwipeReplyController({
      onReply: () => latest.current.onSwipeReply(latest.current.message),
      onFrame: (frame) => paintSwipe(bubbleRef.current, iconRef.current, frame),
      onStart: (pointerId) => {
        // A swipe never opens the menu: stop the hold timer (8px < its 10px).
        cancel();
        if (pointerId === undefined) return;
        try {
          bubbleRef.current?.setPointerCapture(pointerId);
        } catch {
          // The pointer is already gone; the gesture ends on its own.
        }
      },
      enabled: () => latest.current.selection === undefined,
      reducedMotion: () => latest.current.reducedMotion,
    });
  }
  const swipe = swipeRef.current;
  useEffect(() => {
    return () => {
      swipe.dispose();
    };
  }, [swipe]);
  function open(anchor: DOMRect | null): void {
    if (selecting) return;
    // The menu's backdrop takes the trailing pointerup, so no click to swallow.
    clearClickSuppression();
    props.onOpen(props.message, anchor);
  }
  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    cancel();
    if (swipe.swiping()) return;
    open(bubbleRect());
  };
  const pointer: BubblePointerHandlers = {
    onPointerDown: (e) => {
      // A press on a body link never arms the long-press menu; the swipe still
      // only starts past 8px, so a tap under that is the link's.
      if (!isLinkTarget(e.target)) handlers.onPointerDown(e);
      swipe.handlers.onPointerDown(e);
    },
    onPointerMove: (e) => {
      handlers.onPointerMove(e);
      swipe.handlers.onPointerMove(e);
    },
    onPointerUp: () => {
      handlers.onPointerUp();
      swipe.handlers.onPointerUp();
    },
    onPointerCancel: () => {
      handlers.onPointerCancel();
      swipe.handlers.onPointerCancel();
    },
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
      afterLabel={props.afterLabel}
      timeZone={props.timeZone}
      bubbleRef={bubbleRef}
      swipe={{ iconRef }}
      press={{
        handlers: pointer,
        onContextMenu,
        consumeClick: () => {
          // Read both so neither flag lingers into the next tap.
          const held = consumeClickSuppression();
          const swiped = swipe.consumeClickSuppression();
          return held || swiped;
        },
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
      onOpenImage={(index) => props.onOpenImage(props.message, index)}
      postRefs={props.postRefs}
      onBadgeClick={() => props.onOpen(props.message, bubbleRect())}
    />
  );
}

/**
 * Paint one swipe frame: the bubble moves on X only (translateX), the icon
 * scales 0.6 to 1 and fades in toward the threshold and fills when armed. At
 * rest the inline styles clear and the classes take over again.
 */
function paintSwipe(
  bubble: HTMLDivElement | null,
  icon: HTMLSpanElement | null,
  frame: SwipeFrame,
): void {
  const moved = frame.offset > 0;
  if (bubble !== null) {
    bubble.style.transition = frame.animate ? `transform ${SWIPE_SPRING_MS}ms ease-out` : '';
    bubble.style.transform = moved ? `translateX(${frame.offset}px)` : '';
  }
  if (icon !== null) {
    icon.style.opacity = moved ? String(frame.progress) : '';
    icon.style.transform = moved ? `scale(${0.6 + 0.4 * frame.progress})` : '';
    icon.toggleAttribute('data-armed', frame.armed);
  }
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
    /** A message's KEY chip (undefined keeps its quote). */
    chipFor?: (message: ThreadMessage) => BubbleChip | undefined;
    onTalkAbout?: (postId: string, messageId: string) => void;
    onShowPost?: (postId: string) => void;
    /** One post's conversation: no time labels, a "Load older" row at the top. */
    filtering?: boolean;
    /** The filtered post's KEY, for the filtered thread's empty line. */
    filterRef?: string | null;
  },
): ReactElement {
  const { onNewestVisible, jumpRequest } = props;
  const [menu, setMenu] = useState<{ message: ThreadMessage; rect: DOMRect | null } | null>(null);
  // The thread's one image viewer: which message's album, at which image.
  const [viewer, setViewer] = useState<{ messageId: string; index: number } | null>(null);
  const hoverMenu = useMediaQuery(HOVER_POINTER_QUERY);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
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
    setViewer(null);
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
  if (props.messages.length === 0 && props.filtering !== true) {
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
  const viewerMessage =
    viewer !== null ? props.messages.find((m) => m.id === viewer.messageId) : undefined;
  const viewerData =
    viewerMessage !== undefined
      ? threadLightbox(viewerMessage, props.profiles, props.timeZone)
      : null;
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
        className={THREAD_LIST_CLASS}
      >
        {threadListItems(
          threadRows(props.messages, nowMs, props.timeZone, { times: props.filtering !== true }),
          props.loadingOlder === true,
          (row, afterLabel) => (
            <MessageRow
              key={row.message.id}
              message={row.message}
              profiles={props.profiles}
              cache={props.cache}
              presignEnabled={props.presignEnabled}
              showTicks={props.showTicks}
              isGroup={props.isGroup}
              head={row.head}
              tail={row.tail}
              afterLabel={afterLabel}
              timeZone={props.timeZone}
              onOpen={(m, rect) => setMenu({ message: m, rect })}
              onOpenImage={(m, index) => setViewer({ messageId: m.id, index })}
              hoverMenu={hoverMenu}
              reducedMotion={reducedMotion}
              onSwipeReply={props.onReply}
              onJumpToMessage={scrollToMessage}
              postRefs={{
                chip: props.chipFor?.(row.message),
                onTalkAbout: props.onTalkAbout,
                onShowPost: props.onShowPost,
              }}
              mark={props.marks.get(row.message.id)}
              {...(props.onChangePriority !== undefined
                ? { onChangePriority: props.onChangePriority }
                : {})}
              {...(props.selection !== undefined
                ? {
                    selection: rowSelection(row.message, props.selection),
                  }
                : {})}
              {...(props.onRetry !== undefined ? { onRetry: props.onRetry } : {})}
            />
          ),
          props.filtering === true && props.hasMore === true
            ? () => {
                const el = listRef.current;
                if (el === null || anchorHeightRef.current !== null) return;
                // The prepended page keeps the reader where they were.
                anchorHeightRef.current = el.scrollHeight;
                props.onLoadOlder?.();
              }
            : undefined,
          props.filtering === true ? filterEmptyLabel(props.filterRef ?? null) : undefined,
        )}
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
      {viewer !== null && viewerData !== null && viewerData.images.length > 0 ? (
        <ImageLightbox
          images={viewerData.images}
          index={Math.min(viewer.index, viewerData.images.length - 1)}
          cache={props.cache}
          presignEnabled={props.presignEnabled}
          details={viewerData.details}
          onIndexChange={(index) =>
            setViewer((prev) => (prev !== null ? { ...prev, index } : prev))
          }
          onClose={() => setViewer(null)}
        />
      ) : null}
    </>
  );
}

/** One day pill between messages ("Today", "Yesterday", "D MMM"). No motion. */
export function DayPill({ label }: { label: string }): ReactElement {
  return (
    <li role="separator" aria-label={label} className="flex justify-center">
      <span className="self-center mb-1.5 mt-2 rounded-full border border-border bg-panel-2 px-2.5 py-0.5 text-[11px] font-medium text-fg-3">
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
  // The post the conversation is about: sends with no reply draft reply to its
  // card message. Independent of the reply draft; only its X clears it.
  const [aboutDraft, setAboutDraft] = useState<{ postId: string; cardMessageId: string } | null>(
    null,
  );
  // One post's conversation (client-side over the loaded pages).
  const [filterPostId, setFilterPostId] = useState<string | null>(null);
  // A share just sent: its card message becomes the About once the outbox bubble lands.
  const cardWaitRef = useRef(createCardExpectation());
  const cardWait = cardWaitRef.current;
  // Which rows are on screen: page rows wait for their chips, arrivals never do.
  const gateRef = useRef<PageGate | null>(null);
  // Bumped when a page row's hydration wait runs out, so it goes on without it.
  const [hydrationTick, setHydrationTick] = useState(0);
  const { workspaceKey, workspaceId } = useWorkspace();
  const toast = useToast();
  const marks = props.marks ?? NO_MARKS;
  // Open loops: posts in review (two reads per thread open) and the viewer's side.
  const viewerSide = useViewerSide(workspaceId);
  const openPosts = useOpenPosts(workspaceId, props.channelId ?? props.title);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marksOpen, setMarksOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
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
    setContactOpen(false);
    setPriorityFor(null);
    setJumpRequest(null);
    setForwardFor(null);
    setAboutDraft(null);
    setFilterPostId(null);
    cardWait.clear();
  }, [props.title, cardWait]);

  // Unmount: stop waiting on a share's card.
  useEffect(() => () => cardWait.clear(), [cardWait]);

  // The card a share queued has landed in the list: it is what the chat is about now.
  useEffect(() => {
    const found = cardWait.resolve(props.messages);
    if (found !== null) setAboutDraft(found);
  }, [props.messages, cardWait]);

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
  const headerLine = dmHeaderLine({
    isGroup: props.isGroup === true,
    peerTyping: props.typingUserIds.length > 0,
    presence: props.presence,
    role: props.role ?? null,
    workspaceName: props.subtitle,
    timeZone: props.timeZone,
  });
  const canOpenContact = props.isGroup !== true && props.channelId !== undefined;
  // The Contact sheet's role line is the header's resting line: never typing,
  // never presence, so it reads "role · workspace" from the same source.
  const contactRoleLine = dmHeaderLine({
    isGroup: false,
    peerTyping: false,
    presence: undefined,
    role: props.role ?? null,
    workspaceName: props.subtitle,
    timeZone: props.timeZone,
  });
  const jumpTo = (id: string): void =>
    setJumpRequest((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 }));
  // Jumps from the marks and contact sheets can land outside the filter.
  const jumpToAll = (id: string): void => {
    setFilterPostId(null);
    jumpTo(id);
  };

  // Chips: one batch over every chip's post (plus the About and filter posts).
  const parentIndex = useMemo(() => parentIndexOf(props.messages), [props.messages]);
  const chipIds = useMemo(
    () => chipPostIds(props.messages, parentIndex),
    [props.messages, parentIndex],
  );
  const batchIds = useMemo(
    () =>
      [...chipIds, aboutDraft?.postId, filterPostId ?? undefined].filter(
        (id): id is string => id !== undefined,
      ),
    [chipIds, aboutDraft?.postId, filterPostId],
  );
  const { postRef, chipSettled } = useChipBatch(batchIds);
  const sharedInChat = useMemo(
    () => new Set(props.messages.flatMap((m) => m.sharedPostIds)),
    [props.messages],
  );
  // First paint final, page by page: the rows of a page being loaded (the first
  // page, an older one) go on screen together once each is hydrated and its
  // chip post is settled, so a chip or its fallback quote paints with them and
  // the bottom snap happens after. Anything that arrives after a page is in
  // (own sends, live rows, state changes on shown rows) is never held. The
  // filter reads the full list: its rows are the post's own, whose chip post
  // is already known.
  const title = props.title;
  const admitted = useMemo(() => {
    const nowMs = Date.now();
    const next = admitRows(
      gateRef.current,
      title,
      props.messages,
      (row, since) => rowReady(row, since, { parentIndex, chipSettled, nowMs }),
      nowMs,
    );
    gateRef.current = next.gate;
    return next;
    // hydrationTick re-runs the cut once a hydration wait has run out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, props.messages, parentIndex, chipSettled, hydrationTick]);
  const onScreen = admitted.rows;
  const gatedIndex = useMemo(() => parentIndexOf(onScreen), [onScreen]);
  const shownMessages = useMemo(
    () => (filterPostId !== null ? filterRows(props.messages, filterPostId) : onScreen),
    [props.messages, onScreen, filterPostId],
  );
  useEffect(() => {
    const deadline = hydrationDeadline(admitted.gate, props.messages, parentIndex);
    if (deadline === null) return;
    const handle = setTimeout(
      () => setHydrationTick((t) => t + 1),
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(handle);
  }, [admitted, props.messages, parentIndex]);

  // Selection, jumps and the forward source read the list that is on screen.
  useEffect(() => {
    setSelected((prev) => {
      const next = pruneThreadSelection(prev, shownMessages);
      return next.size === prev.size ? prev : next;
    });
  }, [shownMessages]);
  const messagesById = useMemo(() => new Map(shownMessages.map((m) => [m.id, m])), [shownMessages]);
  const markedMessages = props.markedMessages;
  const messageFor = useCallback(
    (id: string): ThreadMessage | undefined => messagesById.get(id) ?? markedMessages?.get(id),
    [messagesById, markedMessages],
  );

  // The About post resolved to nothing (RLS, failed read): drop it and say so.
  const aboutPost = aboutDraft !== null ? postRef(aboutDraft.postId) : undefined;
  const aboutGone = aboutDraft !== null && aboutState(aboutPost) === 'gone';
  useEffect(() => {
    if (!aboutGone) return;
    setAboutDraft(null);
    toast.show({ title: ABOUT_UNAVAILABLE_TOAST });
  }, [aboutGone, toast]);

  /** Wait for the card of a share about to be sent; false (and a toast) when it cannot be. */
  const expectCard = (postId: string): boolean => {
    if (cardWait.expect(props.messages, postId, props.canSend)) return true;
    toast.show({ title: SHARE_UNAVAILABLE_TOAST });
    return false;
  };
  /** Talk about a card already in the thread: it becomes the About and flashes. */
  const talkAbout = (postId: string, cardMessageId: string): void => {
    cardWait.clear();
    setAboutDraft({ postId, cardMessageId });
    jumpTo(cardMessageId);
  };
  /**
   * Bring a post into the conversation: its newest loaded card becomes the
   * About (and is jumped to); with none, a card message is sent now through the
   * share path and becomes the About once the outbox assigns its id.
   */
  const bringPost = (postId: string): void => {
    if (filterPostId !== null && filterPostId !== postId) setFilterPostId(null);
    const card = newestCardFor(props.messages, postId);
    if (card !== null) {
      talkAbout(postId, card.id);
      return;
    }
    if (!expectCard(postId)) return;
    props.onSend('', [], [postId], null, []);
  };
  /**
   * Show one post's conversation; what is typed next stays about it. A chip
   * whose card is on an unloaded page pages it in first (or toasts).
   */
  const titleRef = useRef(title);
  titleRef.current = title;
  const showPost = (postId: string, cardMessageId?: string): void => {
    void openPostFilter({
      postId,
      cardMessageId,
      rows: props.messages,
      ensureLoaded: props.onEnsureLoaded,
      apply: (id, card) => {
        if (titleRef.current !== title) return;
        setFilterPostId(id);
        if (card !== null) setAboutDraft({ postId: id, cardMessageId: card });
      },
      toast: (message) => toast.show({ title: message }),
    });
  };
  const chipFor = (message: ThreadMessage): BubbleChip | undefined => {
    const target = chipTargetFor(message, gatedIndex);
    return bubbleChip(target, target !== null ? postRef(target.postId) : null, {
      workspaceKey,
      onShowPost: showPost,
    });
  };
  // The composer's send: the reply draft wins, else the About card while its
  // bar shows the post; a one-post share (paperclip or pasted link) makes its
  // new card the About, a several-post share leaves no About.
  const aboutReply = aboutReplyFor(
    aboutDraft,
    aboutPost,
    aboutDraft !== null ? messagesById.get(aboutDraft.cardMessageId) : undefined,
  );
  const composerSend: ComposerSend = (text, attachments, sharedPostIds, reply, sharedBriefIds) => {
    const [shared] = sharedPostIds;
    if (sharedPostIds.length === 1 && shared !== undefined) expectCard(shared);
    if (sharedPostIds.length > 1) {
      cardWait.clear();
      setAboutDraft(null);
    }
    props.onSend(
      text,
      attachments,
      sharedPostIds,
      replyForSend(reply, aboutReply, sharedPostIds.length > 0),
      sharedBriefIds,
    );
  };
  const filterPost = filterPostId !== null ? postRef(filterPostId) : undefined;
  const stripSlot = threadStripSlot({
    filtering: filterPostId !== null,
    hasMarks: props.marks !== undefined,
    selecting,
  });
  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border bg-panel px-2 md:px-4">
        {props.onBack !== undefined ? (
          <IconButton label="Back to conversations" onClick={props.onBack}>
            <IconChevronLeft size={20} />
          </IconButton>
        ) : null}
        <ThreadHeaderIdentity
          isGroup={props.isGroup === true}
          title={props.title}
          avatarUrl={props.avatarUrl ?? null}
          presence={headerAvatarPresence(props.presence)}
          headerLine={headerLine}
          {...(canOpenContact ? { onOpenContact: () => setContactOpen(true) } : {})}
        />
        {props.onOpenInfo !== undefined ? (
          <IconButton label="Group info" onClick={props.onOpenInfo}>
            <IconSettings size={20} />
          </IconButton>
        ) : null}
      </div>
      {stripSlot === 'filter' ? (
        <FilterStrip
          post={filterPost ?? null}
          workspaceKey={workspaceKey}
          onShowAll={() => setFilterPostId(null)}
        />
      ) : stripSlot === 'loops' ? (
        <MarkStrip
          marks={marks}
          loops={{
            ready: openPosts.ready && viewerSide.ready,
            posts: openPosts.count,
            side: viewerSide.side,
          }}
          onOpen={() => setMarksOpen(true)}
        />
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
        messages={shownMessages}
        chipFor={chipFor}
        onTalkAbout={talkAbout}
        onShowPost={showPost}
        filtering={filterPostId !== null}
        filterRef={filterPost != null ? postRefKey(workspaceKey, filterPost.number) : null}
        loading={props.loading || (filterPostId === null && holdingFirstPage(admitted.gate))}
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
        {...(props.onNewestVisible !== undefined && filterPostId === null
          ? { onNewestVisible: props.onNewestVisible }
          : {})}
        {...(props.onRetry !== undefined ? { onRetry: props.onRetry } : {})}
        {...(props.onToggleReaction !== undefined
          ? { onToggleReaction: props.onToggleReaction }
          : {})}
      />
      <TypingIndicator ids={props.typingUserIds} profiles={props.profiles} />
      {selecting && onDeleteMessages !== undefined ? (
        <SelectionBar
          count={selected.size}
          canDelete={canDeleteSelection(selected, shownMessages, marks)}
          {...(canForwardHere
            ? { onForward: () => setForwardFor(selectedForForward(selected, shownMessages)) }
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
          onSend={composerSend}
          disabled={!props.canSend}
          onTyping={props.onTyping}
          onCancelReply={() => setReplyDraft(null)}
          {...(replyDraft !== null ? { reply: replyDraft } : {})}
          {...(aboutDraft !== null && !aboutGone ? { about: aboutPost ?? null } : {})}
          onCancelAbout={() => setAboutDraft(null)}
          sharedPostIds={sharedInChat}
          onBringPost={bringPost}
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
            jumpToAll(id);
          }}
          onResolve={props.onResolveMark}
          onReopen={props.onReopenMark}
          openPosts={{
            heading: openPostsHeading(viewerSide.side),
            posts: openPosts.posts,
            workspaceKey,
            sharedIds: sharedInChat,
            onJump: (postId) => {
              setMarksOpen(false);
              const card = newestCardFor(props.messages, postId);
              if (card !== null) jumpToAll(card.id);
            },
            onShare: (postId) => {
              setMarksOpen(false);
              bringPost(postId);
            },
          }}
        />
      ) : null}
      {canOpenContact && props.channelId !== undefined ? (
        <ContactSheet
          key={props.channelId}
          open={contactOpen}
          onClose={() => setContactOpen(false)}
          channelId={props.channelId}
          title={props.title}
          avatarUrl={props.avatarUrl ?? null}
          roleLine={contactRoleLine}
          profiles={props.profiles}
          currentUserId={props.currentUserId ?? ''}
          timeZone={props.timeZone}
          cache={presignCache}
          presignEnabled={presignEnabled}
          marks={
            props.marks !== undefined &&
            props.onResolveMark !== undefined &&
            props.onReopenMark !== undefined
              ? {
                  marks,
                  messageFor,
                  profiles: props.profiles,
                  currentUserId: props.currentUserId ?? '',
                  timeZone: props.timeZone,
                  onResolve: props.onResolveMark,
                  onReopen: props.onReopenMark,
                }
              : null
          }
          onJump={jumpToAll}
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
