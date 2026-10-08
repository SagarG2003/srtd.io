import { describe, expect, it } from 'vitest';
import { filterHelpArticles } from '@/components/pages/HelpPage';

const articles = [
  {
    id: 'brief',
    category: 'Briefs',
    title: 'Create a brief',
    content: 'Briefs are read-only after creation.',
  },
  {
    id: 'post',
    category: 'Posts & approvals',
    title: 'Review a post',
    content: 'Leave a comment to request a change.',
  },
] as const;

describe('filterHelpArticles', () => {
  it('filters by category', () => {
    expect(filterHelpArticles([...articles], 'Briefs', '').map((article) => article.id)).toEqual([
      'brief',
    ]);
  });

  it('searches article titles and content without case sensitivity', () => {
    expect(
      filterHelpArticles([...articles], 'All topics', 'REQUEST A CHANGE').map(
        (article) => article.id,
      ),
    ).toEqual(['post']);
  });

  it('combines category and search filters and returns no unrelated articles', () => {
    expect(filterHelpArticles([...articles], 'Briefs', 'comment')).toEqual([]);
  });
});
