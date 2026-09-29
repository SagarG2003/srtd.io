// The strip that stands in for the marks strip while the thread shows one post's
// conversation: "Showing" then the post (thumbnail, KEY, title) and "Show all" on
// the right. Accent-soft background, tokens only, no motion.

import type { ReactElement } from 'react';
import { PostRefThumb, postRefKey, type PostRefPost } from '@/components/chat/PostRefChip';

export function FilterStrip(props: {
  /** The filtered post; null while its row is still loading (the strip still shows). */
  post: PostRefPost | null;
  workspaceKey: string | null;
  onShowAll: () => void;
}): ReactElement {
  const { post } = props;
  const ref = post !== null ? postRefKey(props.workspaceKey, post.number) : null;
  return (
    <div
      data-filter-strip=""
      className="flex min-h-[44px] w-full shrink-0 items-center gap-2 border-b border-border bg-accent-soft pl-4 text-xs text-fg-2"
    >
      <span className="shrink-0">Showing</span>
      {post !== null ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <PostRefThumb assetVersionId={post.thumbnailAssetVersionId} size={18} round />
          {ref !== null ? (
            <span className="shrink-0 font-mono font-medium text-accent">{ref}</span>
          ) : null}
          <span className="min-w-0 truncate font-medium text-fg">{post.title}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      <button
        type="button"
        data-filter-show-all=""
        onClick={props.onShowAll}
        className="flex min-h-[44px] shrink-0 items-center px-4 text-xs font-medium text-accent transition-colors hover:bg-panel-2"
      >
        Show all
      </button>
    </div>
  );
}
