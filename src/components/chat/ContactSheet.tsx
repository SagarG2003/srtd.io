// The DM Contact sheet: the peer's photo, name and role line, then Media, Files,
// Links and Marks tabs. Media and Files share ONE attachments read per page
// (split client-side); Links is one read per page; Marks is the pin board list
// MarksSheet renders. A tab's first page loads the first time it is shown and
// shows its loading state until that page resolves (first paint is final), then
// "Load more" reads the next keyset page while a page comes back full. Presigns
// go through the thread's PresignCache and sender names through the profiles
// map, so there is no per-row read. No motion beyond the Sheet's own transition;
// colours are tokens only, so light and dark match.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { Sheet } from '@/components/ui/Sheet';
import { IconFile, IconImage, IconLink, IconPin } from '@/components/ui/icons';
import { ImageLightbox } from '@/components/ui/ImageLightbox';
import { useAttachmentUrl } from '@/components/chat/MessageAttachments';
import { MarksList, type MarksListProps } from '@/components/chat/MarksSheet';
import { cn } from '@/lib/cn';
import { humanizeSize } from '@/lib/assets';
import { supabase } from '@/lib/supabase';
import type { PresignCache } from '@/lib/asset-presign';
import type { ChatProfile } from '@/lib/chat-reads';
import type { Result } from '@srtdio/rpc';
import type { MessageCursor } from '@/lib/chat/thread';
import { formatMessageTime, formatShortDate } from '@/lib/chat/time-format';
import { APP_ENTITY_ROUTES, currentOrigin, displayUrl } from '@/lib/chat/message-links';
import {
  listChannelAttachments,
  listChannelLinks,
  splitMediaFiles,
  type ChannelAttachmentItem,
  type ChannelLinkItem,
  type ChannelPage,
} from '@/lib/chat/channel-media';

export type ContactTab = 'media' | 'files' | 'links' | 'marks';

export const CONTACT_TABS: ReadonlyArray<{ key: ContactTab; label: string }> = [
  { key: 'media', label: 'Media' },
  { key: 'files', label: 'Files' },
  { key: 'links', label: 'Links' },
  { key: 'marks', label: 'Marks' },
];

export const CONTACT_EMPTY: Record<Exclude<ContactTab, 'marks'>, string> = {
  media: 'No photos yet',
  files: 'No files yet',
  links: 'No links yet',
};

/** One tab's paged list. `loading` holds until the first page resolves. */
export interface Feed<T> {
  status: 'loading' | 'ready' | 'error';
  items: T[];
  hasMore: boolean;
  cursor: MessageCursor | null;
  loadingMore: boolean;
}

export const FEED_LOADING: Feed<never> = {
  status: 'loading',
  items: [],
  hasMore: false,
  cursor: null,
  loadingMore: false,
};

/** Append a resolved page to a feed (the first page replaces the loading state). Pure. */
export function appendPage<T>(feed: Feed<T>, page: ChannelPage<T>): Feed<T> {
  return {
    status: 'ready',
    items: [...feed.items, ...page.items],
    hasMore: page.hasMore,
    cursor: page.cursor ?? feed.cursor,
    loadingMore: false,
  };
}

/** "Load more" shows only once the list is final and the last page came back full. */
export function showLoadMore(feed: Feed<unknown>): boolean {
  return feed.status === 'ready' && feed.hasMore;
}

/** Which feed a tab reads: Media and Files share the attachments read. */
export function feedForTab(tab: ContactTab): 'attachments' | 'links' | null {
  return tab === 'media' || tab === 'files' ? 'attachments' : tab === 'links' ? 'links' : null;
}

/**
 * One paged feed: nothing is read until `active` first turns true, then one
 * read per page. A stale response (the sheet re-keyed meanwhile) is dropped.
 */
function useFeed<T>(
  active: boolean,
  load: (before?: MessageCursor) => Promise<Result<ChannelPage<T>>>,
): { feed: Feed<T> | null; loadMore: () => void; retry: () => void } {
  const [feed, setFeed] = useState<Feed<T> | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const run = useCallback(
    (base: Feed<T>, before?: MessageCursor) => {
      void load(before).then((result) => {
        if (!live.current) return;
        setFeed(
          result.ok
            ? appendPage(base, result.data)
            : base.status === 'ready'
              ? { ...base, loadingMore: false }
              : { ...FEED_LOADING, status: 'error' },
        );
      });
    },
    [load],
  );

  useEffect(() => {
    if (!active || feed !== null) return;
    setFeed(FEED_LOADING);
    run(FEED_LOADING);
  }, [active, feed, run]);

  const loadMore = useCallback(() => {
    if (feed === null || !showLoadMore(feed) || feed.loadingMore || feed.cursor === null) return;
    const base = { ...feed, loadingMore: true };
    setFeed(base);
    run(base, feed.cursor);
  }, [feed, run]);

  const retry = useCallback(() => setFeed(null), []);
  return { feed, loadMore, retry };
}

/** "You" for the viewer, the profile name otherwise; never a user read. */
export function contactSenderName(
  userId: string | null,
  currentUserId: string,
  profiles: Map<string, ChatProfile>,
): string {
  if (userId !== null && userId === currentUserId) return 'You';
  return (userId !== null ? profiles.get(userId)?.displayName : undefined) ?? 'Unknown';
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase();
}

/** The 72px contact photo; initials on bg-panel-3 when there is no photo. */
function ContactPhoto(props: { name: string; avatarUrl: string | null }): ReactElement {
  return (
    <span className="flex h-[72px] w-[72px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-panel-3 text-xl font-semibold text-fg-2">
      {props.avatarUrl !== null ? (
        <img src={props.avatarUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        initialsOf(props.name)
      )}
    </span>
  );
}

/** One Media tile: square, bg-panel-3 until the presigned image lands. */
function MediaTile(props: {
  item: ChannelAttachmentItem;
  cache: PresignCache;
  presignEnabled: boolean;
  onOpen: () => void;
}): ReactElement {
  const { url } = useAttachmentUrl(props.item.versionId, props.cache, props.presignEnabled);
  return (
    <button
      type="button"
      aria-label={props.item.name !== '' ? props.item.name : 'Photo'}
      onClick={props.onOpen}
      className="relative block aspect-square min-h-[44px] w-full cursor-zoom-in overflow-hidden bg-panel-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
    >
      {url !== null ? (
        <img
          src={url}
          alt={props.item.name}
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : null}
    </button>
  );
}

const ROW =
  'flex min-h-[64px] w-full items-center gap-3 border-b border-border py-2 last:border-b-0';
const ROW_ICON =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-panel-2 text-fg-3';

/** "size · date" under a file name. Pure. */
export function fileMetaLine(item: ChannelAttachmentItem, timeZone: string): string {
  return `${humanizeSize(item.size)} · ${formatShortDate(item.createdAt, timeZone)}`;
}

/** One Files row: an anchor to the presigned url (new tab, download). */
function FileRow(props: {
  item: ChannelAttachmentItem;
  cache: PresignCache;
  presignEnabled: boolean;
  timeZone: string;
}): ReactElement {
  const { item } = props;
  const { url } = useAttachmentUrl(item.versionId, props.cache, props.presignEnabled);
  const name = item.name !== '' ? item.name : 'File';
  return (
    <li>
      <a
        {...(url !== null ? { href: url } : { 'aria-disabled': true })}
        target="_blank"
        rel="noopener noreferrer"
        download={name}
        className={cn(ROW, 'rounded-md text-left hover:bg-panel-2')}
      >
        <span className={ROW_ICON}>
          <IconFile size={20} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-fg">{name}</span>
          <span className="truncate text-xs text-fg-2">{fileMetaLine(item, props.timeZone)}</span>
        </span>
      </a>
    </li>
  );
}

/** One Links row. Hook-free. */
export function LinkRow(props: {
  item: ChannelLinkItem;
  sender: string;
  date: string;
}): ReactElement {
  return (
    <li>
      <a
        href={props.item.url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(ROW, 'rounded-md text-left hover:bg-panel-2')}
      >
        <span className={ROW_ICON}>
          <IconLink size={20} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-accent">
            {displayUrl(props.item.url)}
          </span>
          <span className="truncate text-xs text-fg-2">{`${props.sender} · ${props.date}`}</span>
        </span>
      </a>
    </li>
  );
}

export interface ContactSheetViewProps {
  open: boolean;
  onClose: () => void;
  title: string;
  avatarUrl: string | null;
  /** The DM header's "role · workspace" line (dmHeaderLine); null hides it. */
  roleLine: string | null;
  tab: ContactTab;
  onTab: (tab: ContactTab) => void;
  /** Media and Files share the attachments feed; null until first shown. */
  attachments: Feed<ChannelAttachmentItem> | null;
  links: Feed<ChannelLinkItem> | null;
  onLoadMore: (feed: 'attachments' | 'links') => void;
  onRetry: (feed: 'attachments' | 'links') => void;
  cache: PresignCache;
  presignEnabled: boolean;
  timeZone: string;
  senderName: (userId: string | null) => string;
  onOpenImage: (index: number) => void;
  /** Marks tab props, or null when the thread has no marks wiring. */
  marks: Omit<MarksListProps, 'open' | 'onJump'> | null;
  onJump: (messageId: string) => void;
}

/**
 * The first page's loading or error state, or the body once it resolved, plus
 * a 44px "Load more" when the last page came back full. Hook-free.
 */
export function FeedBody<T>(props: {
  feed: Feed<T> | null;
  empty: ReactElement;
  isEmpty: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  children: ReactNode;
}): ReactElement {
  const { feed } = props;
  if (feed === null || feed.status === 'loading') {
    return (
      <p data-feed="loading" className="py-10 text-center text-sm text-fg-3">
        Loading
      </p>
    );
  }
  if (feed.status === 'error') {
    return (
      <div data-feed="error" className="flex flex-col items-center gap-2 py-10 text-sm text-fg-3">
        <span>Could not load</span>
        <Button size="lg" onClick={props.onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div data-feed="ready" className="flex flex-col gap-3">
      {props.isEmpty && !feed.hasMore ? props.empty : props.children}
      {showLoadMore(feed) ? (
        <Button
          size="lg"
          data-load-more=""
          className="w-full"
          disabled={feed.loadingMore}
          onClick={props.onLoadMore}
        >
          Load more
        </Button>
      ) : null}
    </div>
  );
}

/** The sheet's tree for a given state. Hook-free so tests walk it directly. */
export function ContactSheetView(props: ContactSheetViewProps): ReactElement {
  const split = splitMediaFiles(props.attachments?.items ?? []);
  const feedProps = (kind: 'attachments' | 'links') => ({
    onLoadMore: () => props.onLoadMore(kind),
    onRetry: () => props.onRetry(kind),
  });
  let body: ReactElement;
  if (props.tab === 'media') {
    body = (
      <FeedBody
        feed={props.attachments}
        isEmpty={split.images.length === 0}
        empty={<EmptyState icon={<IconImage size={22} />} title={CONTACT_EMPTY.media} />}
        {...feedProps('attachments')}
      >
        <div data-media-grid="" className="grid grid-cols-3 gap-[2px]">
          {split.images.map((item, index) => (
            <MediaTile
              key={`${item.messageId}-${item.versionId}`}
              item={item}
              cache={props.cache}
              presignEnabled={props.presignEnabled}
              onOpen={() => props.onOpenImage(index)}
            />
          ))}
        </div>
      </FeedBody>
    );
  } else if (props.tab === 'files') {
    body = (
      <FeedBody
        feed={props.attachments}
        isEmpty={split.files.length === 0}
        empty={<EmptyState icon={<IconFile size={22} />} title={CONTACT_EMPTY.files} />}
        {...feedProps('attachments')}
      >
        <ul data-files="" className="flex flex-col">
          {split.files.map((item) => (
            <FileRow
              key={`${item.messageId}-${item.versionId}`}
              item={item}
              cache={props.cache}
              presignEnabled={props.presignEnabled}
              timeZone={props.timeZone}
            />
          ))}
        </ul>
      </FeedBody>
    );
  } else if (props.tab === 'links') {
    const items = props.links?.items ?? [];
    body = (
      <FeedBody
        feed={props.links}
        isEmpty={items.length === 0}
        empty={<EmptyState icon={<IconLink size={22} />} title={CONTACT_EMPTY.links} />}
        {...feedProps('links')}
      >
        <ul data-links="" className="flex flex-col">
          {items.map((item, index) => (
            <LinkRow
              key={`${item.messageId}-${index}`}
              item={item}
              sender={props.senderName(item.senderUserId)}
              date={formatShortDate(item.createdAt, props.timeZone)}
            />
          ))}
        </ul>
      </FeedBody>
    );
  } else {
    body =
      props.marks !== null ? (
        <MarksList
          {...props.marks}
          open={props.open}
          onJump={(messageId) => {
            props.onClose();
            props.onJump(messageId);
          }}
        />
      ) : (
        <EmptyState icon={<IconPin size={22} />} title="Nothing here" />
      );
  }

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Contact info">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col items-center gap-1 text-center">
          <ContactPhoto name={props.title} avatarUrl={props.avatarUrl} />
          <span className="mt-2 max-w-full truncate text-lg font-semibold text-fg">
            {props.title}
          </span>
          {props.roleLine !== null ? (
            <span data-role-line="" className="max-w-full truncate text-sm text-fg-2">
              {props.roleLine}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2" role="tablist">
          {CONTACT_TABS.map((option) => (
            <Chip
              key={option.key}
              label={option.label}
              size="tap"
              selected={props.tab === option.key}
              onClick={() => props.onTab(option.key)}
            />
          ))}
        </div>
        <div data-contact-tab={props.tab}>{body}</div>
      </div>
    </Sheet>
  );
}

export interface ContactSheetProps {
  open: boolean;
  onClose: () => void;
  channelId: string;
  title: string;
  avatarUrl: string | null;
  roleLine: string | null;
  profiles: Map<string, ChatProfile>;
  currentUserId: string;
  timeZone: string;
  cache: PresignCache;
  presignEnabled: boolean;
  marks: Omit<MarksListProps, 'open' | 'onJump'> | null;
  onJump: (messageId: string) => void;
}

/** The stateful sheet: tab, the two feeds, and the Media lightbox. Key it by channel. */
export function ContactSheet(props: ContactSheetProps): ReactElement {
  const [tab, setTab] = useState<ContactTab>('media');
  const [viewer, setViewer] = useState<number | null>(null);
  const { channelId, profiles, currentUserId } = props;

  const loadAttachments = useCallback(
    (before?: MessageCursor) =>
      listChannelAttachments(supabase, { channelId, ...(before !== undefined ? { before } : {}) }),
    [channelId],
  );
  const loadLinks = useCallback(
    (before?: MessageCursor) =>
      listChannelLinks(supabase, {
        channelId,
        appOrigin: currentOrigin(),
        routes: APP_ENTITY_ROUTES,
        ...(before !== undefined ? { before } : {}),
      }),
    [channelId],
  );
  const shown = props.open ? feedForTab(tab) : null;
  const attachments = useFeed(shown === 'attachments', loadAttachments);
  const links = useFeed(shown === 'links', loadLinks);

  const senderName = useCallback(
    (userId: string | null) => contactSenderName(userId, currentUserId, profiles),
    [currentUserId, profiles],
  );

  const images = splitMediaFiles(attachments.feed?.items ?? []).images;
  const current = viewer !== null ? images[Math.min(viewer, images.length - 1)] : undefined;

  return (
    <>
      <ContactSheetView
        open={props.open}
        onClose={props.onClose}
        title={props.title}
        avatarUrl={props.avatarUrl}
        roleLine={props.roleLine}
        tab={tab}
        onTab={setTab}
        attachments={attachments.feed}
        links={links.feed}
        onLoadMore={(kind) => (kind === 'attachments' ? attachments.loadMore() : links.loadMore())}
        onRetry={(kind) => (kind === 'attachments' ? attachments.retry() : links.retry())}
        cache={props.cache}
        presignEnabled={props.presignEnabled}
        timeZone={props.timeZone}
        senderName={senderName}
        onOpenImage={setViewer}
        marks={props.marks}
        onJump={props.onJump}
      />
      {props.open && viewer !== null && current !== undefined ? (
        <ImageLightbox
          images={images.map((item) => ({ assetId: item.versionId, name: item.name }))}
          index={Math.min(viewer, images.length - 1)}
          cache={props.cache}
          presignEnabled={props.presignEnabled}
          details={{
            sender: senderName(current.senderUserId),
            time: formatMessageTime(current.createdAt, props.timeZone),
          }}
          onIndexChange={setViewer}
          onClose={() => setViewer(null)}
        />
      ) : null}
    </>
  );
}
