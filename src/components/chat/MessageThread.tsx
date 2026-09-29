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
  distanceFromBottom,
  anchorAfterOlderLoad,
  flickInProgress,
  intentAfterNewest,
  intentAfterScroll,
  isScrollKey,
  openingIntent,
  SCROLL_SETTLE_MS,
  settleDecision,
  sizeChangeAction,
  type ScrollSource,
} from '@/lib/chat/stick-to-bottom';
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
  IconForward,
  IconSettings,
  IconTrash,
  IconUsers,
} from '@/components/ui/icons';
import { useLongPress } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/use-media-query';
import type { ChannelSummary, ChatProfile } from '@/lib/chat-reads';
import {
  breaksRun,
  deletedMessageLabel,
  replyPreview,
  type ThreadMessage,
} from '@/lib/chat/thread';
import { classifyAttachment, splitAlbum, type ReplyQuote } from '@/lib/chat/attachments';
import { useChatAttachments } from '@/lib/chat/use-chat-attachments';
import { formatClockTime } from '@/lib/chat/time-format';
import { getDraft, setDraft, type DraftReply } from '@/lib/chat/drafts';
import {
  BUBBLE_BODY_TYPE,
  BUBBLE_MAX,
  BUBBLE_META_TYPE,
  BUBBLE_PAD,
  BUBBLE_SHAPE,
  DATE_PILL_TYPE,
  GROUP_SENDER_TYPE,
  HEADER_LINE_TYPE,
  HEADER_NAME_TYPE,
  HEADER_PAD,
  HOVER_POINTER_QUERY,
  REACTION_EMOJI_TYPE,
  sized,
  TICK_ICON_BOX,
  TYPING_ROW_TYPE,
  useChatLayout,
  type ChatLayout,
} from '@/components/chat/chat-type';
import {
  createSwipeReplyController,
  SWIPE_SPRING_MS,
  type SwipeFrame,
  type SwipeReplyController,
} from '@/lib/chat/swipe-reply';
import type { PresignCache } from '@/lib/asset-presign';
import { roleLabel } from '@/components/pages/settings/members-data';
import { Composer, type ComposerSend, type EditingDraft } from '@/components/chat/Composer';
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
import {
  BanGlyph,
  MessageActionMenu,
  ownMessageActions,
} from '@/components/chat/MessageActionMenu';
import { SharedBriefCards } from '@/components/chat/BriefCard';
import { MarkBadge, SelectCheckbox, SelectLock } from '@/components/chat/MarkBits';
import {
  MarkStrip,
  MarksSheet,
  PrioritySheet,
  type StripLoops,
} from '@/components/chat/MarksSheet';
import { useOpenPosts, type UseOpenPosts } from '@/lib/chat/use-open-posts';
import { useViewerSide, type ViewerSide } from '@/lib/chat/viewer-role';
import { ContactSheet } from '@/components/chat/ContactSheet';
import { SelectionBar, deleteOneConfirm } from '@/components/chat/SelectionBar';
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
  threadSelectionRole,
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
  /** The channel's marks read has settled; the open-loops strip holds its first paint until then. */
  marksLoaded: boolean;
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
  /**
   * Edit the body of an own message; absent hides "Edit". Resolves ok, or the
   * mapped failure copy ("Edit window has closed (15 min)", ...).
   */
  onEditMessage?: (
    messageId: string,
    body: string,
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

/**
 * The open-loops strip input. Ready only when the posts round, the viewer side
 * and this channel's marks read have all settled, so the first painted label
 * is final.
 */
export function stripLoops(input: {
  openPosts: Pick<UseOpenPosts, 'ready' | 'count' | 'failed'>;
  side: { side: ViewerSide; ready: boolean };
  marksLoaded: boolean;
}): StripLoops {
  return {
    ready: input.openPosts.ready && input.side.ready && input.marksLoaded,
    posts: input.openPosts.failed ? null : input.openPosts.count,
    side: input.side.side,
  };
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
 * bottom bar's sender and the clock time (device hour cycle, workspace zone). Pure.
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
      time: formatClockTime(messageTimeSource(message), timeZone),
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
 * day it shows the clock time of the last visit (device hour cycle, workspace zone).
 */
export function lastSeenLabel(lastTimeMs: number | null, nowMs: number, timeZone: string): string {
  if (lastTimeMs === null) return 'Offline';
  const mins = Math.floor((nowMs - lastTimeMs) / 60000);
  if (mins < 1) return 'last seen just now';
  if (mins < 60) return `last seen ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `last seen ${hours}h ago`;
  return `last seen ${Math.floor(hours / 24)}d ago at ${formatClockTime(lastTimeMs, timeZone)}`;
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
    <div
      data-typing-row=""
      className={cn('flex shrink-0 items-center gap-2 px-4 py-1.5 text-fg-3', TYPING_ROW_TYPE)}
    >
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
  layout: ChatLayout;
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
      <span className={cn('block truncate text-fg', sized(HEADER_NAME_TYPE, props.layout))}>
        {props.title}
      </span>
      {props.headerLine !== null ? (
        <span
          data-header-line=""
          className={cn('truncate text-fg-3', sized(HEADER_LINE_TYPE, props.layout))}
        >
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
 * A bubble's spoken time for its aria-label: the server time on the workspace
 * clock ("2:05 pm") once recorded, 'Sending' while the record write is in
 * flight or retrying, and 'Not sent' once the background retries gave up.
 */
export function bubbleTimeLabel(message: ThreadMessage, timeZone: string): string {
  if (message.state === 'sending') return 'Sending';
  if (message.state === 'failed') return message.filesMissing === true ? FILES_MISSING : 'Not sent';
  const time = formatClockTime(messageTimeSource(message), timeZone);
  return isEdited(message) ? `${EDITED_LABEL}, ${time}` : time;
}

/** The muted label an edited message shows (before its time). */
export const EDITED_LABEL = 'edited';

/** Whether a message shows the "edited" label: a live message whose body was edited. */
export function isEdited(message: Pick<ThreadMessage, 'editedAt' | 'deleted'>): boolean {
  return message.deleted !== true && message.editedAt != null;
}

/** The status of a send whose picked files did not survive a reload. */
export const FILES_MISSING = 'Photos not sent';

/** The tick state a bubble's meta shows; null draws no glyph. */
export type BubbleStatus = 'sending' | 'failed' | 'files-missing' | 'delivered' | 'read';

/**
 * A bubble's status glyph: a clock while sending and an alert once failed (any
 * message), else a single tick (delivered) or double tick (read) on every own
 * DM message.
 */
export function bubbleStatus(
  message: Pick<ThreadMessage, 'mine' | 'state' | 'status' | 'filesMissing'>,
  opts: { showTicks: boolean },
): BubbleStatus | null {
  if (message.state === 'sending') return 'sending';
  if (message.state === 'failed') return message.filesMissing === true ? 'files-missing' : 'failed';
  if (!message.mine || !opts.showTicks) return null;
  return message.status === 'read' ? 'read' : 'delivered';
}

/** What every bubble shows at its bottom-right: "edited", the time, the tick. */
export interface BubbleMeta {
  time: string;
  edited: boolean;
  status: BubbleStatus | null;
}

/** A message's in-bubble meta, on the workspace clock in the device hour cycle. Pure. */
export function bubbleMeta(
  message: ThreadMessage,
  timeZone: string,
  opts: { showTicks: boolean },
): BubbleMeta {
  return {
    time: formatClockTime(messageTimeSource(message), timeZone),
    edited: isEdited(message),
    status: bubbleStatus(message, opts),
  };
}

/** The statuses the meta draws a glyph for; a failed send's alert sits outside the bubble. */
export type MetaTick = 'sending' | 'delivered' | 'read';

/** The spoken name of each meta glyph. */
const STATUS_LABEL: Record<MetaTick, string> = {
  sending: 'Sending',
  delivered: 'Delivered',
  read: 'Read',
};

/** The meta glyph a status draws; null for a failed send (its alert is outside). */
export function metaTick(status: BubbleStatus | null): MetaTick | null {
  return status === 'sending' || status === 'delivered' || status === 'read' ? status : null;
}

/**
 * The 16x11 status glyph: clock (sending), single tick (delivered), double tick
 * in the read token (read). currentColor otherwise, so it takes the meta ink at
 * full strength (or the media pill's white).
 */
export function MetaGlyph({ status }: { status: MetaTick }): ReactElement {
  return (
    <svg
      role="img"
      aria-label={STATUS_LABEL[status]}
      data-tick={status}
      viewBox="0 0 16 11"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(TICK_ICON_BOX, status === 'read' && 'text-[color:var(--tick-read)]')}
    >
      {status === 'sending' ? (
        <>
          <circle cx={8} cy={5.5} r={4.5} />
          <path d="M8 3.2v2.5l1.6 1" />
        </>
      ) : null}
      {status === 'delivered' ? <path d="M3.5 5.8l2.8 2.8L12.5 2.2" /> : null}
      {status === 'read' ? (
        <>
          <path d="M1 5.8l2.8 2.8L10 2.2" />
          <path d="M7.2 8.2l.4.4L14.9 2.2" />
        </>
      ) : null}
    </svg>
  );
}

/**
 * The failed send's alert: a "!" in a circle in the bad token, drawn on the
 * page background beside the bubble (5.05:1 light, 5.83:1 dark).
 */
export function FailedGlyph(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      data-failed-glyph=""
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx={12} cy={12} r={10} />
      <path d="M12 7v6M12 16.5v.5" />
    </svg>
  );
}

/** The meta's inner run: "edited", time, glyph. Shared by the meta and its spacer. */
function metaParts(meta: BubbleMeta): ReactElement {
  const tick = metaTick(meta.status);
  return (
    <>
      {meta.edited ? <span data-edited="">{EDITED_LABEL}</span> : null}
      {meta.time !== '' ? <span aria-hidden="true">{meta.time}</span> : null}
      {tick !== null ? <MetaGlyph status={tick} /> : null}
    </>
  );
}

/**
 * Where a bubble's meta sits: after its text (inline), on a pill over a bare
 * image album (pill), or in its own right-aligned row under everything else
 * (row: voice, files, cards, and media with a caption).
 */
export type MetaPlacement = 'inline' | 'pill' | 'row';

/** The meta's ink on the bubble: the own or peer meta token, at full strength. */
function metaInk(mine: boolean): string {
  return mine ? 'text-[color:var(--bubble-meta-own)]' : 'text-[color:var(--bubble-meta)]';
}

/** Each placement's position: two overlays at the bottom-right, the row in flow. */
const META_POSITION: Record<MetaPlacement, string> = {
  inline: 'pointer-events-none absolute bottom-[3px] right-2 inline-flex',
  pill: 'pointer-events-none absolute bottom-2 right-2 inline-flex rounded-full bg-[color:var(--media-meta-bg)] px-1.5 py-px text-[color:var(--media-meta-fg)]',
  row: 'pointer-events-none mt-1 flex justify-end',
};

/**
 * The meta itself. Inline sits at the bubble's bottom-right beside the text's
 * spacer; pill sits over a bare album on the translucent dark pill in white;
 * row is its own right-aligned line inside the bubble, below the content, so it
 * never overlaps it. Inline and row take the bubble's meta ink. Opacity-free,
 * no motion.
 */
export function BubbleMetaView(props: {
  meta: BubbleMeta;
  mine: boolean;
  placement: MetaPlacement;
  className?: string | undefined;
}): ReactElement {
  return (
    <span
      data-meta={props.placement}
      data-status={props.meta.status ?? undefined}
      className={cn(
        'items-center gap-1 whitespace-nowrap',
        BUBBLE_META_TYPE,
        META_POSITION[props.placement],
        props.placement !== 'pill' && metaInk(props.mine),
        props.className,
      )}
    >
      {metaParts(props.meta)}
    </span>
  );
}

/**
 * The invisible inline spacer at the end of a bubble's text: the meta's own
 * width (same parts, same type) plus a gap. A short last line keeps the meta
 * beside it; a full one pushes the spacer, and so the meta, to its own line.
 */
export function MetaSpacer({ meta }: { meta: BubbleMeta }): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-meta-spacer=""
      className={cn(
        'pointer-events-none invisible inline-flex select-none items-center gap-1 whitespace-nowrap pl-3 align-baseline',
        BUBBLE_META_TYPE,
      )}
    >
      {metaParts(meta)}
    </span>
  );
}

/** The line under a failed own bubble ("Not sent" / "Photos not sent"); its alert (Retry) sits beside the bubble. */
function FailedLine({ status }: { status: 'failed' | 'files-missing' }): ReactElement {
  return (
    <span data-failed={status} className={cn('text-bad', BUBBLE_META_TYPE)}>
      {status === 'failed' ? 'Not sent' : FILES_MISSING}
    </span>
  );
}

/** Where a bubble sits in its run and which size table draws it. */
export interface BubbleShape {
  mine: boolean;
  /** First bubble of its run. */
  head: boolean;
  /** Last bubble of its run. */
  tail: boolean;
  layout: ChatLayout;
}

/**
 * The sender-side tail corner. Touch: 18px radius, the 4px corner at the
 * bottom on the last bubble of a run. Laptop: 7.5px radius, the square corner
 * at the top on the first bubble of a run; later bubbles are fully rounded.
 */
export function bubbleCorners(shape: BubbleShape): string {
  if (shape.layout === 'laptop') {
    return cn(
      sized(BUBBLE_SHAPE, 'laptop'),
      shape.head && (shape.mine ? 'rounded-tr-none' : 'rounded-tl-none'),
    );
  }
  return cn(
    sized(BUBBLE_SHAPE, 'touch'),
    shape.tail && (shape.mine ? 'rounded-br-[4px]' : 'rounded-bl-[4px]'),
  );
}

/**
 * The bubble shell: own on the bubble-own fill (the accent in light, a deeper
 * accent in dark so accent-fg ink clears 4.5:1), peer on panel-2, no border.
 * The radius, padding and tail corner come from the layout's size table. A
 * sending bubble keeps full strength (its clock says it is sending).
 */
export function bubbleClass(
  state: BubbleShape & {
    failed: boolean;
    voiceOnly: boolean;
    /** Image album: 3px padding around the album, at least 240px wide. */
    album?: boolean;
  },
): string {
  return cn(
    'group/bubble relative min-w-0 select-none [-webkit-touch-callout:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
    bubbleCorners(state),
    state.album === true ? 'min-w-[240px] p-[3px]' : sized(BUBBLE_PAD, state.layout),
    state.voiceOnly && 'min-w-[220px]',
    state.mine ? 'bg-bubble-own text-accent-fg' : 'bg-panel-2 text-fg',
    state.failed && 'border border-bad',
  );
}

/**
 * A deleted message's bubble: same side, radius and tail as a live one, but a
 * hairline border on no fill, muted italic ink, and no focus (no menu).
 */
export function tombstoneClass(shape: BubbleShape): string {
  return cn(
    'relative flex min-w-0 select-none items-center gap-1.5 border border-border italic text-fg-3',
    sized(BUBBLE_BODY_TYPE, shape.layout),
    bubbleCorners(shape),
    sized(BUBBLE_PAD, shape.layout),
  );
}

/** A checked row's neutral tint: panel-3 at partial opacity across the full row. */
export const SELECTED_ROW_TINT = 'pointer-events-none absolute inset-0 -z-10 bg-panel-3 opacity-60';

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

/** Message body text on the layout's type scale; the ink comes from the bubble (fg or accent-fg). */
export function bodyText(layout: ChatLayout): string {
  return cn('whitespace-pre-wrap [overflow-wrap:anywhere]', sized(BUBBLE_BODY_TYPE, layout));
}

/**
 * Where a bubble's meta goes: after the text of a text-only message (inline),
 * on the pill over a bare image album (images only: no caption, no files, no
 * cards), else in its own row under the content (voice, files, cards, and any
 * media with a caption). Videos render as file rows, so they take the row. Pure.
 */
export function metaPlacement(
  message: Pick<ThreadMessage, 'body' | 'attachments' | 'sharedPostIds' | 'sharedBriefIds'>,
): MetaPlacement {
  const hasBody = message.body.trim() !== '';
  const hasCards = message.sharedPostIds.length > 0 || message.sharedBriefIds.length > 0;
  if (hasCards) return 'row';
  if (message.attachments.length === 0) return hasBody ? 'inline' : 'row';
  const { images, others } = splitAlbum(message.attachments);
  return !hasBody && images.length > 0 && others.length === 0 ? 'pill' : 'row';
}

/** The small chevron in a bubble's top-right corner (laptop hover). */
function ChevronGlyph(): ReactElement {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** The smiley beside a bubble (laptop hover): opens the reactions row. */
function SmileyGlyph(): ReactElement {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx={12} cy={12} r={9} />
      <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
      <path d="M9 9.5h.01M15 9.5h.01" />
    </svg>
  );
}

/**
 * The reaction badge: under the bubble's bottom-left, overlapping its bottom
 * edge by 3px (the meta's box starts 3px up, so the badge never covers it on
 * any bubble width). About 20px tall, so it hangs 17px below the bubble.
 */
export const REACTION_BADGE_CLASS =
  'absolute left-2 top-[calc(100%-3px)] inline-flex items-center gap-0.5 rounded-full border border-border bg-panel px-1.5 py-0.5';

/** A row with a reaction badge makes room for its 17px overhang plus a gap. */
export const REACTION_ROW_SPACE = 'mb-5';

/**
 * A failed own send's alert: a 44x44 hit area outside the bubble on the side
 * away from the tail (left of own bubbles), vertically centred on it, the "!"
 * in the bad token on the page background.
 */
export const FAILED_RETRY_CLASS =
  'absolute right-full top-1/2 mr-1 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-bad hover:bg-bad-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/** Hover-only controls fade in on opacity alone, 120ms, and not at all under reduced motion. */
const HOVER_FADE = 'transition-opacity duration-[120ms] motion-reduce:transition-none';

/**
 * One message row in the thread. Own messages (`message.mine`) right-align on
 * the solid accent, no avatar and no sender name. Peer messages left-align; in a
 * group the run head carries the avatar + sender name above the bubble, while
 * tucked replies reserve an aligned gutter. Every bubble carries its meta at the
 * bottom-right inside it ("edited", the time, and on own messages the tick),
 * after the text (an invisible spacer keeps the last line clear of it), as a
 * pill over a bare album, or in its own row under other content. A failed own
 * send reads "Not sent" under the bubble with a 44px red alert (Retry) beside
 * it, away from the tail; reactions hang as one small badge under the bubble.
 * On a laptop (fine pointer) a chevron fades in at the bubble's top-right and a
 * smiley beside it; touch keeps long-press and swipe. Rows in a run sit 2px
 * apart, runs 10px. Pure and hook-free: long-press wiring is owned by the
 * MessageRow wrapper and passed in via `press`, so the unit test can call this
 * directly. All colours are design tokens, so light and dark stay at parity.
 */
export function MessageBubble(props: {
  message: ThreadMessage;
  profiles: Map<string, ChatProfile>;
  cache: PresignCache;
  presignEnabled: boolean;
  showTicks: boolean;
  isGroup: boolean;
  head: boolean;
  /** Last bubble of its run: the touch tail corner. */
  tail: boolean;
  /** Directly under a DayPill, which carries the gap: no top padding. */
  afterLabel?: boolean;
  timeZone: string;
  /** The size table (touch or laptop) the bubble is drawn with. */
  layout: ChatLayout;
  /** The viewer's user id: a quote of their own deleted message reads "You deleted". */
  viewerUserId?: string | undefined;
  /** The in-bubble meta; computed from the message when absent. */
  meta?: BubbleMeta;
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
    /** Fine pointer only: the in-bubble chevron, opening the full menu. */
    onMore?: () => void;
    /** Fine pointer only: the smiley beside the bubble, opening the reactions row. */
    onReact?: () => void;
  };
}): ReactElement {
  const { message, profiles, cache, presignEnabled, showTicks, isGroup, head, tail } = props;
  const { onBadgeClick } = props;
  const { bubbleRef, press, timeZone, layout } = props;
  const mine = message.mine;
  const reply = message.reply;
  const name = senderName(message, profiles);
  const showMeta = isGroup && !mine && head;
  const gutter = isGroup && !mine && !head;
  const hasReactions = message.reactions.length > 0;
  const failed = message.state === 'failed';
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
  const meta = props.meta ?? bubbleMeta(message, timeZone, { showTicks });
  const placement = metaPlacement(message);
  const onMore = selection === undefined ? press?.onMore : undefined;
  const onReact = selection === undefined && message.state === 'sent' ? press?.onReact : undefined;
  const swipe = selection === undefined ? props.swipe : undefined;
  const chip = props.postRefs?.chip;
  const cardRefs = {
    messageId: message.id,
    onTalkAbout: props.postRefs?.onTalkAbout,
    onShowPost: props.postRefs?.onShowPost,
  };
  const column = cn('flex min-w-0 flex-col gap-1', sized(BUBBLE_MAX, layout), mine && 'items-end');
  const senderLine = showMeta ? (
    <span className={cn('text-fg', sized(GROUP_SENDER_TYPE, layout))}>{name}</span>
  ) : null;
  const shape: BubbleShape = { mine, head, tail, layout };
  const rowClass = cn(
    'group flex items-start gap-2 px-4',
    head ? (props.afterLabel === true ? 'pt-0' : 'pt-2.5') : 'pt-0.5',
    mine ? 'flex-row-reverse' : 'flex-row',
  );
  if (message.deleted === true) {
    // A tombstone keeps its side, meta and run grouping; nothing else.
    const tombMeta: BubbleMeta = { time: meta.time, edited: false, status: null };
    return (
      <li data-msg-id={message.id} data-state={message.state} data-deleted="" className={rowClass}>
        {showMeta ? (
          <Avatar name={name} {...senderAvatarProps(message, profiles)} size="md" />
        ) : null}
        {gutter ? <span className="w-[26px] shrink-0" aria-hidden="true" /> : null}
        <div className={column}>
          {senderLine}
          <div
            data-bubble=""
            data-tombstone=""
            role="group"
            aria-label={`${mine ? 'Your message' : `Message from ${name}`}, deleted, ${bubbleTimeLabel(message, timeZone)}`}
            className={tombstoneClass(shape)}
          >
            <BanGlyph size={16} />
            <span>
              {deletedMessageLabel({ mine })}
              <MetaSpacer meta={tombMeta} />
            </span>
            <BubbleMetaView meta={tombMeta} mine={false} placement="inline" />
          </div>
        </div>
      </li>
    );
  }
  const checked = selection?.checked === true;
  const parentDeleted = message.parentDeleted === true;
  const spacer = placement === 'inline' ? <MetaSpacer meta={meta} /> : null;
  const quotedMine =
    reply !== null && reply.authorUserId !== null && reply.authorUserId === props.viewerUserId;
  const body = (
    <p className={bodyText(layout)}>
      {renderMessageBody(message.body, mine)}
      {spacer}
    </p>
  );
  return (
    <li
      data-msg-id={message.id}
      data-state={message.state}
      data-selection={selection?.role}
      data-checked={checked ? '' : undefined}
      className={cn(rowClass, hasReactions && REACTION_ROW_SPACE, checked && 'relative isolate')}
    >
      {checked ? (
        <span aria-hidden="true" data-selected-tint="" className={SELECTED_ROW_TINT} />
      ) : null}
      {selection?.role === 'selectable' ? (
        <SelectCheckbox checked={selection.checked} onToggle={selection.onToggle} />
      ) : null}
      {selection?.role === 'locked' ? <SelectLock /> : null}
      {showMeta ? <Avatar name={name} {...senderAvatarProps(message, profiles)} size="md" /> : null}
      {gutter ? <span className="w-[26px] shrink-0" aria-hidden="true" /> : null}
      <div className={cn('relative', column)}>
        {senderLine}
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
            bubbleClass({ ...shape, failed, voiceOnly, album }),
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
            {chip?.kind === 'chip' && !parentDeleted ? (
              <PostRefChip
                post={chip.post}
                workspaceKey={chip.workspaceKey}
                onTap={chip.onTap}
                className={album ? 'mx-[9px]' : '-mb-1.5 -mt-2'}
              />
            ) : (chip === undefined || parentDeleted) && reply !== null ? (
              <ReplyQuoteBox
                author={
                  reply.authorUserId !== null
                    ? (profiles.get(reply.authorUserId)?.displayName ?? 'Member')
                    : 'Member'
                }
                preview={parentDeleted ? deletedMessageLabel({ mine: quotedMine }) : reply.preview}
                deleted={parentDeleted}
                inBubble={layout}
                onJump={() => props.onJumpToMessage?.(reply.id)}
                className={album ? 'mx-[9px] mb-1 mt-[5px]' : 'mb-1'}
              />
            ) : null}
            {textOnly ? (
              body
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
                  caption={hasBody ? body : undefined}
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
                {hasBody ? body : null}
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
          <BubbleMetaView
            meta={meta}
            mine={mine}
            placement={placement}
            className={placement === 'row' && album ? 'px-1.5 pb-0.5' : undefined}
          />
          {failed && mine && message.filesMissing !== true ? (
            <button
              type="button"
              data-failed-retry=""
              aria-label="Retry sending"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                props.onRetry?.(message.id);
              }}
              className={FAILED_RETRY_CLASS}
            >
              <FailedGlyph />
            </button>
          ) : null}
          {onMore !== undefined ? (
            <button
              type="button"
              data-more=""
              aria-label="Message options"
              aria-haspopup="menu"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onMore();
              }}
              className={cn(
                'pointer-events-none absolute right-0 top-0 z-10 flex h-11 w-11 items-start justify-end rounded-tr-[inherit] opacity-0 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover/bubble:pointer-events-auto group-hover/bubble:opacity-100',
                HOVER_FADE,
              )}
            >
              <span
                aria-hidden="true"
                data-more-glyph=""
                className={cn(
                  'flex h-[18px] w-10 items-start justify-end rounded-tr-[inherit] bg-gradient-to-l from-50% pr-1',
                  mine
                    ? 'from-bubble-own text-[color:var(--bubble-meta-own)]'
                    : 'from-panel-2 text-[color:var(--bubble-meta)]',
                )}
              >
                <ChevronGlyph />
              </span>
            </button>
          ) : null}
          {hasReactions ? (
            <button
              type="button"
              data-reaction-badge=""
              onClick={onBadgeClick}
              className={REACTION_BADGE_CLASS}
            >
              <span aria-hidden="true" className={REACTION_EMOJI_TYPE}>
                {distinctEmojis}
              </span>
              {totalReactions > 1 ? (
                <span className={cn(BUBBLE_META_TYPE, mine ? 'text-fg-2' : 'text-fg-3')}>
                  {totalReactions}
                </span>
              ) : null}
            </button>
          ) : null}
        </div>
        {meta.status === 'failed' || meta.status === 'files-missing' ? (
          <FailedLine status={meta.status} />
        ) : null}
      </div>
      {onReact !== undefined ? (
        <button
          type="button"
          data-react=""
          aria-label="React to message"
          aria-haspopup="menu"
          onClick={onReact}
          className={cn(
            'flex h-11 w-11 shrink-0 items-center justify-center self-center rounded-full text-fg-3 opacity-0 hover:bg-panel-2 hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover:opacity-100',
            HOVER_FADE,
          )}
        >
          <SmileyGlyph />
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
  | { kind: 'message'; message: ThreadMessage; head: boolean; tail: boolean; meta: BubbleMeta };

/**
 * The thread's render list: day pills, then runs. A run is consecutive messages
 * from one sender with no day pill and no 10-minute gap between neighbours; its
 * first message is the head, its last the tail. There are no time rows: every
 * message row carries its own meta (time on the workspace clock, "edited", and
 * the tick) for inside its bubble. Pure, so the list is grouped in one pass and
 * never re-groups after painting.
 */
export function threadRows(
  messages: readonly ThreadMessage[],
  nowMs: number,
  timeZone: string,
  opts: { showTicks?: boolean } = {},
): ThreadRow[] {
  const items = withDaySeparators(messages, nowMs, timeZone);
  const showTicks = opts.showTicks === true;
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
    rows.push({
      kind: 'message',
      message,
      head,
      tail,
      meta: bubbleMeta(message, timeZone, { showTicks }),
    });
  });
  return rows;
}

/**
 * The message list: a flex column so the leading spacer (mt-auto) takes the
 * slack above the first message and a short thread pins to the bottom. Never
 * justify-end on the scroll container; the spacer collapses to 0 on overflow.
 */
export const THREAD_LIST_CLASS = 'flex flex-1 flex-col overflow-y-auto py-2';

/**
 * The list's children in order: the bottom-pin spacer, the older-page row, then
 * the grouped rows. A message row learns whether it sits directly under a day
 * pill (afterLabel) so the pill carries the gap. With `loadOlder`
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
  /** The size table the day pills are drawn with. */
  layout: ChatLayout = 'touch',
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
    if (row.kind === 'day') {
      items.push(<DayPill key={row.key} label={row.label} layout={layout} />);
    } else items.push(renderMessage(row, i > 0 && rows[i - 1]?.kind !== 'message'));
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
  layout: ChatLayout;
  viewerUserId?: string | undefined;
  meta: BubbleMeta;
  /**
   * Open the menu: its anchor rect and the pressed bubble (drawn above the dim);
   * `reactionsOnly` (the laptop smiley) shows just the reactions row.
   */
  onOpen: (
    message: ThreadMessage,
    rect: DOMRect | null,
    held: HTMLElement | null,
    reactionsOnly?: boolean,
  ) => void;
  onRetry?: (messageId: string) => void;
  onJumpToMessage?: (messageId: string) => void;
  mark: ChatMark | undefined;
  onChangePriority?: (messageId: string) => void;
  selection?: RowSelection;
  /** Fine pointer device: the in-bubble chevron and the smiley. */
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
  function open(anchor: DOMRect | null, reactionsOnly = false): void {
    if (selecting) return;
    // The menu's backdrop takes the trailing pointerup, so no click to swallow.
    clearClickSuppression();
    props.onOpen(props.message, anchor, bubbleRef.current, reactionsOnly);
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
      layout={props.layout}
      viewerUserId={props.viewerUserId}
      meta={props.meta}
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
        // Chevron, right-click and long-press all open the same one-box menu.
        ...(props.hoverMenu
          ? { onMore: () => open(bubbleRect()), onReact: () => open(bubbleRect(), true) }
          : {}),
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
      onBadgeClick={() => props.onOpen(props.message, bubbleRect(), bubbleRef.current)}
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
    layout: ChatLayout;
    /** The viewer's user id, for quotes of their own deleted messages. */
    viewerUserId?: string | undefined;
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
    /** Menu "Edit" picked; absent hides it. */
    onEditMessage?: (message: ThreadMessage) => void;
    /** Menu "Delete" picked (the caller confirms); absent hides it. */
    onDeleteMessage?: (message: ThreadMessage) => void;
    onChangePriority?: (messageId: string) => void;
    /** A jump-to request (seq makes a repeat of the same id fire again). */
    jumpRequest: { id: string; seq: number } | null;
    onEnsureLoaded?: (messageId: string) => Promise<FindOlderOutcome>;
    /** A message's KEY chip (undefined keeps its quote). */
    chipFor?: (message: ThreadMessage) => BubbleChip | undefined;
    onTalkAbout?: (postId: string, messageId: string) => void;
    onShowPost?: (postId: string) => void;
    /** One post's conversation: a "Load older" row at the top. */
    filtering?: boolean;
    /** The filtered post's KEY, for the filtered thread's empty line. */
    filterRef?: string | null;
  },
): ReactElement {
  const { onNewestVisible, jumpRequest } = props;
  // The open menu: its message, anchor, held bubble and the moment it opened
  // (the edit and delete windows are judged then, not re-evaluated live).
  const [menu, setMenu] = useState<{
    message: ThreadMessage;
    rect: DOMRect | null;
    held: HTMLElement | null;
    openedAt: number;
    /** The laptop smiley: just the reactions row. */
    reactionsOnly: boolean;
  } | null>(null);
  // The thread's one image viewer: which message's album, at which image.
  const [viewer, setViewer] = useState<{ messageId: string; index: number } | null>(null);
  // A message deleted (live, or by us) while its menu is open closes the menu.
  const menuId = menu?.message.id ?? null;
  useEffect(() => {
    if (menuId === null) return;
    const current = props.messages.find((m) => m.id === menuId);
    if (current === undefined || current.deleted === true) setMenu(null);
  }, [props.messages, menuId]);
  const hoverMenu = useMediaQuery(HOVER_POINTER_QUERY);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const toast = useToast();
  const listRef = useRef<HTMLUListElement>(null);
  // Stick-to-bottom: the intent to stay on the latest message (true on open,
  // after an own send; only the reader's gestures let go of it), and who moved
  // the list last. The thread remounts per channel, so each chat opens pinned.
  const stickRef = useRef(openingIntent());
  const sourceRef = useRef<ScrollSource>('program');
  // The scroll height before an older page was requested, so the prepended rows
  // do not move what the reader was looking at.
  const anchorHeightRef = useRef<number | null>(null);
  const newestIdRef = useRef<string | null>(null);
  // The newest message last seen by the pin, to tell an own send from a re-render.
  const lastIdRef = useRef<string | null>(null);
  // A jump target waiting for its older page to render.
  const pendingJumpRef = useRef<string | null>(null);
  // One observer over the list and every row: any height change re-pins.
  const observerRef = useRef<ResizeObserver | null>(null);
  const observedRef = useRef<Set<Element>>(new Set());
  /** Every scroll the thread makes itself: its scroll events never change the intent. */
  const programScroll = useCallback((scroll: (el: HTMLUListElement) => void): void => {
    const el = listRef.current;
    if (el === null) return;
    sourceRef.current = 'program';
    scroll(el);
  }, []);
  const pin = useCallback((): void => {
    programScroll((el) => {
      el.scrollTop = el.scrollHeight;
    });
  }, [programScroll]);
  /** A user gesture on the list: the next scroll events are the reader's. */
  const userGesture = (): void => {
    sourceRef.current = 'user';
  };
  // A touch flick: the finger is down, or momentum is still scrolling (a scroll
  // event from the touch gesture in the last 150ms). A size change meanwhile
  // defers its pin until the list settles, then decides on the settled spot.
  const touchingRef = useRef(false);
  const touchScrollAtRef = useRef<number | null>(null);
  const deferredPinRef = useRef(false);
  const settleTimerRef = useRef<number | null>(null);
  const scheduleSettle = useCallback((): void => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      if (touchingRef.current) return;
      touchScrollAtRef.current = null;
      const el = listRef.current;
      if (!deferredPinRef.current || el === null) return;
      deferredPinRef.current = false;
      const settled = settleDecision({
        intent: stickRef.current,
        distanceFromBottom: distanceFromBottom(el),
        restoring: pendingJumpRef.current !== null || anchorHeightRef.current !== null,
      });
      stickRef.current = settled.intent;
      if (settled.action === 'pin') pin();
    }, SCROLL_SETTLE_MS);
  }, [pin]);
  const touchStart = (): void => {
    userGesture();
    touchingRef.current = true;
  };
  const touchEnd = (): void => {
    touchingRef.current = false;
    touchScrollAtRef.current = Date.now();
    scheduleSettle();
  };
  const ensureLoadedRef = useRef(props.onEnsureLoaded);
  ensureLoadedRef.current = props.onEnsureLoaded;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  /** Scroll a loaded message into view and ring it; false when it is not rendered. */
  const reveal = useCallback((id: string, highlightMs: number): boolean => {
    const el = listRef.current?.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
    if (el == null) return false;
    // A jump lets go of the bottom.
    stickRef.current = false;
    sourceRef.current = 'program';
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
    stickRef.current = false;
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
  // New rows: a pending jump owns the position while its pages land; an older
  // page keeps the reader where they were; else an own send takes hold of the
  // bottom again and, while the intent holds, the list pins instantly before
  // paint (open included, so the first paint is final).
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el === null || props.messages.length === 0) return;
    const last = props.messages[props.messages.length - 1];
    if (pendingJumpRef.current !== null) {
      anchorHeightRef.current = null;
      if (reveal(pendingJumpRef.current, JUMP_HIGHLIGHT_MS)) pendingJumpRef.current = null;
      return;
    }
    if (anchorHeightRef.current !== null) {
      const anchor = anchorHeightRef.current;
      programScroll((list) => {
        list.scrollTop += list.scrollHeight - anchor;
      });
      anchorHeightRef.current = null;
      return;
    }
    stickRef.current = intentAfterNewest({
      intent: stickRef.current,
      newest: last,
      previousNewestId: lastIdRef.current,
    });
    lastIdRef.current = last?.id ?? null;
    if (!stickRef.current) return;
    pin();
    if (last !== undefined && newestIdRef.current !== last.id) {
      newestIdRef.current = last.id;
      onNewestVisible?.();
    }
  }, [props.messages, onNewestVisible, reveal, pin, programScroll]);
  // Pin on any size change: every row and the list itself are observed (rows
  // as they mount and unmount), so late growth (cards, marks, badges, the
  // typing row, the composer, a font swap) re-pins before paint while the
  // intent holds. Runs after every commit to follow the rows.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null || typeof ResizeObserver === 'undefined') return;
    const observer =
      observerRef.current ??
      new ResizeObserver(() => {
        const touchScrollAt = touchScrollAtRef.current;
        const action = sizeChangeAction({
          intent: stickRef.current,
          pendingJump: pendingJumpRef.current !== null,
          olderPageRestore: anchorHeightRef.current !== null,
          flicking: flickInProgress({
            touching: touchingRef.current,
            msSinceTouchScroll: touchScrollAt !== null ? Date.now() - touchScrollAt : null,
          }),
        });
        if (action === 'pin') pin();
        if (action === 'defer') {
          deferredPinRef.current = true;
          if (!touchingRef.current && settleTimerRef.current === null) scheduleSettle();
        }
      });
    observerRef.current = observer;
    const observed = observedRef.current;
    for (const node of observed) {
      if (node === list || node.parentNode === list) continue;
      observer.unobserve(node);
      observed.delete(node);
    }
    for (const node of [list, ...Array.from(list.children)]) {
      if (observed.has(node)) continue;
      observer.observe(node);
      observed.add(node);
    }
  });
  // An older-page load that ended with no new rows (empty or failed) lets go of
  // the anchor, else size-change pinning would stay off for good.
  const loadingOlder = props.loadingOlder === true;
  const wasLoadingOlderRef = useRef(loadingOlder);
  const messagesAtLoadRef = useRef(props.messages);
  useLayoutEffect(() => {
    const wasLoading = wasLoadingOlderRef.current;
    wasLoadingOlderRef.current = loadingOlder;
    if (loadingOlder && !wasLoading) messagesAtLoadRef.current = props.messages;
    const anchored = anchorAfterOlderLoad({
      anchored: anchorHeightRef.current !== null,
      loadEnded: wasLoading && !loadingOlder,
      messagesChanged: props.messages !== messagesAtLoadRef.current,
    });
    if (!anchored) anchorHeightRef.current = null;
  }, [loadingOlder, props.messages]);
  useEffect(() => {
    const observed = observedRef.current;
    return () => {
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      observerRef.current?.disconnect();
      observerRef.current = null;
      observed.clear();
    };
  }, []);
  const scrollToMessage = (id: string): void => {
    const el = listRef.current?.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
    if (el == null) {
      toast.show({ title: 'That message is not loaded here' });
      return;
    }
    stickRef.current = false;
    sourceRef.current = 'program';
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
  const menuOwn =
    menu !== null
      ? ownMessageActions(menu.message, props.marks.get(menu.message.id), menu.openedAt)
      : { canEdit: false, canDelete: false, lockedByMark: false };
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
        onTouchStart={touchStart}
        onTouchMove={userGesture}
        onTouchEnd={touchEnd}
        onTouchCancel={touchEnd}
        onWheel={userGesture}
        onKeyDown={(e) => {
          if (isScrollKey(e.key)) userGesture();
        }}
        onPointerDown={(e) => {
          // A press on the list itself (not a row) is its scrollbar.
          if (e.target === e.currentTarget) userGesture();
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (touchingRef.current || touchScrollAtRef.current !== null) {
            touchScrollAtRef.current = Date.now();
            if (!touchingRef.current) scheduleSettle();
          }
          stickRef.current = intentAfterScroll({
            intent: stickRef.current,
            source: sourceRef.current,
            distanceFromBottom: distanceFromBottom(el),
          });
          if (isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight)) {
            const last = props.messages[props.messages.length - 1];
            if (last !== undefined && newestIdRef.current !== last.id) {
              newestIdRef.current = last.id;
              props.onNewestVisible?.();
            }
          }
          if (
            sourceRef.current === 'user' &&
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
          threadRows(props.messages, nowMs, props.timeZone, { showTicks: props.showTicks }),
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
              layout={props.layout}
              viewerUserId={props.viewerUserId}
              meta={row.meta}
              onOpen={(m, rect, held, reactionsOnly) => {
                if (m.deleted === true) return;
                setMenu({
                  message: m,
                  rect,
                  held,
                  openedAt: Date.now(),
                  reactionsOnly: reactionsOnly === true,
                });
              }}
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
                    selection: rowSelection(row.message, props.selection, props.marks),
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
          props.layout,
        )}
      </ul>
      <MessageActionMenu
        open={menu !== null}
        onClose={() => setMenu(null)}
        anchor={menu?.rect ?? null}
        held={menu?.held ?? null}
        mine={menu?.message.mine ?? false}
        canReact={menu !== null && menu.message.state === 'sent'}
        reactionsOnly={menu?.reactionsOnly === true}
        markedAs={menu !== null ? (props.marks.get(menu.message.id)?.type ?? null) : null}
        canEdit={props.onEditMessage !== undefined && menuOwn.canEdit}
        onEdit={() => {
          if (menu) props.onEditMessage?.(menu.message);
        }}
        canDelete={props.onDeleteMessage !== undefined && menuOwn.canDelete}
        onDelete={() => {
          if (menu) props.onDeleteMessage?.(menu.message);
        }}
        lockedByMark={menuOwn.lockedByMark}
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
export function DayPill({ label, layout }: { label: string; layout: ChatLayout }): ReactElement {
  return (
    <li role="separator" aria-label={label} className="flex justify-center">
      <span
        className={cn(
          'self-center mb-1.5 mt-2 rounded-full border border-border bg-panel-2 px-2.5 py-0.5 text-fg-3',
          sized(DATE_PILL_TYPE, layout),
        )}
      >
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

/**
 * Selection-mode state for one row: an own marked message shows the lock, any
 * other recorded, live message can be checked, deleted and pending ones nothing.
 */
export function rowSelection(
  message: ThreadMessage,
  selection: { selected: ReadonlySet<string>; onToggle: (id: string) => void },
  marks: Map<string, ChatMark>,
): RowSelection {
  return {
    role: threadSelectionRole(message, marks),
    checked: selection.selected.has(message.id),
    onToggle: () => selection.onToggle(message.id),
  };
}

/** The thread pane: header (+ optional back), message list, and composer. */
export function MessageThread(props: MessageThreadProps): ReactElement {
  const { canAttach, presignEnabled, presignCache, uploadFile, transcribe, canTranscribe } =
    useChatAttachments();
  // Everything per chat is keyed on the channel id (the parent also remounts
  // the thread per channel), never the title.
  const channelId = props.channelId;
  const channelKey = channelId ?? props.title;
  // The reply chip is part of this chat's draft: it starts from the draft map
  // on the first render (a switch back paints it on its first frame).
  const [replyDraft, setReplyDraftState] = useState<DraftReply | null>(() =>
    channelId !== undefined ? getDraft(channelId).reply : null,
  );
  const setReplyDraft = (next: DraftReply | null): void => {
    setReplyDraftState(next);
    if (channelId !== undefined) setDraft(channelId, { reply: next });
  };
  // Laptop (fine pointer): the composer takes the cursor when the chat opens.
  const finePointer = useMediaQuery(HOVER_POINTER_QUERY);
  // The size table by input: touch (phones, tablets) or laptop (mouse, 768px+).
  const layout = useChatLayout();
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
  const openPosts = useOpenPosts(workspaceId, channelKey);
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
  // The own message being edited in the composer, and the one awaiting its delete confirm.
  const [editing, setEditing] = useState<EditingDraft | null>(null);
  const [deleteFor, setDeleteFor] = useState<ThreadMessage | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // The message being edited was deleted or left the thread: stop editing it.
  const editingId = editing?.messageId ?? null;
  useEffect(() => {
    if (editingId === null) return;
    const target = props.messages.find((m) => m.id === editingId);
    if (target === undefined || target.deleted === true) setEditing(null);
  }, [props.messages, editingId]);

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
  const onEditMessage = props.onEditMessage;
  const startEdit = (message: ThreadMessage): void => {
    setEditing({
      messageId: message.id,
      initialText: message.body,
      hasOtherContent:
        message.attachments.length > 0 ||
        message.sharedPostIds.length > 0 ||
        message.sharedBriefIds.length > 0,
    });
  };
  const confirmDeleteOne = async (): Promise<void> => {
    const target = deleteFor;
    if (target === null || onDeleteMessages === undefined || deleteBusy) return;
    setDeleteBusy(true);
    const result = await onDeleteMessages([target.id]);
    setDeleteBusy(false);
    setDeleteFor(null);
    if (!result.ok) toast.show({ title: result.message });
  };
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
  const admitted = useMemo(() => {
    const nowMs = Date.now();
    const next = admitRows(
      gateRef.current,
      channelKey,
      props.messages,
      (row, since) => rowReady(row, since, { parentIndex, chipSettled, nowMs }),
      nowMs,
    );
    gateRef.current = next.gate;
    return next;
    // hydrationTick re-runs the cut once a hydration wait has run out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelKey, props.messages, parentIndex, chipSettled, hydrationTick]);
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
      const next = pruneThreadSelection(prev, shownMessages, marks);
      return next.size === prev.size ? prev : next;
    });
  }, [shownMessages, marks]);
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
  const channelRef = useRef(channelKey);
  channelRef.current = channelKey;
  const showPost = (postId: string, cardMessageId?: string): void => {
    void openPostFilter({
      postId,
      cardMessageId,
      rows: props.messages,
      ensureLoaded: props.onEnsureLoaded,
      apply: (id, card) => {
        if (channelRef.current !== channelKey) return;
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
      <div
        className={cn(
          'flex h-14 shrink-0 items-center gap-2.5 border-b border-border bg-panel',
          sized(HEADER_PAD, layout),
        )}
      >
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
          layout={layout}
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
          loops={stripLoops({
            openPosts,
            side: viewerSide,
            marksLoaded: props.marksLoaded,
          })}
          onOpen={() => setMarksOpen(true)}
        />
      ) : null}
      <ThreadBody
        layout={layout}
        viewerUserId={props.currentUserId}
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
                setEditing(null);
                setSelecting(true);
                setSelected(threadSelectable(message, marks) ? new Set([message.id]) : new Set());
              },
              onDeleteMessage: (message: ThreadMessage) => setDeleteFor(message),
            }
          : {})}
        {...(onEditMessage !== undefined && !selecting ? { onEditMessage: startEdit } : {})}
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
          key={channelKey}
          channelId={channelId}
          focusOnMount={finePointer}
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
          {...(editing !== null && onEditMessage !== undefined
            ? {
                editing,
                onEdit: async (text: string) => {
                  const result = await onEditMessage(editing.messageId, text);
                  if (result.ok) setEditing(null);
                  return result;
                },
              }
            : {})}
          onCancelEdit={() => setEditing(null)}
        />
      )}
      {deleteOneConfirm({
        open: deleteFor !== null,
        busy: deleteBusy,
        onCancel: () => setDeleteFor(null),
        onConfirm: () => void confirmDeleteOne(),
      })}
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
