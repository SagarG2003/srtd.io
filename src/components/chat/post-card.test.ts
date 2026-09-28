import { describe, expect, it } from 'vitest';
import type { PostCardFields } from '@srtdio/posts';
import {
  indexPostsById,
  postRoute,
  sharedPostViews,
  type SharedPostView,
} from '@/components/chat/post-card';

function post(id: string, over: Partial<PostCardFields> = {}): PostCardFields {
  return {
    id,
    title: `Post ${id}`,
    platform: 'instagram',
    format: 'reel',
    stage: 'approved',
    ...over,
  };
}

describe('postRoute', () => {
  it('points at the existing /posts/:id view', () => {
    expect(postRoute('p1')).toBe('/posts/p1');
  });
});

describe('sharedPostViews', () => {
  it('renders one card per id (title + stage), preserving message order', () => {
    const byId = indexPostsById([
      post('p1', { title: 'Launch teaser', stage: 'review' }),
      post('p2', { title: 'Recap', stage: 'approved' }),
    ]);
    const views = sharedPostViews(['p1', 'p2'], byId);
    expect(views).toEqual<SharedPostView[]>([
      {
        kind: 'post',
        postId: 'p1',
        title: 'Launch teaser',
        stage: 'review',
        platform: 'instagram',
      },
      { kind: 'post', postId: 'p2', title: 'Recap', stage: 'approved', platform: 'instagram' },
    ]);
  });

  it('maps an id the batched resolve did not return to the not-visible view', () => {
    // p2 is hidden by the viewer's RLS (e.g. a client and a draft): absent from the map.
    const byId = indexPostsById([post('p1', { title: 'Visible' })]);
    const views = sharedPostViews(['p1', 'p2'], byId);
    expect(views[0]).toMatchObject({ kind: 'post', postId: 'p1' });
    expect(views[1]).toEqual({ kind: 'not_visible', postId: 'p2' });
  });

  it('maps every id to not-visible when the resolve returned nothing', () => {
    const views = sharedPostViews(['p1', 'p2'], new Map());
    expect(views.every((v) => v.kind === 'not_visible')).toBe(true);
    expect(views).toHaveLength(2);
  });
});
