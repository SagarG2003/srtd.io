import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PostCardRow } from '../../../packages/posts/src/reads';
import { PostRefChip, createChipBatch, postRefKey } from '@/components/chat/PostRefChip';
import { FilterStrip } from '@/components/chat/FilterStrip';
import { chipPostIds, parentIndexOf } from '@/lib/chat/post-refs';
import type { ThreadMessage } from '@/lib/chat/thread';

function cardRow(id: string, number: number): PostCardRow {
  return {
    id,
    number,
    title: `Post ${id}`,
    platform: 'instagram',
    format: 'single_image',
    stage: 'review',
    target_date: null,
    stage_entered_at: '2026-09-20T10:00:00Z',
    approved_by: null,
    approved_at: null,
    thumbnailAssetVersionId: null,
    mediaCount: 0,
    hasVideo: false,
  };
}

type Row = Pick<ThreadMessage, 'id' | 'sharedPostIds' | 'reply' | 'parentSharedPostIds'>;
const card = (id: string, postId: string): Row => ({ id, sharedPostIds: [postId], reply: null });
const chipReply = (id: string, parent: string): Row => ({
  id,
  sharedPostIds: [],
  reply: { id: parent, authorUserId: null, preview: 'Shared post' },
});

describe('createChipBatch', () => {
  it('reads once per distinct set of new ids, never per chip', async () => {
    const load = vi.fn((ids: string[]) =>
      Promise.resolve({ ok: true as const, data: ids.map((id, i) => cardRow(id, i + 1)) }),
    );
    const batch = createChipBatch(load);

    // A page with five chips over two posts: one read.
    const page = [
      card('c1', 'p1'),
      card('c2', 'p2'),
      chipReply('r1', 'c1'),
      chipReply('r2', 'c1'),
      chipReply('r3', 'c2'),
      chipReply('r4', 'c2'),
      chipReply('r5', 'c1'),
    ];
    const ids = chipPostIds(page, parentIndexOf(page));
    await batch.request(ids);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenLastCalledWith(['p1', 'p2']);
    expect(batch.get('p1')?.number).toBe(1);

    // Re-renders with the same set read nothing.
    expect(batch.request(ids)).toBeNull();
    expect(batch.request(['p2', 'p1', 'p1'])).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);

    // An older page brings one new post: one more read, for that id only.
    const older = [card('c0', 'p3'), chipReply('r0', 'c0'), ...page];
    await batch.request(chipPostIds(older, parentIndexOf(older)));
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith(['p3']);
  });

  it('a post the read did not return (RLS) or a failed read resolves to null', async () => {
    const batch = createChipBatch((ids) =>
      Promise.resolve({ ok: true as const, data: [cardRow(ids[0] ?? '', 1)] }),
    );
    expect(batch.get('a')).toBeUndefined();
    await batch.request(['a', 'hidden']);
    expect(batch.get('a')?.id).toBe('a');
    expect(batch.get('hidden')).toBeNull();

    const failing = createChipBatch(() => Promise.reject(new Error('down')));
    await failing.request(['x']);
    expect(failing.get('x')).toBeNull();
  });
});

describe('PostRefChip', () => {
  const post = { id: 'p1', number: 14, title: 'Launch teaser', thumbnailAssetVersionId: null };

  it('is a 44px tap target around a 24px pill: 18px round thumb, mono accent KEY, title', () => {
    const html = renderToStaticMarkup(
      <PostRefChip post={post} workspaceKey="gbl" onTap={() => {}} />,
    );
    expect(html).toContain('min-h-[44px]');
    expect(html).toContain('h-6');
    expect(html).toContain('rounded-full');
    expect(html).toContain('h-[18px] w-[18px]');
    expect(html).toMatch(/font-mono[^"]*text-accent[^>]*>GBL-14</);
    expect(html).toMatch(/truncate[^>]*>Launch teaser</);
    // The bubble long-press ignores it, like a link.
    expect(html).toContain('data-msg-link=""');
  });

  it('tap shows the post and never reaches the bubble', () => {
    const onTap = vi.fn();
    const el = PostRefChip({ post, workspaceKey: 'gbl', onTap });
    const stopPropagation = vi.fn();
    (el.props as { onClick: (e: { stopPropagation: () => void }) => void }).onClick({
      stopPropagation,
    });
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalled();
  });

  it('omits the KEY before the workspace key resolves', () => {
    expect(postRefKey(null, 3)).toBeNull();
    expect(postRefKey('', 3)).toBeNull();
    expect(postRefKey('gbl', 3)).toBe('GBL-3');
    const html = renderToStaticMarkup(
      <PostRefChip post={post} workspaceKey={null} onTap={() => {}} />,
    );
    expect(html).not.toContain('data-post-ref-key');
  });
});

describe('FilterStrip', () => {
  it('reads "Showing" the post with Show all on the right, on accent-soft', () => {
    const post = { id: 'p1', number: 14, title: 'Launch teaser', thumbnailAssetVersionId: null };
    const html = renderToStaticMarkup(
      <FilterStrip post={post} workspaceKey="gbl" onShowAll={() => {}} />,
    );
    expect(html).toContain('bg-accent-soft');
    expect(html).toContain('Showing');
    expect(html).toContain('GBL-14');
    expect(html).toContain('Launch teaser');
    expect(html).toMatch(/min-h-\[44px\][^>]*>Show all</);
  });

  it('Show all calls back', () => {
    const onShowAll = vi.fn();
    const html = renderToStaticMarkup(
      <FilterStrip post={null} workspaceKey="gbl" onShowAll={onShowAll} />,
    );
    expect(html).toContain('Show all');
    const el = FilterStrip({ post: null, workspaceKey: 'gbl', onShowAll });
    const children = (el.props as { children: Array<{ props?: { onClick?: () => void } }> })
      .children;
    children.find((c) => c.props?.onClick !== undefined)?.props?.onClick?.();
    expect(onShowAll).toHaveBeenCalledTimes(1);
  });
});
