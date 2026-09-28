import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

// MessageThread's import graph pulls the message factory, which imports the real
// agora-chat browser SDK. Mock it so importing the module in node never touches
// browser globals or the network (mirrors ChatShell.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { Avatar } from '@/components/ui/Avatar';
import {
  bubbleClass,
  bubbleStatus,
  bubbleTimeLabel,
  ForwardedLabel,
  isVoiceOnly,
  keyOpensMenu,
  lastSeenLabel,
  MessageBubble,
  threadRows,
  type ThreadRow,
} from '@/components/chat/MessageThread';
import { IconClock, IconTickDouble, IconTickSingle } from '@/components/ui/icons';
import { focusFirstMenuItem, menuClosesOnKey } from '@/components/chat/MessageActionMenu';
import { ReplyQuoteBox } from '@/components/chat/ReplyQuote';
import { PresignCache } from '@/lib/asset-presign';
import type { ChatProfile } from '@/lib/chat-reads';
import type { ThreadMessage } from '@/lib/chat/thread';

// MessageBubble is a pure, hook-free presentational component, so calling it
// directly returns its element tree without invoking child components (Avatar,
// SharedPostCards, ...). That keeps these assertions in the node test job with
// no DOM, exactly as ChatShell.test.tsx inspects ChatShell's returned element.
const cache = new PresignCache({
  endpoint: null,
  getAccessToken: () => Promise.resolve(null),
  fetcher: () => Promise.reject(new Error('unused')),
});

const PROFILES: Map<string, ChatProfile> = new Map([
  ['peer-1', { userId: 'peer-1', displayName: 'Alice', avatarUrl: null }],
]);

const CREATED_AT = '2026-09-22T18:45:00.123456+00:00';

function makeMessage(over: Partial<ThreadMessage>): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: 'peer-1',
    body: 'hello there',
    createdAt: CREATED_AT,
    time: Date.parse(CREATED_AT),
    provisionalTime: false,
    mine: false,
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
    ...over,
  };
}

function renderBubble(
  message: ThreadMessage,
  opts?: {
    isGroup?: boolean;
    head?: boolean;
    tail?: boolean;
    showTicks?: boolean;
    timeZone?: string;
    onRetry?: (id: string) => void;
  },
): ReactElement {
  return MessageBubble({
    message,
    profiles: PROFILES,
    cache,
    presignEnabled: false,
    showTicks: opts?.showTicks ?? false,
    isGroup: opts?.isGroup ?? false,
    head: opts?.head ?? true,
    tail: opts?.tail ?? true,
    timeZone: opts?.timeZone ?? 'UTC',
    onBadgeClick: () => {},
    ...(opts?.onRetry !== undefined ? { onRetry: opts.onRetry } : {}),
  });
}

/** Walk the element tree depth-first, yielding every React element. */
function walk(node: ReactNode, visit: (el: ReactElement) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (!isValidElement(node)) return;
  visit(node);
  // The shared quote box is hook-free: expand it so its spans are walkable.
  if (node.type === ReplyQuoteBox) {
    walk(ReplyQuoteBox(node.props as Parameters<typeof ReplyQuoteBox>[0]), visit);
    return;
  }
  walk((node.props as { children?: ReactNode }).children, visit);
}

function hasAvatar(root: ReactElement): boolean {
  let found = false;
  walk(root, (el) => {
    if (el.type === Avatar) found = true;
  });
  return found;
}

function allText(root: ReactElement): string {
  const parts: string[] = [];
  walk(root, (el) => {
    const child = (el.props as { children?: ReactNode }).children;
    if (typeof child === 'string') parts.push(child);
  });
  return parts.join(' ');
}

function rootClass(root: ReactElement): string {
  return (root.props as { className?: string }).className ?? '';
}

describe('MessageBubble WhatsApp-style layout', () => {
  it('renders own messages right-aligned with no avatar and no sender name', () => {
    const root = renderBubble(makeMessage({ mine: true, senderUserId: 'me' }));
    expect(rootClass(root)).toContain('flex-row-reverse');
    expect(hasAvatar(root)).toBe(false);
    expect(allText(root)).not.toContain('You');
  });

  it('renders a DM peer message with no avatar and no sender name', () => {
    const root = renderBubble(makeMessage({ mine: false }), { isGroup: false });
    expect(hasAvatar(root)).toBe(false);
    expect(allText(root)).not.toContain('Alice');
  });

  it('renders a group run head with the avatar and sender name', () => {
    const root = renderBubble(makeMessage({ mine: false }), { isGroup: true, head: true });
    expect(hasAvatar(root)).toBe(true);
    expect(allText(root)).toContain('Alice');
  });

  it('tucks a group non-head message with no avatar and no sender name', () => {
    const root = renderBubble(makeMessage({ mine: false }), { isGroup: true, head: false });
    expect(hasAvatar(root)).toBe(false);
    expect(allText(root)).not.toContain('Alice');
  });
});

function hasType(root: ReactElement, type: unknown): boolean {
  let found = false;
  walk(root, (el) => {
    if (el.type === type) found = true;
  });
  return found;
}

/** The StatusLine element under the bubble, expanded so its children are walkable. */
function statusLine(root: ReactElement): ReactElement | null {
  let line: ReactElement | null = null;
  walk(root, (el) => {
    if (typeof el.type === 'function' && (el.type as { name?: string }).name === 'StatusLine') {
      line = (el.type as (p: unknown) => ReactElement)(el.props);
    }
  });
  return line;
}

describe('MessageBubble time and state', () => {
  it('shows no time inside the bubble; the label keeps it for screen readers', () => {
    const message = makeMessage({});
    const root = renderBubble(message, { timeZone: 'Asia/Kolkata' });
    expect(allText(root)).not.toContain('00:15');
    let aria = '';
    walk(root, (el) => {
      const props = el.props as Record<string, unknown>;
      if (props['data-bubble'] !== undefined) aria = String(props['aria-label']);
    });
    expect(aria).toContain('00:15');
    expect(bubbleTimeLabel(message, 'UTC')).toBe('18:45');
  });

  it('labels a sending bubble and a failed bubble instead of a time', () => {
    expect(bubbleTimeLabel(makeMessage({ state: 'sending', createdAt: '' }), 'UTC')).toBe(
      'Sending',
    );
    expect(bubbleTimeLabel(makeMessage({ state: 'failed', createdAt: '' }), 'UTC')).toBe(
      'Not sent',
    );
  });

  it('offers a 44px Retry control on an own failed bubble that resends the same id', () => {
    const onRetry = vi.fn();
    const root = renderBubble(
      makeMessage({ id: 'm-fail', mine: true, state: 'failed', createdAt: '' }),
      {
        onRetry,
      },
    );
    let retry: ReactElement | null = null;
    walk(root, (el) => {
      if ((el.props as { label?: string }).label === 'Retry sending') retry = el;
    });
    expect(retry).not.toBeNull();
    (retry as unknown as { props: { onClick: () => void } }).props.onClick();
    expect(onRetry).toHaveBeenCalledWith('m-fail');
    expect((root.props as { 'data-state': string })['data-state']).toBe('failed');
  });

  it('has no Retry control on a sent bubble or a peer bubble', () => {
    for (const message of [
      makeMessage({ mine: true }),
      makeMessage({ state: 'failed', mine: false }),
    ]) {
      let retry: ReactElement | null = null;
      walk(renderBubble(message, { onRetry: vi.fn() }), (el) => {
        if ((el.props as { label?: string }).label === 'Retry sending') retry = el;
      });
      expect(retry).toBeNull();
    }
  });
});

describe('bubble shell', () => {
  const base = { sending: false, failed: false, checked: false, voiceOnly: false };

  it('own is the solid accent with the primary Button ink, peer is panel-2; no border', () => {
    const own = bubbleClass({ ...base, mine: true, tail: true });
    const peer = bubbleClass({ ...base, mine: false, tail: true });
    expect(own).toContain('bg-accent text-accent-fg');
    expect(peer).toContain('bg-panel-2 text-fg');
    for (const cls of [own, peer]) {
      expect(cls).toContain('rounded-[18px]');
      expect(cls.split(' ')).not.toContain('border');
    }
  });

  it('squares the sender-side corner only on the tail', () => {
    expect(bubbleClass({ ...base, mine: true, tail: true })).toContain('rounded-br-[4px]');
    expect(bubbleClass({ ...base, mine: false, tail: true })).toContain('rounded-bl-[4px]');
    expect(bubbleClass({ ...base, mine: true, tail: false })).not.toContain('rounded-br-[4px]');
    expect(bubbleClass({ ...base, mine: false, tail: false })).not.toContain('rounded-bl-[4px]');
  });

  it('caps rows at 76% and spaces rows 2px in a run, 10px between runs', () => {
    const headRow = renderBubble(makeMessage({}), { head: true });
    const tucked = renderBubble(makeMessage({}), { head: false });
    expect(rootClass(headRow)).toContain('pt-2.5');
    expect(rootClass(tucked)).toContain('pt-0.5');
    expect(rootClass(headRow)).not.toContain('py-2');
    let column = '';
    walk(headRow, (el) => {
      const cls = (el.props as { className?: string }).className ?? '';
      if (cls.includes('max-w-')) column = cls;
    });
    expect(column).toContain('max-w-[76%]');
  });
});

describe('status line', () => {
  const own = (over: Partial<ThreadMessage>) => makeMessage({ mine: true, ...over });

  it('shows Delivered or Read on the last own DM bubble of a run only', () => {
    expect(bubbleStatus(own({ status: 'sent' }), { showTicks: true, tail: true })).toBe(
      'delivered',
    );
    expect(bubbleStatus(own({ status: 'read' }), { showTicks: true, tail: true })).toBe('read');
    expect(bubbleStatus(own({}), { showTicks: true, tail: false })).toBeNull();
    expect(bubbleStatus(own({}), { showTicks: false, tail: true })).toBeNull();
    expect(bubbleStatus(makeMessage({}), { showTicks: true, tail: true })).toBeNull();
  });

  it('renders Delivered with a single tick and Read with a double tick in the accent', () => {
    const delivered = statusLine(renderBubble(own({ status: 'sent' }), { showTicks: true }));
    expect(delivered).not.toBeNull();
    expect(allText(delivered as unknown as ReactElement)).toContain('Delivered');
    expect(hasType(delivered as unknown as ReactElement, IconTickSingle)).toBe(true);
    const read = statusLine(renderBubble(own({ status: 'read' }), { showTicks: true }));
    const readRoot = read as unknown as ReactElement;
    expect(allText(readRoot)).toContain('Read');
    let accent = false;
    walk(readRoot, (el) => {
      const cls = (el.props as { className?: string }).className ?? '';
      if (cls.includes('text-accent') && hasType(el, IconTickDouble)) accent = true;
    });
    expect(accent).toBe(true);
  });

  it('draws no ticks and no status on a non-tail own bubble', () => {
    const root = renderBubble(own({ status: 'read' }), { showTicks: true, tail: false });
    expect(statusLine(root)).toBeNull();
    expect(hasType(root, IconTickSingle)).toBe(false);
    expect(hasType(root, IconTickDouble)).toBe(false);
  });

  it('sending: a clock with no text label, and the bubble at 70% opacity', () => {
    const root = renderBubble(own({ state: 'sending' }), { showTicks: true });
    const line = statusLine(root) as unknown as ReactElement;
    expect(hasType(line, IconClock)).toBe(true);
    expect(allText(line)).toBe('');
    let cls = '';
    walk(root, (el) => {
      const props = el.props as Record<string, unknown>;
      if (props['data-bubble'] !== undefined) cls = String(props.className);
    });
    expect(cls).toContain('opacity-70');
  });

  it('failed: Not sent plus Retry, as before', () => {
    const root = renderBubble(own({ state: 'failed' }), { showTicks: true, onRetry: vi.fn() });
    expect(allText(statusLine(root) as unknown as ReactElement)).toContain('Not sent');
    let retry = false;
    walk(root, (el) => {
      if ((el.props as { label?: string }).label === 'Retry sending') retry = true;
    });
    expect(retry).toBe(true);
  });
});

describe('threadRows', () => {
  const t = (iso: string) => ({ createdAt: iso, time: Date.parse(iso) });
  const msgs = [
    makeMessage({ id: 'a', mine: true, senderUserId: 'me', ...t('2026-09-21T10:00:00Z') }),
    makeMessage({ id: 'b', mine: true, senderUserId: 'me', ...t('2026-09-21T10:05:00Z') }),
    makeMessage({ id: 'c', mine: true, senderUserId: 'me', ...t('2026-09-21T10:15:00Z') }),
    makeMessage({ id: 'd', ...t('2026-09-21T10:16:00Z') }),
    makeMessage({ id: 'e', ...t('2026-09-22T09:00:00Z') }),
  ];
  const rows = threadRows(msgs, Date.parse('2026-09-22T12:00:00Z'), 'UTC');
  const msg = (id: string) =>
    rows.find(
      (r): r is Extract<ThreadRow, { kind: 'message' }> =>
        r.kind === 'message' && r.message.id === id,
    );

  it('computes runs: head on the first, tail on the last', () => {
    expect([msg('a')?.head, msg('a')?.tail]).toEqual([true, false]);
    expect([msg('b')?.head, msg('b')?.tail]).toEqual([false, true]);
    // A 10-minute gap breaks the run even from the same sender.
    expect([msg('c')?.head, msg('c')?.tail]).toEqual([true, true]);
    expect([msg('d')?.head, msg('d')?.tail]).toEqual([true, true]);
    // A day pill breaks the run.
    expect([msg('e')?.head, msg('e')?.tail]).toEqual([true, true]);
  });

  it('puts a time label after each day pill and after a 10-minute gap only', () => {
    expect(rows.map((r) => (r.kind === 'message' ? r.message.id : `${r.kind}:${r.label}`))).toEqual(
      [
        'day:Yesterday',
        'time:10:00',
        'a',
        'b',
        'time:10:15',
        'c',
        'd',
        'day:Today',
        'time:09:00',
        'e',
      ],
    );
  });

  it('labels on the workspace clock', () => {
    const kolkata = threadRows(
      msgs.slice(0, 1),
      Date.parse('2026-09-22T12:00:00Z'),
      'Asia/Kolkata',
    );
    expect(kolkata.find((r) => r.kind === 'time')).toMatchObject({ label: '15:30' });
  });
});

describe('lastSeenLabel', () => {
  it('buckets recent presence and renders an older last-seen on the workspace clock', () => {
    const now = Date.parse('2026-09-23T12:00:00Z');
    expect(lastSeenLabel(null, now, 'UTC')).toBe('Offline');
    expect(lastSeenLabel(now - 30_000, now, 'UTC')).toBe('last seen just now');
    expect(lastSeenLabel(now - 5 * 60_000, now, 'UTC')).toBe('last seen 5m ago');
    expect(lastSeenLabel(now - 3 * 3_600_000, now, 'UTC')).toBe('last seen 3h ago');
    const twoDaysAgo = Date.parse('2026-09-21T18:45:00Z');
    expect(lastSeenLabel(twoDaysAgo, now, 'Asia/Kolkata')).toBe('last seen 1d ago at 00:15');
  });
});

function findByChildren(root: ReactElement, text: string): ReactElement | null {
  let found: ReactElement | null = null;
  walk(root, (el) => {
    const child = (el.props as { children?: ReactNode }).children;
    if (child === text) found = el;
  });
  return found;
}

function findByAriaLabel(root: ReactElement, label: string): ReactElement | null {
  let found: ReactElement | null = null;
  walk(root, (el) => {
    if ((el.props as { ['aria-label']?: string })['aria-label'] === label) found = el;
  });
  return found;
}

describe('MessageBubble reply quote', () => {
  const preview = 'x'.repeat(300);
  const replyMessage = makeMessage({
    reply: { id: 'orig-7', authorUserId: 'peer-1', preview },
  });

  it('line-clamps the quote instead of truncating, and is a jump button', () => {
    const root = renderBubble(replyMessage);

    const previewSpan = findByChildren(root, preview);
    expect(previewSpan).not.toBeNull();
    const previewClass = (previewSpan?.props as { className?: string }).className ?? '';
    expect(previewClass).toContain('line-clamp-2');
    expect(previewClass).toContain('[overflow-wrap:anywhere]');
    expect(previewClass).not.toContain('truncate');

    const authorSpan = findByChildren(root, 'Alice');
    expect(authorSpan).not.toBeNull();
    const authorClass = (authorSpan?.props as { className?: string }).className ?? '';
    expect(authorClass).toContain('line-clamp-1');

    const jump = findByAriaLabel(root, 'Go to quoted message');
    expect(jump).not.toBeNull();
    expect((jump?.props as { type?: string }).type).toBe('button');
  });

  it('invokes onJumpToMessage with the quoted id on click', () => {
    const onJumpToMessage = vi.fn();
    const root = MessageBubble({
      message: replyMessage,
      profiles: PROFILES,
      cache,
      presignEnabled: false,
      showTicks: false,
      isGroup: false,
      head: true,
      tail: true,
      timeZone: 'UTC',
      onBadgeClick: () => {},
      onJumpToMessage,
    });

    const jump = findByAriaLabel(root, 'Go to quoted message');
    expect(jump).not.toBeNull();
    const onClick = (jump?.props as { onClick?: (e: { stopPropagation: () => void }) => void })
      .onClick;
    onClick?.({ stopPropagation: () => {} });
    expect(onJumpToMessage).toHaveBeenCalledTimes(1);
    expect(onJumpToMessage).toHaveBeenCalledWith('orig-7');
  });
});

describe('MessageBubble forwarded label', () => {
  it('shows a small Forwarded label on incoming and own forwarded messages', () => {
    for (const mine of [false, true]) {
      let count = 0;
      walk(renderBubble(makeMessage({ mine, forwarded: true })), (el) => {
        if (el.type === ForwardedLabel) count += 1;
      });
      expect(count).toBe(1);
    }
    const label = ForwardedLabel();
    const cls = (label.props as { className: string }).className;
    expect(cls).toContain('text-fg-2');
    expect(cls).toContain('text-xs');
    expect((label.props as { children: unknown[] }).children).toContain('Forwarded');
    // On the solid accent the label takes the bubble's on-accent ink.
    const own = ForwardedLabel({ mine: true });
    expect((own.props as { className: string }).className).toContain('text-accent-fg');
  });

  it('has no label on a message that was not forwarded', () => {
    let count = 0;
    walk(renderBubble(makeMessage({})), (el) => {
      if (el.type === ForwardedLabel) count += 1;
    });
    expect(count).toBe(0);
  });
});

describe('MessageBubble keyboard and hover actions', () => {
  const noop = (): void => {};
  function pressed(over: { onKeyOpen?: () => void; onMore?: (anchor: DOMRect) => void } = {}) {
    return {
      handlers: {
        onPointerDown: noop,
        onPointerMove: noop,
        onPointerUp: noop,
        onPointerCancel: noop,
      },
      onContextMenu: noop,
      consumeClick: () => false,
      onKeyOpen: over.onKeyOpen ?? noop,
      ...(over.onMore !== undefined ? { onMore: over.onMore } : {}),
    };
  }
  function bubbleOf(root: ReactElement): ReactElement<Record<string, unknown>> {
    let found: ReactElement<Record<string, unknown>> | undefined;
    walk(root, (el) => {
      if ((el.props as Record<string, unknown>)['data-bubble'] !== undefined) {
        found = el as ReactElement<Record<string, unknown>>;
      }
    });
    if (found === undefined) throw new Error('no bubble');
    return found;
  }
  function render(press: ReturnType<typeof pressed>, message = makeMessage({})): ReactElement {
    return MessageBubble({
      message,
      profiles: PROFILES,
      cache,
      presignEnabled: false,
      showTicks: false,
      isGroup: false,
      head: true,
      tail: true,
      timeZone: 'UTC',
      onBadgeClick: noop,
      press,
    });
  }

  it('the bubble is a focusable group with a label', () => {
    const bubble = bubbleOf(render(pressed()));
    expect(bubble.props.role).toBe('group');
    expect(bubble.props.tabIndex).toBe(0);
    expect(bubble.props['aria-label']).toBe('Message from Alice, 18:45');
  });

  it('Enter, Space and Shift+F10 on the bubble open the menu; other keys do not', () => {
    const onKeyOpen = vi.fn();
    const bubble = bubbleOf(render(pressed({ onKeyOpen })));
    const onKeyDown = bubble.props.onKeyDown as (e: unknown) => void;
    const self = {};
    const key = (k: string, shiftKey = false, target: unknown = self) => ({
      key: k,
      shiftKey,
      target,
      currentTarget: self,
      preventDefault: vi.fn(),
    });
    onKeyDown(key('Enter'));
    onKeyDown(key(' '));
    onKeyDown(key('F10', true));
    expect(onKeyOpen).toHaveBeenCalledTimes(3);
    onKeyDown(key('a'));
    // Enter on a control inside the bubble (quoted reply) is that control's own.
    onKeyDown(key('Enter', false, {}));
    expect(onKeyOpen).toHaveBeenCalledTimes(3);
  });

  it('keyOpensMenu covers the ContextMenu key and ignores bubbling Enter', () => {
    const t = {};
    expect(
      keyOpensMenu({ key: 'ContextMenu', shiftKey: false, target: {}, currentTarget: t }),
    ).toBe(true);
    expect(keyOpensMenu({ key: 'Enter', shiftKey: false, target: {}, currentTarget: t })).toBe(
      false,
    );
  });

  it('Escape closes the menu, and the first action row gets focus on open', () => {
    expect(menuClosesOnKey('Escape')).toBe(true);
    expect(menuClosesOnKey('Enter')).toBe(false);
    const focus = vi.fn();
    const querySelector = vi.fn(() => ({ focus }));
    expect(focusFirstMenuItem({ querySelector })).toBe(true);
    expect(querySelector).toHaveBeenCalledWith('[data-menu-items] button');
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(focusFirstMenuItem(null)).toBe(false);
  });

  it('renders the 44x44 ⋯ control only when the pointer can hover', () => {
    const onMore = vi.fn();
    const more = (root: ReactElement): ReactElement<Record<string, unknown>>[] => {
      const out: ReactElement<Record<string, unknown>>[] = [];
      walk(root, (el) => {
        if ((el.props as Record<string, unknown>)['data-more'] !== undefined) {
          out.push(el as ReactElement<Record<string, unknown>>);
        }
      });
      return out;
    };
    expect(more(render(pressed()))).toHaveLength(0);
    const [button] = more(render(pressed({ onMore })));
    expect(String(button?.props.className)).toContain('h-11 w-11');
    expect(String(button?.props.className)).toContain('group-hover:opacity-100');
    const rect = { top: 1 } as DOMRect;
    (button?.props.onClick as (e: unknown) => void)({
      currentTarget: { getBoundingClientRect: () => rect },
    });
    expect(onMore).toHaveBeenCalledWith(rect);
  });
});

describe('voice-only bubble', () => {
  const voice = makeMessage({
    body: '',
    attachments: [{ assetId: 'v1', name: 'note.webm', mime: 'audio/webm', durationMs: 18_000 }],
  });

  it('is detected only for a lone audio attachment with no text or cards', () => {
    expect(isVoiceOnly(voice)).toBe(true);
    expect(isVoiceOnly({ ...voice, body: 'hi' })).toBe(false);
    expect(isVoiceOnly({ ...voice, sharedPostIds: ['p'] })).toBe(false);
    expect(
      isVoiceOnly({
        ...voice,
        attachments: [{ assetId: 'f', name: 'a.pdf', mime: 'application/pdf' }],
      }),
    ).toBe(false);
  });

  it('uses the text-bubble shell with no time inside, inline or as a row', () => {
    const root = renderBubble(voice);
    let cls = '';
    let timeInside = false;
    walk(root, (el) => {
      const props = el.props as { className?: string } & Record<string, unknown>;
      if (props['data-bubble'] !== undefined) cls = props.className ?? '';
      if (props.className?.includes('absolute bottom-1.5 right-2.5')) timeInside = true;
      if (props.className?.includes('mt-1 flex items-center justify-end')) timeInside = true;
      if (props.voiceSpacer !== undefined) timeInside = true;
    });
    expect(cls).toContain('rounded-[18px]');
    expect(cls).toContain('min-w-[220px]');
    expect(timeInside).toBe(false);
    expect(allText(root)).not.toContain('18:45');
  });
});
