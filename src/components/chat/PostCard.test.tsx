import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotVisibleCard, SHARED_CARD } from '@/components/chat/PostCard';
import { NOT_VISIBLE_BODY, NOT_VISIBLE_TITLE } from '@/components/chat/post-card';

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
