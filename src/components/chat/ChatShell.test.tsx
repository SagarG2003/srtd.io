import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// The shell's import graph pulls the message factory, which imports the real
// agora-chat browser SDK. Mock it so importing the shell in node never touches
// browser globals or the network.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import {
  ChatShell,
  ChatStatusBanner,
  ConnectionBanner,
  GatedConnectionBanner,
  connectionBannerAction,
  connectionBannerText,
} from '@/components/chat/ChatShell';
import { INITIAL_CHAT_STATUS } from '@/lib/chat/use-chat-client';
import { ChatConnected } from '@/components/chat/ChatConnected';
import { ChatUnavailable, chatUnavailableView } from '@/components/chat/ChatUnavailable';
import { EmptyState } from '@/components/ui/EmptyState';

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

function find(tree: ReactNode, predicate: (el: ReactElement) => boolean): ReactElement[] {
  const all: ReactElement[] = [];
  collect(tree, all);
  return all.filter(predicate);
}

describe('ChatShell status dispatch', () => {
  it('renders the full unavailable panel only when there is no workspace or user', () => {
    const render = () =>
      ChatShell({ status: 'unavailable', client: null, workspaceId: '', currentUserId: '' });
    expect(render).not.toThrow();
    expect(render().type).toBe(ChatUnavailable);
  });

  it('keeps the Postgres chat surface (list, history, sending) mounted when chat is unavailable or kicked', () => {
    for (const status of ['unavailable', 'kicked'] as const) {
      const view = ChatShell({ status, client: null, workspaceId: 'w', currentUserId: 'u' });
      const connected = find(view, (el) => el.type === ChatConnected);
      expect(connected).toHaveLength(1);
      expect((connected[0]?.props as { client: unknown }).client).toBeNull();
      expect(find(view, (el) => el.type === ChatStatusBanner)).toHaveLength(1);
    }
  });

  it('keeps ChatConnected mounted under the gated banner while connecting and reconnecting', () => {
    for (const status of ['connecting', 'reconnecting'] as const) {
      const view = ChatShell({ status, client: null, workspaceId: 'w', currentUserId: 'u' });
      const connected = find(view, (el) => el.type === ChatConnected);
      expect(connected).toHaveLength(1);
      expect((connected[0]?.props as { status: string }).status).toBe(status);
      const banners = find(view, (el) => el.type === ChatStatusBanner);
      expect(banners).toHaveLength(1);
      expect((banners[0]?.props as { workspaceId: string }).workspaceId).toBe('w');
    }
  });

  it('shows no banner once connected', () => {
    expect(connectionBannerText('none')).toBe('');
    expect(ConnectionBanner({ banner: 'none' })).toBeNull();
    const view = ChatShell({
      status: 'connected',
      client: null,
      workspaceId: 'w',
      currentUserId: 'u',
    });
    expect(find(view, (el) => el.type === ChatConnected)).toHaveLength(1);
  });
});

describe('ConnectionBanner copy', () => {
  it('says Reconnecting, a paused state, or a kick; never a connecting line', () => {
    expect(connectionBannerText('reconnecting')).toBe('Reconnecting');
    expect(connectionBannerText('unavailable')).toBe('Live updates paused. Messages still send.');
    expect(connectionBannerText('kicked')).toBe('Signed in on another device');
    expect(connectionBannerAction('reconnecting')).toBe('');
    expect(connectionBannerAction('unavailable')).toBe('Retry');
    for (const banner of ['none', 'reconnecting', 'unavailable', 'kicked'] as const) {
      expect(connectionBannerText(banner)).not.toMatch(/\u2014|Connecting|unavailable/);
    }
  });

  it('gives the kicked banner a 44px tap target that reconnects', () => {
    const onRetry = vi.fn();
    const view = ConnectionBanner({ banner: 'kicked', onRetry });
    const buttons = find(view, (el) => el.type === 'button');
    expect(buttons).toHaveLength(1);
    const props = buttons[0]?.props as { onClick: () => void; className: string; children: string };
    expect(props.children).toBe('Reconnect');
    expect(props.className).toContain('min-h-[44px]');
    expect(props.className).toContain('min-w-[44px]');
    props.onClick();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(
      find(ConnectionBanner({ banner: 'reconnecting', onRetry }), (el) => el.type === 'button'),
    ).toHaveLength(0);
  });

  it('overlays the surface (absolute, token colours only) so the thread never shifts', () => {
    const view = ConnectionBanner({ banner: 'reconnecting' });
    const className = (view?.props as { className: string }).className;
    expect(className).toContain('absolute');
    // Built from parts so this file itself stays free of the banned literals.
    const banned = new RegExp(`\\x23[0-9a-f]{3,6}|${'dark'}${':'}|translate|rotate`, 'i');
    expect(className).not.toMatch(banned);
  });
});

describe('GatedConnectionBanner first paint', () => {
  it('a cold mount renders no banner in any down state', () => {
    for (const status of ['connecting', 'reconnecting', 'unavailable'] as const) {
      const html = renderToStaticMarkup(
        <GatedConnectionBanner status={status} resetKey="w" onRetry={() => {}} />,
      );
      expect(html).toBe('');
    }
  });

  it('the initial connection status is connecting, never unavailable', () => {
    expect(INITIAL_CHAT_STATUS).toBe('connecting');
    const html = renderToStaticMarkup(
      <GatedConnectionBanner status={INITIAL_CHAT_STATUS} resetKey="w" onRetry={() => {}} />,
    );
    expect(html).not.toContain('Chat unavailable');
    expect(html).toBe('');
  });

  it('a kick is a real event and shows on first paint', () => {
    const html = renderToStaticMarkup(
      <GatedConnectionBanner status="kicked" resetKey="w" onRetry={() => {}} />,
    );
    expect(html).toContain('Signed in on another device');
  });
});

describe('chatUnavailableView', () => {
  it('offers a Retry action wired to the connection restart', () => {
    const onRetry = vi.fn();
    const view = chatUnavailableView({ onRetry });
    // The shared EmptyState carries the copy and the Retry as its action.
    expect(view.type).toBe(EmptyState);
    expect((view.props as { title: string }).title).toBe('Chat unavailable');
    const action = (view.props as { action: ReactElement }).action;
    const buttons = find(
      action,
      (el) => (el.props as { children?: ReactNode }).children === 'Retry',
    );
    expect(buttons).toHaveLength(1);
    (buttons[0]?.props as { onClick: () => void }).onClick();
    expect(onRetry).toHaveBeenCalledOnce();
    // 44px touch target via the lg button size.
    expect((buttons[0]?.props as { size: string }).size).toBe('lg');
  });
});
