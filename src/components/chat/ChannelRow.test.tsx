import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// ChannelList's import graph pulls the real agora-chat browser SDK; mock it.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { channelRowBody, channelRowClass } from '@/components/chat/ChannelList';
import {
  CHAT_LIST_NAME_TYPE,
  CHAT_LIST_PREVIEW_TYPE,
  CHAT_LIST_TIME_TYPE,
  chatLayout,
  type ChatLayout,
} from '@/components/chat/chat-type';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { ConversationSummary } from '@/lib/chat/chat-store';

// The row is token-only: every colour is a CSS variable the .dark class swaps,
// so one class set serves light and dark. The snapshots pin that set; the
// assertions below check no theme-specific literal ever slips in.
const NOW = Date.parse('2026-09-28T10:00:00Z');

const dm: ChannelSummary = {
  channelId: 'c1',
  channelType: 'dm',
  title: 'Asha Rao',
  avatarUrl: null,
  agoraGroupId: null,
  groupId: null,
  peerUserId: 'u2',
  createdAt: 't',
};
const group: ChannelSummary = { ...dm, channelId: 'g1', channelType: 'group', title: 'Launch' };

const read: ConversationSummary = {
  lastMessageText: 'See you then',
  lastMessageTs: Date.parse('2026-09-28T09:00:00Z'),
  unread: 0,
};

function row(
  channel: ChannelSummary,
  summary: ConversationSummary | undefined,
  state: { selected?: boolean; selecting?: boolean; checked?: boolean } = {},
): { cls: string; html: string; classes: string[] } {
  const selecting = state.selecting === true;
  const checked = state.checked === true;
  const html = renderToStaticMarkup(
    <>
      {channelRowBody({
        channel,
        summary,
        nowMs: NOW,
        timeZone: 'UTC',
        selecting,
        checked,
        layout: 'touch',
      })}
    </>,
  );
  return {
    html,
    // The snapshot pins class sets only (no inline avatar tint), in render order.
    classes: [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1] ?? ''),
    cls: channelRowClass({
      selected: state.selected === true,
      unread: (summary?.unread ?? 0) > 0,
      selecting,
      checked,
    }),
  };
}

function tokenOnly(text: string): void {
  const banned = [`${'dark'}${':'}`, `bg-accent${'/'}`, `bg-fg-3${'/'}`, 'border-l-', 'rounded-xl'];
  for (const literal of banned) expect(text).not.toContain(literal);
}

describe('ChannelList dense row', () => {
  it('unread: accent tint, bold name, accent time, count badge', () => {
    const r = row(dm, { ...read, unread: 120 });
    expect(r.cls).toContain('bg-accent-soft');
    expect(r.html).toContain('font-semibold');
    expect(r.html).toContain('text-accent');
    expect(r.html).toContain('>99+<');
    tokenOnly(r.cls + r.html);
    expect({ row: r.cls, classes: r.classes }).toMatchSnapshot();
  });

  it('selected (desktop active): panel-2, medium name, no badge', () => {
    const r = row(dm, read, { selected: true });
    expect(r.cls).toContain('bg-panel-2');
    expect(r.cls).not.toContain('bg-accent-soft');
    expect(r.html).toContain('font-medium');
    expect(r.html).not.toContain('bg-accent ');
    tokenOnly(r.cls + r.html);
    expect({ row: r.cls, classes: r.classes }).toMatchSnapshot();
  });

  it('checked in select mode: accent tint and the on select circle', () => {
    const r = row(dm, read, { selecting: true, checked: true });
    expect(r.cls).toContain('bg-accent-soft');
    expect(r.html).toContain('data-select-check="on"');
    tokenOnly(r.cls + r.html);
    expect({ row: r.cls, classes: r.classes }).toMatchSnapshot();
  });

  it('empty preview: "No messages yet" in tertiary ink, not italic; group glyph avatar', () => {
    const r = row(group, undefined);
    expect(r.html).toContain('No messages yet');
    expect(r.html).toContain('text-fg-3');
    expect(r.html).not.toContain('italic');
    expect(r.html).toContain('data-group-avatar');
    tokenOnly(r.cls + r.html);
    expect({ row: r.cls, classes: r.classes }).toMatchSnapshot();
  });

  it('rows carry the dense box: full width, bottom rule, no card rail', () => {
    const r = row(dm, read);
    expect(r.cls).toContain('w-full');
    expect(r.cls).toContain('border-b border-border');
    expect(r.cls).toContain('hover:bg-panel-2');
  });
});

describe('R2: chat list sizes follow the input, as the thread', () => {
  function listHtml(layout: ChatLayout): string {
    return renderToStaticMarkup(
      <>
        {channelRowBody({
          channel: dm,
          summary: { ...read, unread: 2 },
          nowMs: NOW,
          timeZone: 'UTC',
          selecting: false,
          checked: false,
          layout,
        })}
      </>,
    );
  }

  it('coarse pointer at 1024 (iPad) takes the touch list sizes', () => {
    const html = listHtml(chatLayout({ finePointer: false, widthPx: 1024 }));
    expect(html).toContain(CHAT_LIST_NAME_TYPE.touch);
    expect(html).toContain(CHAT_LIST_PREVIEW_TYPE.touch);
    expect(html).toContain(CHAT_LIST_TIME_TYPE.touch);
    expect(html).not.toContain('md:');
  });

  it('fine pointer at 1280 takes the laptop list sizes', () => {
    const html = listHtml(chatLayout({ finePointer: true, widthPx: 1280 }));
    expect(html).toContain(CHAT_LIST_NAME_TYPE.laptop);
    expect(html).toContain(CHAT_LIST_PREVIEW_TYPE.laptop);
    expect(html).toContain(CHAT_LIST_TIME_TYPE.laptop);
    expect(html).not.toContain('md:');
  });
});
