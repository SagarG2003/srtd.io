import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { channelRowBody, DRAFT_PREFIX, rowDraft } from '@/components/chat/ChannelList';
import type { ChannelSummary } from '@/lib/chat-reads';

const channel: ChannelSummary = {
  channelId: 'c1',
  channelType: 'dm',
  title: 'Ana',
  avatarUrl: null,
  agoraGroupId: null,
  groupId: null,
  peerUserId: 'u2',
  createdAt: '2026-09-01T00:00:00Z',
};

describe('chat list draft preview', () => {
  it('shows a draft only for a chat that is not open', () => {
    expect(rowDraft('half typed', false)).toBe('half typed');
    expect(rowDraft('half typed', true)).toBeNull();
    expect(rowDraft('   ', false)).toBeNull();
  });

  it('reads "Draft: " in the accent at weight 500, then the draft text', () => {
    const html = renderToStaticMarkup(
      channelRowBody({
        channel,
        summary: undefined,
        draft: 'half typed',
        nowMs: 0,
        timeZone: 'UTC',
        selecting: false,
        checked: false,
        layout: 'touch',
      }),
    );
    expect(DRAFT_PREFIX).toBe('Draft: ');
    expect(html).toMatch(/<span class="text-accent font-medium">Draft: <\/span>half typed/);
    expect(html).not.toContain('No messages yet');
  });

  it('without a draft the preview is unchanged', () => {
    const html = renderToStaticMarkup(
      channelRowBody({
        channel,
        summary: undefined,
        nowMs: 0,
        timeZone: 'UTC',
        selecting: false,
        checked: false,
        layout: 'touch',
      }),
    );
    expect(html).toContain('No messages yet');
    expect(html).not.toContain(DRAFT_PREFIX);
  });
});
