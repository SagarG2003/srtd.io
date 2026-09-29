import { describe, expect, it, vi } from 'vitest';

// The card must never obtain a navigator: a tap opens the sheet instead.
const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { Client } from '@srtdio/rpc';
import type { PostCardRow } from '../../../packages/posts/src/reads';
import {
  CARD_SKELETON,
  NotVisibleCard,
  cardTapHandlers,
  POST_CARD,
  SHARED_CARD,
  SharedPostCardList,
  loadPostCardBatch,
  type CardContext,
} from '@/components/chat/PostCard';
import {
  NOT_VISIBLE_BODY,
  NOT_VISIBLE_TITLE,
  indexPostsById,
  sharedPostViews,
} from '@/components/chat/post-card';

describe('NotVisibleCard', () => {
  const html = renderToStaticMarkup(<NotVisibleCard />);

  it('renders the neutral title and one line of copy', () => {
    expect(NOT_VISIBLE_TITLE).toBe('Post not visible to you yet');
    expect(NOT_VISIBLE_BODY).toBe('It will appear here once it is shared for review');
    expect(html).toContain(NOT_VISIBLE_TITLE);
    expect(html).toContain(NOT_VISIBLE_BODY);
  });

  it('has no link, button or thumbnail, and uses neutral tokens', () => {
    expect(html).not.toMatch(/<a\b|<button\b|<svg\b|<img\b/);
    expect(html).toContain('bg-panel-2');
    expect(html).toContain('border-border');
    expect(html).toContain('text-fg-2');
  });

  it('keeps the visible card box size', () => {
    expect(html).toContain('w-[240px]');
    expect(html).toContain('min-h-[44px]');
    expect(SHARED_CARD).toContain('bg-panel');
  });
});

function cardRow(id: string, over: Partial<PostCardRow> = {}): PostCardRow {
  return {
    id,
    number: 12,
    title: `Post ${id}`,
    platform: 'instagram',
    format: 'carousel',
    stage: 'review',
    target_date: null,
    stage_entered_at: '2026-09-20T10:00:00Z',
    approved_by: null,
    approved_at: null,
    thumbnailAssetVersionId: null,
    mediaCount: 0,
    hasVideo: false,
    ...over,
  };
}

const CONTEXT: CardContext = { side: 'agency', workspaceKey: 'gbl', timeZone: 'UTC' };

function render(
  ids: string[],
  posts: PostCardRow[],
  context: Partial<CardContext> = {},
  names: Map<string, string> = new Map(),
): string {
  const views = sharedPostViews(ids, indexPostsById(posts), names);
  return renderToStaticMarkup(
    <MemoryRouter>
      <SharedPostCardList views={views} {...CONTEXT} {...context} />
    </MemoryRouter>,
  );
}

describe('SharedPostCardList', () => {
  it('no thumbnail: no media box, the KEY sits inline before the title', () => {
    const html = render(['p1'], [cardRow('p1', { title: 'Launch teaser' })]);
    expect(html).not.toContain('data-card-media');
    expect(html).not.toContain('aspect-[4/3]');
    expect(html).toMatch(/data-card-ref=""[^>]*>GBL-12<\/span>Launch teaser/);
  });

  it('thumbnail: 4:3 media box with KEY, format and slides pills; no inline KEY', () => {
    const html = render(['p1'], [cardRow('p1', { thumbnailAssetVersionId: 'v1', mediaCount: 3 })]);
    expect(html).toContain('data-card-media');
    expect(html).toContain('aspect-[4/3]');
    expect(html).toContain('GBL-12');
    expect(html).not.toContain('data-card-ref');
    expect(html).toContain('Carousel');
    expect(html).toContain('3 slides');
    expect(html).not.toContain('Reel');
  });

  it('video media shows the play pill: Reel for a video post', () => {
    const html = render(
      ['p1'],
      [
        cardRow('p1', {
          thumbnailAssetVersionId: 'v1',
          mediaCount: 1,
          hasVideo: true,
          format: 'video',
        }),
      ],
    );
    expect(html).toContain('Reel');
    expect(html).not.toContain('slides');
  });

  it('is a tappable dialog opener the bubble long-press ignores (data-msg-link)', () => {
    const html = render(['p1'], [cardRow('p1')]);
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('role="link"');
    expect(html).not.toMatch(/<a\b|href=/);
    expect(html).toContain('data-msg-link=""');
    expect(html).toContain('tabindex="0"');
    expect(POST_CARD).toContain('bg-panel');
  });

  it('renders no sheet until tapped, and never reaches for the router', () => {
    navigate.mockClear();
    const html = render(['p1'], [cardRow('p1', { stage: 'review' })], { side: 'client' });
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('data-post-sheet');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('review footer by side', () => {
    const post = [cardRow('p1', { stage: 'review' })];
    const client = render(['p1'], post, { side: 'client' });
    expect(client).toContain('Waiting on you');
    expect(client).toContain('Review');
    expect(client).toContain('text-accent');
    const agency = render(['p1'], post, { side: 'agency' });
    expect(agency).toContain('Waiting on client');
    expect(agency).toContain('>Open<');
    expect(render(['p1'], post, { side: 'unknown' })).toContain('In review');
  });

  it('approved footer: first name and time, else the stage date fallback', () => {
    const named = render(
      ['p1'],
      [
        cardRow('p1', {
          stage: 'approved',
          approved_by: 'u1',
          approved_at: '2026-09-21T14:05:00Z',
        }),
      ],
      {},
      new Map([['u1', 'Asha Rao']]),
    );
    expect(named).toContain('Approved by Asha · Sep 21 14:05');
    const fallback = render(['p1'], [cardRow('p1', { stage: 'approved' })]);
    expect(fallback).toContain('Approved · Sep 20');
  });

  it('shows the target date when set', () => {
    const html = render(['p1'], [cardRow('p1', { target_date: '2026-10-02T09:00:00Z' })]);
    expect(html).toMatch(/data-card-target="">Oct 2</);
  });

  it('preserves postIds order and keeps not-visible cards in place', () => {
    const html = render(['p3', 'p1', 'p2'], [cardRow('p1'), cardRow('p3')]);
    const p3 = html.indexOf('Post p3');
    const p1 = html.indexOf('Post p1');
    const hidden = html.indexOf(NOT_VISIBLE_TITLE);
    expect(p3).toBeGreaterThan(-1);
    expect(p3).toBeLessThan(p1);
    expect(p1).toBeLessThan(hidden);
  });

  it('the footer is a 44px row with a hairline top border', () => {
    const html = render(['p1'], [cardRow('p1')]);
    expect(html).toMatch(/data-card-footer=""[^>]*h-\[44px\][^>]*border-t border-border/);
    expect(CARD_SKELETON).toContain('w-[240px]');
  });
});

interface TableResult {
  data: unknown;
  error: { message: string } | null;
}

function makeClient(results: Record<string, TableResult>) {
  const from = vi.fn((table: string) => {
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'is', 'like', 'order']) b[method] = () => b;
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(results[table] ?? { data: [], error: null }).then(resolve);
    return b;
  });
  return { client: { from } as unknown as Client, from };
}

describe('loadPostCardBatch', () => {
  it('one batch = posts + attachments + ONE users read, regardless of card count', async () => {
    const { client, from } = makeClient({
      posts: {
        data: [
          { ...cardRow('p1', { approved_by: 'u1' }) },
          { ...cardRow('p2', { approved_by: 'u1' }) },
          { ...cardRow('p3', { approved_by: 'u2' }) },
        ],
        error: null,
      },
      asset_attachments: { data: [], error: null },
      users: {
        data: [{ id: 'u1', display_name: 'Asha Rao', avatar_url: null }],
        error: null,
      },
    });
    const batch = await loadPostCardBatch(client, 'ws', ['p1', 'p2', 'p3']);
    expect(from.mock.calls.map((c) => c[0])).toEqual(['posts', 'asset_attachments', 'users']);
    expect(batch?.posts).toHaveLength(3);
    expect(batch?.names.get('u1')).toBe('Asha Rao');
  });

  it('skips the name lookup when no post has an approver', async () => {
    const { client, from } = makeClient({
      posts: { data: [cardRow('p1')], error: null },
    });
    await loadPostCardBatch(client, 'ws', ['p1']);
    expect(from.mock.calls.map((c) => c[0])).toEqual(['posts', 'asset_attachments']);
  });

  it('returns null when the posts read fails', async () => {
    const { client } = makeClient({ posts: { data: null, error: { message: 'boom' } } });
    expect(await loadPostCardBatch(client, 'ws', ['p1'])).toBeNull();
  });
});

describe('cardTapHandlers', () => {
  it('a tap opens the sheet and does not navigate', () => {
    navigate.mockClear();
    const openSheet = vi.fn();
    cardTapHandlers(openSheet).onClick();
    expect(openSheet).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Enter opens the sheet (default prevented); other keys do nothing', () => {
    const openSheet = vi.fn();
    const handlers = cardTapHandlers(openSheet);
    const enter = { key: 'Enter', preventDefault: vi.fn() };
    handlers.onKeyDown(enter);
    expect(enter.preventDefault).toHaveBeenCalledTimes(1);
    expect(openSheet).toHaveBeenCalledTimes(1);
    const space = { key: 'a', preventDefault: vi.fn() };
    handlers.onKeyDown(space);
    expect(space.preventDefault).not.toHaveBeenCalled();
    expect(openSheet).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });
});
