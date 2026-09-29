import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// ChannelList's import graph pulls the real agora-chat browser SDK; mock it.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import {
  CHANNEL_ROW_BUTTON,
  CHANNEL_TILE_GRID,
  ChannelCard,
  DEFAULT_LIST_INPUT,
  GROUP_TILE_PHOTO,
  TILE_NAME_TYPE,
  TILE_PREVIEW_TYPE,
  TILE_TIME_TYPE,
  channelListView,
  channelRowBody,
  channelRowClass,
  chatRowContextMenu,
  tileKind,
  unreadPillText,
  type ChannelListInput,
} from '@/components/chat/ChannelList';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { ConversationSummary } from '@/lib/chat/chat-store';

// The tile is token-only: every colour is a CSS variable the .dark class swaps,
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

function tile(
  channel: ChannelSummary,
  summary: ConversationSummary | undefined,
  state: { selected?: boolean; selecting?: boolean; checked?: boolean } = {},
): { cls: string; html: string; classes: string[] } {
  const selecting = state.selecting === true;
  const checked = state.checked === true;
  const html = renderToStaticMarkup(
    <>{channelRowBody({ channel, summary, nowMs: NOW, timeZone: 'UTC', selecting, checked })}</>,
  );
  return {
    html,
    // The snapshot pins class sets only (no inline avatar tint), in render order.
    classes: [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1] ?? ''),
    cls: channelRowClass({
      kind: tileKind(channel),
      selected: state.selected === true,
      selecting,
      checked,
    }),
  };
}

function tokenOnly(text: string): void {
  const banned = [`${'dark'}${':'}`, `bg-accent${'/'}`, `bg-fg-3${'/'}`, 'border-l-'];
  for (const literal of banned) expect(text).not.toContain(literal);
}

describe('chat home tile kind selection', () => {
  it('group channel -> wide, DM channel -> square', () => {
    expect(tileKind(group)).toBe('wide');
    expect(tileKind(dm)).toBe('square');
  });

  it('unread 0 -> no pill, unread 3 -> pill "3"', () => {
    expect(unreadPillText(0)).toBeNull();
    expect(unreadPillText(3)).toBe('3');
    expect(tile(dm, read).html).not.toContain('data-unread-pill');
    expect(tile(dm, { ...read, unread: 3 }).html).toMatch(/data-unread-pill="[^"]*"[^>]*>3</);
    expect(tile(group, read).html).not.toContain('data-unread-pill');
    expect(tile(group, { ...read, unread: 3 }).html).toMatch(/data-unread-pill="[^"]*"[^>]*>3</);
  });

  it('wide tiles span both columns; square tiles take one', () => {
    const tree = channelListView({
      channels: [group, dm],
      hasChannels: true,
      selectedChannelId: null,
      onSelect: () => {},
      onNewChat: () => {},
    });
    const items = (tree.props as { children: ReactElement<{ className: string }>[] }).children;
    expect(items[0]!.props.className).toContain('col-span-2');
    expect(items[1]!.props.className).not.toContain('col-span-2');
    expect((tree.props as { className: string }).className).toBe(CHANNEL_TILE_GRID);
  });
});

describe('chat home tile', () => {
  it('square DM: 170 tall column, 48px disc, 2-line preview, pill capped at 99+', () => {
    const t = tile(dm, { ...read, unread: 120 });
    expect(t.cls).toContain('h-[170px]');
    expect(t.cls).toContain('flex-col');
    expect(t.cls).toContain('bg-panel');
    expect(t.cls.split(' ')).toEqual(expect.arrayContaining(['border', 'border-border']));
    expect(t.cls).toContain('rounded-[14px]');
    expect(t.html).toContain('width:48px;height:48px');
    expect(t.html).toContain('line-clamp-2');
    expect(t.html).toContain('mt-auto');
    expect(t.html).toContain('>99+<');
    tokenOnly(t.cls + t.html);
    expect({ tile: t.cls, classes: t.classes }).toMatchSnapshot();
  });

  it('wide group: 120 tall row, 72px rounded-square photo, 3-line preview, pill after time', () => {
    const t = tile(group, { ...read, unread: 3 });
    expect(t.cls).toContain('h-[120px]');
    expect(t.cls).not.toContain('flex-col');
    expect(t.html).toContain(
      `data-group-photo="" class="${GROUP_TILE_PHOTO.replaceAll('&', '&amp;').replaceAll('>', '&gt;')}"`,
    );
    expect(GROUP_TILE_PHOTO).toContain('[&>*]:!h-[72px] [&>*]:!w-[72px] [&>*]:!rounded-[14px]');
    expect(t.html).toContain('line-clamp-3');
    expect(t.html.indexOf('data-unread-pill')).toBeGreaterThan(t.html.indexOf(TILE_TIME_TYPE));
    tokenOnly(t.cls + t.html);
    expect({ tile: t.cls, classes: t.classes }).toMatchSnapshot();
  });

  it('selected (desktop active): panel-2 fill', () => {
    const t = tile(dm, read, { selected: true });
    expect(t.cls).toContain('bg-panel-2');
    expect(t.cls).not.toContain('bg-accent-soft');
    tokenOnly(t.cls + t.html);
  });

  it('checked in select mode: accent tint and the on select circle', () => {
    const t = tile(dm, read, { selecting: true, checked: true });
    expect(t.cls).toContain('bg-accent-soft');
    expect(t.html).toContain('data-select-check="on"');
    tokenOnly(t.cls + t.html);
  });

  it('empty preview: "No messages yet" in tertiary ink; group initials fallback', () => {
    const t = tile(group, undefined);
    expect(t.html).toContain('No messages yet');
    expect(t.html).toContain('text-fg-3');
    expect(t.html).toContain('>L<');
    tokenOnly(t.cls + t.html);
  });

  it('name truncates and previews clamp, so text never overflows the tile', () => {
    for (const c of [dm, group]) {
      const html = tile(c, read).html;
      expect(html).toContain(`min-w-0 truncate text-fg ${TILE_NAME_TYPE}`);
      expect(html).toContain(TILE_PREVIEW_TYPE);
      expect(html).toContain('break-words');
    }
  });

  it('"You: " prefix is unchanged', () => {
    expect(tile(dm, { ...read, lastMessagePrefix: 'You' }).html).toContain('You: See you then');
  });
});

describe('D7: chat home tiles never select text or show the callout', () => {
  it('the tile button carries select-none and the no-callout class', () => {
    for (const cls of ['select-none', '[-webkit-touch-callout:none]']) {
      expect(tile(dm, read).cls.split(' ')).toContain(cls);
      expect(CHANNEL_ROW_BUTTON.split(' ')).toContain(cls);
    }
  });

  it('contextmenu default is prevented on a coarse pointer only', () => {
    const preventDefault = vi.fn();
    chatRowContextMenu(true)?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(chatRowContextMenu(false)).toBeUndefined();
  });
});

describe('G1: one layout listener per ChannelList, not one per tile', () => {
  function cards(input?: ChannelListInput): ReactElement<Record<string, unknown>>[] {
    const tree = channelListView({
      channels: [dm, group],
      hasChannels: true,
      selectedChannelId: null,
      onSelect: () => {},
      onNewChat: () => {},
      ...(input !== undefined ? { input } : {}),
    });
    const out: ReactElement<Record<string, unknown>>[] = [];
    const walk = (n: ReactNode): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!isValidElement(n)) return;
      if (n.type === ChannelCard) out.push(n as ReactElement<Record<string, unknown>>);
      walk((n.props as { children?: ReactNode }).children);
    };
    walk(tree);
    return out;
  }

  it("every tile gets the list's one input object", () => {
    const input: ChannelListInput = { layout: 'laptop', hoverMenu: true, coarsePointer: false };
    const tiles = cards(input);
    expect(tiles).toHaveLength(2);
    for (const card of tiles) expect(card.props.input).toBe(input);
    for (const card of cards()) expect(card.props.input).toBe(DEFAULT_LIST_INPUT);
  });

  it('ChannelCard reads no media query or layout hook of its own, and opens as "Open <name>"', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./ChannelList.tsx', import.meta.url)),
      'utf8',
    );
    const card = source.slice(
      source.indexOf('export function ChannelCard('),
      source.indexOf('interface ChannelListContentProps'),
    );
    expect(card).not.toContain('useChatLayout(');
    expect(card).not.toContain('useMediaQuery(');
    expect(card).toContain('aria-label={`Open ${channel.title}`}');
    // The list reads them once.
    const list = source.slice(source.indexOf('export function ChannelList('));
    expect(list).toContain('useChannelListInput()');
  });
});
