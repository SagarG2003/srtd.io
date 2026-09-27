import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// ChannelList now consumes the chat store, whose provider import graph pulls the
// real agora-chat browser SDK. Mock it so importing the (hookless) view helpers
// in node never touches browser globals, mirroring ChatShell.test.tsx.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  ChannelCard,
  channelListContent,
  channelListView,
  visibleChannels,
  type ChannelSelectMode,
} from '@/components/chat/ChannelList';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import type { ChannelSummary } from '@/lib/chat-reads';

function summary(over: Partial<ChannelSummary>): ChannelSummary {
  return {
    channelId: 'c1',
    channelType: 'group',
    title: 'Team',
    avatarUrl: null,
    agoraGroupId: 'ag1',
    groupId: 'g1',
    peerUserId: null,
    createdAt: 't',
    ...over,
  };
}

// channelListContent/channelListView are pure (no hooks), so they are called as
// functions and their element tree walked without a DOM, mirroring the
// SectionHeader/SortMenu test style in this codebase.
function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

// SectionHeader is hookless and holds search/primaryAction in props, so it is
// expanded by calling its render once (mirroring SectionHeader's own tests).
function expandSectionHeader(el: ReactElement): ReactElement {
  return (el.type as unknown as (props: unknown) => ReactElement)(el.props);
}

function collect(node: ReactNode, found: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, found));
    return;
  }
  if (!isElement(node)) return;
  found.push(node);
  if (node.type === SectionHeader) {
    collect(expandSectionHeader(node), found);
    return;
  }
  collect((node.props as { children?: ReactNode }).children, found);
}

function findAll(tree: ReactNode, predicate: (el: ReactElement) => boolean): ReactElement[] {
  const all: ReactElement[] = [];
  collect(tree, all);
  return all.filter(predicate);
}

function texts(tree: ReactNode): string[] {
  const out: string[] = [];
  const all: ReactElement[] = [];
  collect(tree, all);
  for (const el of all) {
    const child = (el.props as { children?: ReactNode }).children;
    if (typeof child === 'string') out.push(child);
  }
  return out;
}

function ariaLabel(el: ReactElement): string | undefined {
  return (el.props as { 'aria-label'?: string })['aria-label'];
}

function content(over: {
  channels: ChannelSummary[];
  search?: string;
  onNewChat?: () => void;
  onSearchChange?: (value: string) => void;
}): ReactElement {
  return channelListContent({
    channels: over.channels,
    selectedChannelId: null,
    onSelect: () => {},
    onNewChat: over.onNewChat ?? (() => {}),
    search: over.search ?? '',
    onSearchChange: over.onSearchChange ?? (() => {}),
  });
}

describe('channelListView', () => {
  it('renders the zero-state with a New chat action when no conversations exist', () => {
    const view = channelListView({
      channels: [],
      hasChannels: false,
      selectedChannelId: null,
      onSelect: () => {},
      onNewChat: () => {},
    });
    expect(view.type).toBe(EmptyState);
    const props = view.props as { title: string; action?: unknown };
    expect(props.title).toBe('No conversations yet');
    expect(props.action).toBeDefined();
  });

  it('renders a distinct No matches state, not the zero-state, when search hides all', () => {
    const view = channelListView({
      channels: [],
      hasChannels: true,
      selectedChannelId: null,
      onSelect: () => {},
      onNewChat: () => {},
    });
    expect(view.type).not.toBe(EmptyState);
    expect(texts(view)).toContain('No matches');
  });

  it('renders one row per channel when there are matches', () => {
    const view = channelListView({
      channels: [summary({ channelId: 'a' }), summary({ channelId: 'b' })],
      hasChannels: true,
      selectedChannelId: 'a',
      onSelect: () => {},
      onNewChat: () => {},
    });
    expect(view.type).toBe('ul');
    const children = (view.props as { children: ReactElement[] }).children;
    expect(children).toHaveLength(2);
  });
});

describe('channelListContent', () => {
  const channels = [
    summary({ channelId: 'a', title: 'Design team' }),
    summary({ channelId: 'b', title: 'Client Acme' }),
  ];

  it('filters the conversation list by name and restores all on empty query', () => {
    const lists = findAll(content({ channels, search: 'acme' }), (el) => el.type === 'ul');
    expect((lists[0]!.props as { children: ReactElement[] }).children).toHaveLength(1);

    const allLists = findAll(content({ channels, search: '' }), (el) => el.type === 'ul');
    expect((allLists[0]!.props as { children: ReactElement[] }).children).toHaveLength(2);
  });

  it('shows No matches (not the zero-state) when a search matches nothing', () => {
    const tree = content({ channels, search: 'zzz' });
    expect(findAll(tree, (el) => el.type === EmptyState)).toHaveLength(0);
    expect(texts(tree)).toContain('No matches');
  });

  it('still shows the zero-state with New chat when there are no channels', () => {
    const tree = content({ channels: [], search: '' });
    const empties = findAll(tree, (el) => el.type === EmptyState);
    expect(empties).toHaveLength(1);
    expect((empties[0]!.props as { title: string }).title).toBe('No conversations yet');
  });

  it('fires onNewChat from the header "+" action', () => {
    const onNewChat = vi.fn();
    const tree = content({ channels, onNewChat });
    const buttons = findAll(tree, (el) => ariaLabel(el) === 'New chat');
    expect(buttons).toHaveLength(1);
    (buttons[0]!.props as { onClick: () => void }).onClick();
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('renders exactly one header and no "Chat" title text', () => {
    const tree = content({ channels });
    expect(findAll(tree, (el) => el.type === SectionHeader)).toHaveLength(1);
    expect(findAll(tree, (el) => el.type === 'h2')).toHaveLength(0);
    expect(texts(tree)).not.toContain('Chat');
  });
});

describe('hidden chats (deleted for me)', () => {
  const channels = [
    summary({ channelId: 'a', title: 'Design team' }),
    summary({ channelId: 'h', title: 'Hidden peer', channelType: 'dm' }),
  ];
  const isHidden = (id: string): boolean => id === 'h';
  const none = (): undefined => undefined;

  it('leaves a hidden chat out of the plain list', () => {
    expect(visibleChannels(channels, none, isHidden, '').map((c) => c.channelId)).toEqual(['a']);
  });

  it('search still finds a hidden chat', () => {
    expect(visibleChannels(channels, none, isHidden, 'hidden').map((c) => c.channelId)).toEqual([
      'h',
    ]);
  });

  it('renders only the visible rows and the zero-state when every chat is hidden', () => {
    const tree = channelListContent({
      channels,
      selectedChannelId: null,
      onSelect: () => {},
      onNewChat: () => {},
      search: '',
      onSearchChange: () => {},
      isHidden,
    });
    const lists = findAll(tree, (el) => el.type === 'ul');
    expect((lists[0]!.props as { children: ReactElement[] }).children).toHaveLength(1);

    const allHidden = channelListContent({
      channels,
      selectedChannelId: null,
      onSelect: () => {},
      onNewChat: () => {},
      search: '',
      onSearchChange: () => {},
      isHidden: () => true,
    });
    expect(findAll(allHidden, (el) => el.type === EmptyState)).toHaveLength(1);
  });
});

describe('select mode', () => {
  const channels = [
    summary({ channelId: 'a', title: 'Design team' }),
    summary({ channelId: 'b', title: 'Client Acme' }),
  ];

  function select(over: Partial<ChannelSelectMode>): ChannelSelectMode {
    return {
      active: false,
      selectedIds: new Set(),
      onStart: vi.fn(),
      onCancel: vi.fn(),
      onToggle: vi.fn(),
      onDelete: vi.fn(),
      ...over,
    };
  }

  function tree(mode: ChannelSelectMode): ReactElement {
    return channelListContent({
      channels,
      selectedChannelId: null,
      onSelect: () => {},
      onNewChat: () => {},
      search: '',
      onSearchChange: () => {},
      select: mode,
    });
  }

  it('offers Select next to search and new chat, which starts select mode', () => {
    const mode = select({});
    const buttons = findAll(tree(mode), (el) => texts(el).includes('Select'));
    const selectButton = buttons.find(
      (el) => (el.props as { children?: unknown }).children === 'Select',
    );
    expect(selectButton).toBeDefined();
    (selectButton!.props as { onClick: () => void }).onClick();
    expect(mode.onStart).toHaveBeenCalledTimes(1);
    expect(findAll(tree(mode), (el) => ariaLabel(el) === 'New chat')).toHaveLength(1);
  });

  it('in select mode shows N selected + Cancel, checks rows, and taps toggle', () => {
    const mode = select({ active: true, selectedIds: new Set(['b']) });
    const t = tree(mode);
    expect(texts(t)).toContain('1 selected');
    expect(texts(t)).toContain('Cancel');
    expect(findAll(t, (el) => el.type === SectionHeader)).toHaveLength(0);
    const cards = findAll(t, (el) => el.type === ChannelCard);
    expect(cards.map((c) => (c.props as { checked?: boolean }).checked)).toEqual([false, true]);
    (cards[0]!.props as { onToggle: (id: string) => void }).onToggle('a');
    expect(mode.onToggle).toHaveBeenCalledWith('a');
  });

  it('the bottom Delete is disabled at 0 and opens the confirm otherwise', () => {
    const deleteOf = (t: ReactElement): ReactElement =>
      findAll(t, (el) => {
        const c = (el.props as { children?: unknown }).children;
        return Array.isArray(c) && c.includes('Delete');
      })[0]!;
    const empty = select({ active: true });
    expect((deleteOf(tree(empty)).props as { disabled: boolean }).disabled).toBe(true);
    const some = select({ active: true, selectedIds: new Set(['a']) });
    const button = deleteOf(tree(some));
    expect((button.props as { disabled: boolean }).disabled).toBe(false);
    (button.props as { onClick: () => void }).onClick();
    expect(some.onDelete).toHaveBeenCalledTimes(1);
  });

  it('no long-press menu on rows while selecting', () => {
    const t = channelListContent({
      channels,
      selectedChannelId: null,
      onSelect: () => {},
      onNewChat: () => {},
      search: '',
      onSearchChange: () => {},
      select: select({ active: true }),
      onLongPress: () => {},
    });
    const cards = findAll(t, (el) => el.type === ChannelCard);
    expect(
      cards.every((c) => (c.props as { onLongPress?: unknown }).onLongPress === undefined),
    ).toBe(true);
  });
});
