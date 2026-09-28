import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { Result } from '@srtdio/rpc';

// The provider's import graph pulls the real agora-chat browser SDK. Mock it so
// importing it in node never touches browser globals, mirroring ChatShell.test.tsx.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { loadChatList, type ChatListReaders } from '@/components/chat/ChatStoreProvider';
import { ChannelCard, channelListContent } from '@/components/chat/ChannelList';
import { EmptyState } from '@/components/ui/EmptyState';
import type { ChannelSummary } from '@/lib/chat-reads';
import {
  beginLoad,
  initialState,
  loadScope,
  selectConversation,
  selectHidden,
  selectLoadStatus,
  type ChatStoreState,
} from '@/lib/chat/chat-store';

const ME = 'me';
const SCOPE = loadScope('w1', ME);

function channel(channelId: string, createdAt: string): ChannelSummary {
  return {
    channelId,
    channelType: 'group',
    title: channelId,
    avatarUrl: null,
    agoraGroupId: `ag-${channelId}`,
    groupId: `g-${channelId}`,
    peerUserId: null,
    createdAt,
  };
}

function ok<T>(data: T): Promise<Result<T>> {
  return Promise.resolve({ ok: true, data });
}

function failed<T>(): Promise<Result<T>> {
  return Promise.resolve({ ok: false, error: { code: 'unknown', message: 'boom' } });
}

// 'old' was created first but has the newest message; 'cleared' was deleted
// for the caller after its last message.
function readers(over: Partial<ChatListReaders> = {}): ChatListReaders {
  return {
    roster: () =>
      ok([
        channel('new', '2026-01-03T00:00:00Z'),
        channel('cleared', '2026-01-02T00:00:00Z'),
        channel('old', '2026-01-01T00:00:00Z'),
      ]),
    clears: () => ok([{ channelId: 'cleared', clearedAt: '2026-02-01T00:00:00Z' }]),
    previews: () =>
      ok([
        {
          channelId: 'old',
          messageId: 'm1',
          senderUserId: 'x',
          body: 'latest',
          hasAttachments: false,
          createdAt: '2026-03-01T00:00:00Z',
        },
        {
          channelId: 'new',
          messageId: 'm2',
          senderUserId: ME,
          body: 'earlier',
          hasAttachments: false,
          createdAt: '2026-02-15T00:00:00Z',
        },
        {
          channelId: 'cleared',
          messageId: 'm3',
          senderUserId: 'x',
          body: 'gone',
          hasAttachments: false,
          createdAt: '2026-01-20T00:00:00Z',
        },
      ]),
    counts: () =>
      ok([
        { channelId: 'old', unread: 2, lastMessageAt: '2026-03-01T00:00:00Z' },
        { channelId: 'cleared', unread: 1, lastMessageAt: '2026-01-20T00:00:00Z' },
      ]),
    ...over,
  };
}

function isElement(node: ReactNode): node is ReactElement {
  return typeof node === 'object' && node !== null && 'props' in node;
}

function collect(node: ReactNode, found: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, found));
    return;
  }
  if (!isElement(node)) return;
  found.push(node);
  collect((node.props as { children?: ReactNode }).children, found);
}

function findAll(tree: ReactNode, predicate: (el: ReactElement) => boolean): ReactElement[] {
  const all: ReactElement[] = [];
  collect(tree, all);
  return all.filter(predicate);
}

/** Render the list body exactly as ChannelList wires it from the store. */
function paint(state: ChatStoreState, scope: string, onRetry: () => void = () => {}): ReactElement {
  const status = selectLoadStatus(state, scope);
  return channelListContent({
    channels: status === 'ready' ? state.roster : [],
    status,
    onRetry,
    selectedChannelId: null,
    onSelect: () => {},
    onNewChat: () => {},
    search: '',
    onSearchChange: () => {},
    summaryFor: (id) => selectConversation(state, id),
    isHidden: (id) => selectHidden(state, id),
  });
}

function rowIds(tree: ReactElement): string[] {
  return findAll(tree, (el) => el.type === ChannelCard).map(
    (el) => (el.props as { channel: ChannelSummary }).channel.channelId,
  );
}

function skeletonRows(tree: ReactElement): ReactElement[] {
  return findAll(
    tree,
    (el) => (el.props as Record<string, unknown>)['data-skeleton-row'] !== undefined,
  );
}

describe('loadChatList', () => {
  it('starts all four reads before any resolves (parallel, no extra round trip)', async () => {
    const started: string[] = [];
    const base = readers();
    const tracked: ChatListReaders = {
      roster: () => (started.push('roster'), base.roster()),
      clears: () => (started.push('clears'), base.clears()),
      previews: () => (started.push('previews'), base.previews()),
      counts: () => (started.push('counts'), base.counts()),
    };
    const pending = loadChatList(tracked, SCOPE, ME);
    expect(started.sort()).toEqual(['clears', 'counts', 'previews', 'roster']);
    await pending;
  });

  it('never exposes a ready roster before clears are applied', async () => {
    const loading = beginLoad(initialState(), SCOPE);
    expect(selectLoadStatus(loading, SCOPE)).toBe('loading');
    expect(loading.roster).toEqual([]);

    const ready = (await loadChatList(readers(), SCOPE, ME))(loading);
    expect(ready.status).toBe('ready');
    expect(ready.clears['cleared']).toBe(Date.parse('2026-02-01T00:00:00Z'));
    expect(selectHidden(ready, 'cleared')).toBe(true);
    expect(selectConversation(ready, 'cleared')?.unread).toBe(0);
  });

  it('a cleared channel never appears in the first rendered list', async () => {
    const loading = beginLoad(initialState(), SCOPE);
    expect(rowIds(paint(loading, SCOPE))).toEqual([]);
    const ready = (await loadChatList(readers(), SCOPE, ME))(loading);
    expect(rowIds(paint(ready, SCOPE))).not.toContain('cleared');
  });

  it('the first ready list is already recency-sorted', async () => {
    const ready = (await loadChatList(readers(), SCOPE, ME))(beginLoad(initialState(), SCOPE));
    // createdAt order would be new, old; recency puts old (newest message) first.
    expect(rowIds(paint(ready, SCOPE))).toEqual(['old', 'new']);
  });

  it.each(['roster', 'clears', 'previews', 'counts'] as const)(
    'a failed %s read renders the error state with Retry, never a partial list',
    async (which) => {
      const failing: Partial<ChatListReaders> = { [which]: () => failed() };
      const state = (await loadChatList(readers(failing), SCOPE, ME))(
        beginLoad(initialState(), SCOPE),
      );
      expect(state.status).toBe('error');
      const onRetry = vi.fn();
      const tree = paint(state, SCOPE, onRetry);
      expect(rowIds(tree)).toEqual([]);
      const empties = findAll(tree, (el) => el.type === EmptyState);
      expect(empties).toHaveLength(1);
      expect((empties[0]!.props as { title: string }).title).toBe("Couldn't load conversations");
      const retry = findAll(
        (empties[0]!.props as { action: ReactNode }).action,
        (el) => (el.props as { children?: unknown }).children === 'Retry',
      );
      expect(retry).toHaveLength(1);
      (retry[0]!.props as { onClick: () => void }).onClick();
      expect(onRetry).toHaveBeenCalledTimes(1);
    },
  );

  it('Retry reloads: error, then skeleton, then the ready list', async () => {
    const errored = (await loadChatList(readers({ clears: () => failed() }), SCOPE, ME))(
      beginLoad(initialState(), SCOPE),
    );
    const retrying = beginLoad(errored, SCOPE);
    expect(skeletonRows(paint(retrying, SCOPE)).length).toBeGreaterThan(0);
    const ready = (await loadChatList(readers(), SCOPE, ME))(retrying);
    expect(rowIds(paint(ready, SCOPE))).toEqual(['old', 'new']);
  });

  it('a workspace switch shows skeleton, never the prior workspace rows', async () => {
    const ready = (await loadChatList(readers(), SCOPE, ME))(beginLoad(initialState(), SCOPE));
    const next = loadScope('w2', ME);
    // Before the switch effect runs, the prior state is read under the new scope.
    const firstPaint = paint(ready, next);
    expect(rowIds(firstPaint)).toEqual([]);
    expect(skeletonRows(firstPaint).length).toBeGreaterThan(0);
    const switching = beginLoad(ready, next);
    expect(switching.roster).toEqual([]);
    expect(rowIds(paint(switching, next))).toEqual([]);
  });

  it('a stale response for a previous workspace is ignored', async () => {
    const transition = await loadChatList(readers(), SCOPE, ME);
    const moved = beginLoad(initialState(), loadScope('w2', ME));
    expect(transition(moved)).toBe(moved);
  });
});
