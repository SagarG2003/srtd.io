// Renders the posts shared into one message as cards. The whole message's ids
// resolve in ONE batched RLS read (readPostsByIds, IN-clause over every id), per
// viewer, so the viewer's RLS gates visibility: a post they cannot see comes back
// absent and renders as a neutral "not visible" card, no content leaks. The resolve is
// keyed on the message's ids, so a re-render never re-reads. No thumbnail is
// presigned: the existing posts read surfaces no cover image (a post's first
// image lives in asset_attachments and building that join is out of scope), so
// each card uses a neutral placeholder.

import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { PlatformMark } from '@/components/ui/PlatformMark';
import { Tag, isTagDot } from '@/components/ui/Tag';
import { IconPipeline } from '@/components/ui/icons';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import { readPostsByIds, type PostCardFields } from '@srtdio/posts';
import {
  NOT_VISIBLE_BODY,
  NOT_VISIBLE_TITLE,
  indexPostsById,
  postRoute,
  sharedPostViews,
  type SharedPostView,
} from '@/components/chat/post-card';

/** Title-case a stage value for its chip (stage strings come from the Row). */
function stageLabel(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

/**
 * Resolve one message's shared post ids once via the batched RLS read. While the
 * read is in flight the views are empty (a calm placeholder renders); after it
 * settles each id is a card or a "not visible" card. Never throws: a failed read
 * resolves to no posts, so every id falls back to "not visible".
 */
function useSharedPosts(postIds: string[]): { views: SharedPostView[]; loading: boolean } {
  const { workspaceId } = useWorkspace();
  const [postsById, setPostsById] = useState<Map<string, PostCardFields>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void readPostsByIds(supabase, { workspaceId, ids: postIds }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      setPostsById(indexPostsById(result.ok ? result.data : []));
    });
    return () => {
      cancelled = true;
    };
  }, [postIds, workspaceId]);

  const views = useMemo(() => sharedPostViews(postIds, postsById), [postIds, postsById]);
  return { views, loading };
}

export function SharedPostCards({ postIds }: { postIds: string[] }): ReactElement | null {
  const { views, loading } = useSharedPosts(postIds);
  if (postIds.length === 0) return null;
  if (loading) {
    return (
      <div className="mt-1.5 flex flex-col items-start gap-1.5">
        {postIds.map((id) => (
          <div
            key={id}
            className="h-[54px] w-[240px] animate-pulse rounded-lg border border-border bg-panel-2"
          />
        ))}
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex flex-col items-start gap-1.5">
      {views.map((view) => (
        <PostCardItem key={view.postId} view={view} />
      ))}
    </div>
  );
}

/** The shared card box: one tappable row, thumb + title over meta. */
const SHARED_CARD_BOX =
  'flex w-[240px] items-center gap-2.5 rounded-lg border border-border px-2.5 py-2 min-h-[44px]';
export const SHARED_CARD = `${SHARED_CARD_BOX} bg-panel`;

function PostCardItem({ view }: { view: SharedPostView }): ReactElement {
  const navigate = useNavigate();
  if (view.kind === 'not_visible') {
    return <NotVisibleCard />;
  }
  return (
    <button
      type="button"
      aria-label={`Open post ${view.title}`}
      onClick={() => navigate(postRoute(view.postId))}
      className={`${SHARED_CARD} text-left transition-colors hover:bg-panel-2`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-panel-3 text-fg-3">
        <IconPipeline size={18} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm font-medium text-fg" title={view.title}>
          {view.title}
        </span>
        <span className="flex items-center gap-1.5 text-xs text-fg-3">
          <Tag
            label={stageLabel(view.stage)}
            {...(isTagDot(view.stage) ? { dot: view.stage } : {})}
          />
          <PlatformMark platform={view.platform} />
        </span>
      </span>
    </button>
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
