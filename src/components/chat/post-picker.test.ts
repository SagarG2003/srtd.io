import { describe, expect, it } from 'vitest';
import type { PostCardFields } from '@srtdio/posts';
import {
  buildPickerSections,
  cursorAfter,
  hasMoreResults,
  isPostSelected,
  matchesLabel,
  olderApprovedFooter,
  parsePickerQuery,
  recentApprovedSince,
  searchExcludeStage,
  shownOfLabel,
  togglePost,
} from '@/components/chat/post-picker';
import { isAgencySide, isClient } from '@/components/pages/pcs/roles';
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

// Roles are resolved through the permission helper, never hardcoded here.
const roles: string[] = WorkspaceMemberSchema.shape.role.options;
const agency = roles.find((r) => isAgencySide(r)) ?? null;
const nonAgency = roles.find((r) => !isAgencySide(r)) ?? null;
// Built from its char code: chat files carry no literal hash sign.
const HASH = String.fromCharCode(35);

describe('parsePickerQuery', () => {
  it('reads bare digits as a post number and keeps the text match', () => {
    expect(parsePickerQuery('14', 'GBL')).toEqual({ text: '14', number: 14 });
  });

  it('strips this workspace key prefix, any case', () => {
    expect(parsePickerQuery('GBL-14', 'GBL')).toEqual({ text: 'GBL-14', number: 14 });
    expect(parsePickerQuery(' gbl-14 ', 'GBL')).toEqual({ text: 'gbl-14', number: 14 });
  });

  it('strips a leading hash sign', () => {
    expect(parsePickerQuery(`${HASH}14`, 'GBL')).toEqual({ text: `${HASH}14`, number: 14 });
  });

  it('treats words as text only', () => {
    expect(parsePickerQuery('holi', 'GBL')).toEqual({ text: 'holi', number: null });
  });

  it('does not strip another workspace key', () => {
    expect(parsePickerQuery('ABC-14', 'GBL')).toEqual({ text: 'ABC-14', number: null });
  });

  it('is null for blank input, and never yields number 0', () => {
    expect(parsePickerQuery('   ', 'GBL')).toBeNull();
    expect(parsePickerQuery('0', 'GBL')?.number).toBeNull();
    expect(parsePickerQuery('99999999999', null)?.number).toBeNull();
  });
});

describe('buildPickerSections', () => {
  const rows = { review: ['r'], approved: ['a'], drafts: ['d'] };

  it('orders waiting, approved (30 days), drafts for an agency-side viewer', () => {
    const sections = buildPickerSections({ role: agency, ...rows });
    expect(sections.map((s) => s.key)).toEqual(['review', 'approved', 'draft']);
    expect(sections.map((s) => s.label)).toEqual([
      'Waiting on client',
      'Approved in the last 30 days',
      'Drafts',
    ]);
  });

  it('says "Waiting on you" and has no Drafts for the client', () => {
    const client = roles.find((r) => isClient(r)) ?? null;
    const sections = buildPickerSections({ role: client, ...rows });
    expect(sections.map((s) => s.key)).toEqual(['review', 'approved']);
    expect(sections[0]?.label).toBe('Waiting on you');
  });

  it('drops empty sections', () => {
    const sections = buildPickerSections({ role: agency, review: [], approved: ['a'], drafts: [] });
    expect(sections.map((s) => s.key)).toEqual(['approved']);
  });
});

describe('search stage rule', () => {
  it('excludes drafts only for a non-agency viewer or an unknown role', () => {
    expect(searchExcludeStage(agency)).toBeUndefined();
    expect(searchExcludeStage(nonAgency)).toBe('draft');
    expect(searchExcludeStage(null)).toBe('draft');
  });
});

describe('labels', () => {
  it('footer omits at 0 and pluralises', () => {
    expect(olderApprovedFooter(0)).toBeNull();
    expect(olderApprovedFooter(1)).toBe(
      '1 older approved post · type a word or number to find one',
    );
    expect(olderApprovedFooter(212)).toBe(
      '212 older approved posts · type a word or number to find one',
    );
  });

  it('matches and paging text', () => {
    expect(matchesLabel(1)).toBe('1 match');
    expect(matchesLabel(120)).toBe('120 matches');
    expect(shownOfLabel(50, 120)).toBe('50 of 120');
    expect(hasMoreResults(50, 120)).toBe(true);
    expect(hasMoreResults(120, 120)).toBe(false);
  });

  it('recent window is 30 days back', () => {
    expect(recentApprovedSince(new Date('2026-09-28T00:00:00.000Z'))).toBe(
      '2026-08-29T00:00:00.000Z',
    );
  });
});

describe('cursorAfter', () => {
  it('is the (created_at, id) of the last row, or null for none', () => {
    expect(
      cursorAfter([
        { id: 'a', created_at: '2026-09-02T00:00:00Z' },
        { id: 'b', created_at: '2026-09-01T00:00:00Z' },
      ]),
    ).toEqual({ createdAt: '2026-09-01T00:00:00Z', id: 'b' });
    expect(cursorAfter([])).toBeNull();
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
