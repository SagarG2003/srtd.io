import { describe, expect, it } from 'vitest';
import type { PostCardFields } from '@srtdio/posts';
import {
  DEFAULT_POST_FILTER,
  POST_FILTERS,
  filterStage,
  isPostSelected,
  togglePost,
  visiblePostFilters,
} from '@/components/chat/post-picker';
import { isAgencySide } from '@/components/pages/pcs/roles';
import { WorkspaceMemberSchema } from '@srtdio/schemas';

function post(id: string, over: Partial<PostCardFields> = {}): PostCardFields {
  return {
    id,
    title: `Post ${id}`,
    platform: 'instagram',
    format: 'reel',
    stage: 'review',
    ...over,
  };
}

describe('post filter chips', () => {
  it('offers Drafts / Review / Approved / All posts in order and defaults to Review', () => {
    expect(POST_FILTERS.map((f) => f.key)).toEqual(['draft', 'review', 'approved', 'all']);
    expect(POST_FILTERS.map((f) => f.label)).toEqual(['Drafts', 'Review', 'Approved', 'All posts']);
    expect(DEFAULT_POST_FILTER).toBe('review');
  });

  it('maps a chip to its stage filter; All posts passes no stage (RLS bounds it)', () => {
    expect(filterStage('draft')).toBe('draft');
    expect(filterStage('review')).toBe('review');
    expect(filterStage('approved')).toBe('approved');
    expect(filterStage('all')).toBeUndefined();
  });
});

describe('visiblePostFilters', () => {
  // Roles are resolved through the permission helper, never hardcoded here: pick
  // one the helper says can see drafts and one it says cannot.
  const roles: string[] = WorkspaceMemberSchema.shape.role.options;
  const canSee = roles.find((r) => isAgencySide(r));
  const cannotSee = roles.find((r) => !isAgencySide(r));

  it('shows Drafts first for a role the permission helper lets see drafts', () => {
    expect(canSee).toBeDefined();
    expect(visiblePostFilters(canSee ?? null).map((f) => f.key)).toEqual([
      'draft',
      'review',
      'approved',
      'all',
    ]);
  });

  it('hides Drafts for a role the helper excludes, and while the role is unknown', () => {
    expect(cannotSee).toBeDefined();
    for (const role of [cannotSee ?? null, null]) {
      expect(visiblePostFilters(role).map((f) => f.key)).toEqual(['review', 'approved', 'all']);
    }
  });

  it('never hides the default filter', () => {
    for (const role of [...roles, null]) {
      expect(visiblePostFilters(role).some((f) => f.key === DEFAULT_POST_FILTER)).toBe(true);
    }
  });
});

describe('togglePost', () => {
  it('adds a post when absent and removes it when present (by id)', () => {
    const a = post('a');
    const b = post('b');
    const afterAdd = togglePost([a], b);
    expect(afterAdd.map((p) => p.id)).toEqual(['a', 'b']);

    const afterRemove = togglePost(afterAdd, a);
    expect(afterRemove.map((p) => p.id)).toEqual(['b']);
  });

  it('does not mutate the input array', () => {
    const selected = [post('a')];
    togglePost(selected, post('b'));
    expect(selected.map((p) => p.id)).toEqual(['a']);
  });

  it('isPostSelected reflects membership by id', () => {
    expect(isPostSelected([post('a')], 'a')).toBe(true);
    expect(isPostSelected([post('a')], 'b')).toBe(false);
  });
});
