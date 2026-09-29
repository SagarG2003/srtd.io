// Renders the posts shared into one message as live cards. The whole message's
// ids resolve in ONE batch per viewer: readPostCards (a posts IN read plus one
// asset_attachments IN read, so at most two queries) and one readProfiles call
// for the distinct approvers (the same batched lookup the thread's profile map
// uses). The viewer's RLS gates visibility: a post they cannot see comes back
// absent and renders as a neutral "not visible" card, no content leaks. Cards
// paint only once the batch AND the viewer's side have resolved, so the footer
// wording never flips after first paint. No realtime: the batch refetches when
// the tab returns after a minute away, or when a sorted:post-changed event names
// one of its posts. The cover presigns lazily through the shared thumbnail hook.
// Tapping a card opens its PostSheet (media, facts, the viewer's action) instead
// of navigating; the sheet portals above the thread. Holding a card (450 ms,
// 10 px) brings its post into the conversation (onTalkAbout) and the click that
// ends the hold is swallowed, so the sheet does not open; the KEY on a card
// shows only that post's conversation (onShowPost).

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactElement,
  ReactNode,
  SyntheticEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Tag, isTagDot } from '@/components/ui/Tag';
import { IconCheck, IconPlay } from '@/components/ui/icons';
import { useLongPress } from '@/components/ui';
import { useThumbnail } from '@/components/media/use-thumbnail';
import { PresignCache, type PresignDeps } from '@/lib/asset-presign';
import { readProfiles } from '@/lib/chat-reads';
import { formatShortDate, workspaceTimeZone } from '@/lib/chat/time-format';
import { useViewerSide, type ViewerSide } from '@/lib/chat/viewer-role';
import { cn } from '@/lib/cn';
import { POST_CARD_META_TYPE, POST_CARD_TITLE_TYPE } from '@/components/chat/chat-type';
import { formatEntityRef } from '@/lib/entityRef';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { formatLabel } from '@/lib/post-detail-presentation';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import type { Client } from '@srtdio/rpc';
import { PostSheet } from '@/components/chat/PostSheet';
import { readPostCards, type PostCardRow } from '../../../packages/posts/src/reads';
import {
  NOT_VISIBLE_BODY,
  NOT_VISIBLE_TITLE,
  approverIds,
  cardFooter,
  indexPostsById,
  mediaPills,
  sharedPostViews,
  watchBatchFreshness,
  type SharedPostView,
} from '@/components/chat/post-card';

/** Title-case a stage value for its chip (stage strings come from the Row). */
function stageLabel(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

/** One resolved batch: the visible posts plus approver display names by user id. */
export interface PostCardBatch {
  posts: PostCardRow[];
  names: Map<string, string>;
}

/**
 * Resolve one message's batch: readPostCards (at most two queries) then ONE
 * readProfiles over the distinct approver ids (skipped when there are none).
 * Null when the posts read fails; a failed name read only drops the names (the
 * approved footer falls back to its date).
 */
export async function loadPostCardBatch(
  client: Client,
  workspaceId: string,
  ids: string[],
): Promise<PostCardBatch | null> {
  const result = await readPostCards(client, { workspaceId, ids });
  if (!result.ok) return null;
  const names = new Map<string, string>();
  const approvers = approverIds(result.data);
  if (approvers.length > 0) {
    const profiles = await readProfiles(client, approvers);
    if (profiles.ok) for (const p of profiles.data) names.set(p.userId, p.displayName);
  }
  return { posts: result.data, names };
}

/**
 * Resolve and keep fresh one message's shared posts. While the first read is in
 * flight `loading` is true; a refetch keeps the current cards on screen. Never
 * throws: a failed first read resolves to no posts, so every id falls back to
 * "not visible"; a failed refetch keeps what was shown.
 */
function useSharedPosts(postIds: string[]): { views: SharedPostView[]; loading: boolean } {
  const { workspaceId } = useWorkspace();
  const [batch, setBatch] = useState<PostCardBatch>({ posts: [], names: new Map() });
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const batchKey = postIds.join(',');
  const loadedKey = useRef<string | null>(null);
  const fetchedAt = useRef(0);
  const idsRef = useRef(postIds);
  idsRef.current = postIds;

  useEffect(() => {
    if (workspaceId === null || postIds.length === 0) {
      setLoading(false);
      return;
    }
    const key = `${workspaceId}|${batchKey}`;
    const first = loadedKey.current !== key;
    if (first) setLoading(true);
    let cancelled = false;
    void loadPostCardBatch(supabase, workspaceId, postIds).then((next) => {
      if (cancelled) return;
      fetchedAt.current = Date.now();
      loadedKey.current = key;
      setLoading(false);
      if (next !== null) setBatch(next);
      else if (first) setBatch({ posts: [], names: new Map() });
    });
    return () => {
      cancelled = true;
    };
    // postIds is read through batchKey so a new array with the same ids never re-reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchKey, workspaceId, tick]);

  useEffect(
    () =>
      watchBatchFreshness(
        { window, document },
        {
          ids: () => idsRef.current,
          fetchedAt: () => fetchedAt.current,
          now: () => Date.now(),
          refetch: () => setTick((t) => t + 1),
        },
      ),
    [],
  );

  const views = useMemo(
    () => sharedPostViews(postIds, indexPostsById(batch.posts), batch.names),
    [postIds, batch],
  );
  return { views, loading };
}

// One presign cache for every shared card in the session: it bounds concurrency
// and keeps URLs warm across messages. Created on first use, never per card. The
// post sheet shares it, and its deps mint the viewer's download URL.
const cardPresignDeps: PresignDeps = {
  endpoint: env.VITE_ASSET_READ_URL ?? null,
  getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
  fetcher: (input, init) => fetchWithTrace(input, init),
};
let cardPresignCache: PresignCache | null = null;
export function sharedCardPresignCache(): PresignCache {
  if (cardPresignCache === null) cardPresignCache = new PresignCache(cardPresignDeps);
  return cardPresignCache;
}
export const PRESIGN_ENABLED =
  env.VITE_ASSET_READ_URL !== undefined && env.VITE_ASSET_READ_URL !== '';

/** Talk-about and filter hooks a thread hands its cards; absent disables both. */
export interface CardRefActions {
  /** Hold on a card, or the sheet's "Talk about": bring the post into the conversation. */
  onTalkAbout?: ((postId: string) => void) | undefined;
  /** Tap on a card's KEY: show only that post's conversation. */
  onShowPost?: ((postId: string) => void) | undefined;
}

export function SharedPostCards({
  postIds,
  messageId,
  onTalkAbout,
  onShowPost,
}: {
  postIds: string[];
  /** The card message's id, handed to onTalkAbout. */
  messageId?: string;
  onTalkAbout?: ((postId: string, messageId: string) => void) | undefined;
  onShowPost?: ((postId: string) => void) | undefined;
}): ReactElement | null {
  const { workspaceId, workspaceKey, workspaces } = useWorkspace();
  const { side, ready } = useViewerSide(workspaceId);
  const { views, loading } = useSharedPosts(postIds);
  const timeZone = workspaceTimeZone(workspaces.find((w) => w.id === workspaceId)?.timezone);
  if (postIds.length === 0) return null;
  if (loading || !ready) {
    return (
      <div className="mt-1.5 flex flex-col items-start gap-1.5">
        {postIds.map((id) => (
          <div key={id} className={`${CARD_SKELETON} animate-pulse`} />
        ))}
      </div>
    );
  }
  return (
    <SharedPostCardList
      views={views}
      side={side}
      workspaceKey={workspaceKey}
      timeZone={timeZone}
      onTalkAbout={
        onTalkAbout !== undefined && messageId !== undefined
          ? (postId) => onTalkAbout(postId, messageId)
          : undefined
      }
      onShowPost={onShowPost}
    />
  );
}

/** Everything a card needs besides its view; resolved once per message. */
export interface CardContext {
  side: ViewerSide;
  workspaceKey: string | null;
  timeZone: string;
}

/** The resolved cards in postIds order (presentational; no reads). */
export function SharedPostCardList(
  props: { views: SharedPostView[] } & CardContext & CardRefActions,
): ReactElement {
  const { views, onTalkAbout, onShowPost, ...context } = props;
  return (
    <div className="mt-1.5 flex flex-col items-start gap-1.5">
      {views.map((view) =>
        view.kind === 'not_visible' ? (
          <NotVisibleCard key={view.postId} />
        ) : (
          <PostCardItem
            key={view.postId}
            view={view}
            {...context}
            {...(onTalkAbout !== undefined ? { onTalkAbout: () => onTalkAbout(view.postId) } : {})}
            {...(onShowPost !== undefined ? { onShowPost: () => onShowPost(view.postId) } : {})}
          />
        ),
      )}
    </div>
  );
}

/** The shared card box: one tappable row, thumb + title over meta. */
const SHARED_CARD_BOX =
  'flex w-[240px] items-center gap-2.5 rounded-lg border border-border px-2.5 py-2 min-h-[44px]';
export const SHARED_CARD = `${SHARED_CARD_BOX} bg-panel`;

/** The live post card frame: media (optional), body, footer stacked. */
export const POST_CARD =
  'flex w-[240px] flex-col overflow-hidden rounded-lg border border-border bg-panel text-left';

/** A loading card: the height of a no-media card (one title line, meta row, footer). */
export const CARD_SKELETON = 'h-[118px] w-[240px] rounded-lg border border-border bg-panel-2';

/** A small pill laid over the cover image. */
const MEDIA_PILL =
  'inline-flex h-5 items-center gap-1 rounded-md bg-panel px-1.5 text-[11px] font-medium text-fg';

/** The KEY-N reference, or null before the workspace key resolves. */
function entityRef(workspaceKey: string | null, number: number): string | null {
  return workspaceKey !== null && workspaceKey !== ''
    ? formatEntityRef(workspaceKey, number)
    : null;
}

/**
 * The card's tap and Enter key: both open its sheet, neither navigates (the sheet
 * carries "Open full post"). A click that ends a long-press (consumeHold reads
 * and clears the hold's suppression flag) is swallowed, as the bubble does. Pure
 * so the wiring is tested without a DOM.
 */
export function cardTapHandlers(
  openSheet: () => void,
  consumeHold: () => boolean = () => false,
): {
  onClick: () => void;
  onKeyDown: (e: Pick<KeyboardEvent<HTMLDivElement>, 'key' | 'preventDefault'>) => void;
} {
  return {
    onClick: () => {
      if (consumeHold()) return;
      openSheet();
    },
    onKeyDown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      openSheet();
    },
  };
}

/** A card's hold: 450 ms still within 10 px, the bubble's long-press defaults. */
export const CARD_HOLD = { thresholdMs: 450, moveTolerancePx: 10 } as const;

/**
 * A tap on a card's KEY. The KEY sits inside the card, so a hold that starts on
 * it is the card's hold: the release click reads (and so clears) the card's
 * suppression flag and does nothing else. A plain tap shows the post. Never
 * reaches the card's own click (which would open the sheet). Pure.
 */
export function keyTapHandler(
  onShowPost: () => void,
  consumeHold: () => boolean,
): (e: { stopPropagation: () => void }) => void {
  return (e) => {
    e.stopPropagation();
    if (consumeHold()) return;
    onShowPost();
  };
}

/** The small KEY pill on a card; a button (44px hit area) when it filters. */
function CardRef(props: {
  label: string;
  className: string;
  /** The inline KEY (no cover) carries data-card-ref; the cover pill data-card-pill-ref. */
  inline: boolean;
  onTap?: ((e: { stopPropagation: () => void }) => void) | undefined;
}): ReactElement {
  const onTap = props.onTap;
  const marker = props.inline ? { 'data-card-ref': '' } : { 'data-card-pill-ref': '' };
  if (onTap === undefined) {
    return (
      <span {...marker} className={props.className}>
        {props.label}
      </span>
    );
  }
  return (
    <button
      type="button"
      {...marker}
      aria-label={`Show the conversation about ${props.label}`}
      onClick={onTap}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(
        props.className,
        "before:absolute before:-inset-x-1 before:-inset-y-3 before:content-['']",
      )}
    >
      {props.label}
    </button>
  );
}

export function PostCardItem(
  props: { view: Extract<SharedPostView, { kind: 'post' }> } & CardContext & {
      onTalkAbout?: () => void;
      onShowPost?: () => void;
    },
): ReactElement {
  const { view, side, workspaceKey, timeZone } = props;
  const { post } = view;
  const ref = entityRef(workspaceKey, post.number);
  const footer = cardFooter(post, view.approverName, side, timeZone);
  const target = post.target_date !== null ? formatShortDate(post.target_date, timeZone) : '';
  // The sheet mounts on first open and stays mounted so its exit can animate.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetMounted, setSheetMounted] = useState(false);
  const onTalkAbout = props.onTalkAbout;
  const hold = useLongPress(() => onTalkAbout?.(), CARD_HOLD);
  // A touch hold also fires contextmenu (Android): the hold is the card's, so
  // the bubble's action menu stays shut. A mouse right-click still reaches it.
  const touchPress = useRef(false);
  const tap = cardTapHandlers(() => {
    setSheetMounted(true);
    setSheetOpen(true);
  }, hold.consumeClickSuppression);
  const onShowPost = props.onShowPost;
  const keyTap =
    onShowPost !== undefined ? keyTapHandler(onShowPost, hold.consumeClickSuppression) : undefined;
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        data-msg-link=""
        aria-haspopup="dialog"
        aria-label={`Open post ${post.title}`}
        {...(onTalkAbout !== undefined
          ? {
              ...hold.handlers,
              onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
                touchPress.current = e.pointerType !== 'mouse';
                hold.handlers.onPointerDown(e);
              },
              onContextMenu: (e: MouseEvent<HTMLDivElement>) => {
                if (!touchPress.current) return;
                e.preventDefault();
                e.stopPropagation();
              },
            }
          : {})}
        onClick={tap.onClick}
        onKeyDown={tap.onKeyDown}
        className={cn(POST_CARD, 'cursor-pointer transition-colors hover:bg-panel-2')}
      >
        {post.thumbnailAssetVersionId !== null ? (
          <CardMedia
            post={post}
            assetVersionId={post.thumbnailAssetVersionId}
            entityRef={ref}
            onKeyTap={keyTap}
          />
        ) : null}
        <div className="flex flex-col gap-1.5 px-3 py-2.5">
          <span
            data-card-title=""
            className={cn('line-clamp-2 text-fg', POST_CARD_TITLE_TYPE)}
            title={post.title}
          >
            {post.thumbnailAssetVersionId === null && ref !== null ? (
              <CardRef
                label={ref}
                className="relative mr-1.5 font-mono text-fg-3"
                inline
                onTap={keyTap}
              />
            ) : null}
            {post.title}
          </span>
          <span className={cn('flex items-center gap-1.5 text-fg-3', POST_CARD_META_TYPE)}>
            <Tag
              label={stageLabel(post.stage)}
              {...(isTagDot(post.stage) ? { dot: post.stage } : {})}
            />
            {target !== '' ? <span data-card-target="">{target}</span> : null}
          </span>
        </div>
        <div
          data-card-footer=""
          className="flex h-[44px] items-center justify-between gap-2 border-t border-border px-3 text-xs"
        >
          <span
            className={cn(
              'flex min-w-0 items-center gap-1',
              footer.accent ? 'font-medium text-accent' : 'text-fg-2',
            )}
          >
            {footer.check ? <IconCheck size={14} className="shrink-0 text-good" /> : null}
            <span className="truncate">{footer.state}</span>
          </span>
          <span className="shrink-0 font-medium text-accent">{footer.action}</span>
        </div>
      </div>
      {sheetMounted ? (
        <SheetBoundary>
          <PostSheet
            open={sheetOpen}
            onClose={() => setSheetOpen(false)}
            view={view}
            side={side}
            workspaceKey={workspaceKey}
            timeZone={timeZone}
            cache={sharedCardPresignCache()}
            deps={cardPresignDeps}
            presignEnabled={PRESIGN_ENABLED}
            {...(onTalkAbout !== undefined ? { onTalkAbout } : {})}
          />
        </SheetBoundary>
      ) : null}
    </>
  );
}

const stop = (e: SyntheticEvent): void => e.stopPropagation();

/**
 * React events bubble through portals along the component tree, so a tap inside
 * the sheet would otherwise reach the message bubble (long-press, swipe-reply,
 * the card's own open). This portal root stops them at the card.
 */
function SheetBoundary({ children }: { children: ReactNode }): ReactElement {
  return createPortal(
    <div
      onClick={stop}
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onPointerCancel={stop}
      onContextMenu={stop}
      onKeyDown={stop}
    >
      {children}
    </div>,
    document.body,
  );
}

/** The 4:3 cover with its corner pills; presigns lazily when scrolled into view. */
function CardMedia(props: {
  post: PostCardRow;
  assetVersionId: string;
  entityRef: string | null;
  onKeyTap?: ((e: { stopPropagation: () => void }) => void) | undefined;
}): ReactElement {
  const { post, assetVersionId, entityRef: ref } = props;
  const thumb = useThumbnail<HTMLDivElement>({
    assetVersionId,
    cache: sharedCardPresignCache(),
    enabled: PRESIGN_ENABLED,
  });
  const pills = mediaPills(post);
  return (
    <div ref={thumb.ref} data-card-media="" className="relative aspect-[4/3] w-full bg-panel-3">
      {thumb.url !== null && !thumb.failed ? (
        <img
          src={thumb.url}
          alt=""
          loading="lazy"
          onError={thumb.onError}
          className="h-full w-full object-cover"
        />
      ) : null}
      {ref !== null ? (
        <CardRef
          label={ref}
          className={cn(MEDIA_PILL, 'absolute left-2 top-2 font-mono')}
          inline={false}
          onTap={props.onKeyTap}
        />
      ) : null}
      <span className={cn(MEDIA_PILL, 'absolute right-2 top-2')}>{formatLabel(post.format)}</span>
      {pills.slides !== null || pills.video !== null ? (
        <span className="absolute bottom-2 right-2 flex gap-1">
          {pills.video !== null ? (
            <span className={MEDIA_PILL}>
              <IconPlay size={10} />
              {pills.video}
            </span>
          ) : null}
          {pills.slides !== null ? <span className={MEDIA_PILL}>{pills.slides}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The reader's RLS hid this post (e.g. a client receiving a draft). Same box as a
 * visible card, but no thumbnail and no link; never probes why it is hidden.
 */
export function NotVisibleCard(): ReactElement {
  return (
    <div className={`${SHARED_CARD_BOX} bg-panel-2 text-fg-2`}>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm font-medium">{NOT_VISIBLE_TITLE}</span>
        <span className="truncate text-xs">{NOT_VISIBLE_BODY}</span>
      </span>
    </div>
  );
}
