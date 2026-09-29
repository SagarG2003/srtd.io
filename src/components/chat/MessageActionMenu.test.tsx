import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  DELETE_WINDOW_MS,
  EDIT_WINDOW_MS,
  MARKED_LOCKED_LABEL,
  MORE_REACTIONS_LABEL,
  QUICK_REACTIONS,
  ReactionsRow,
  markSubmenuItems,
  messageMenuItems,
  nextWindowBoundaryMs,
  ownMessageActions,
  pickReaction,
  scheduleWindowBoundary,
  scrollFromPicker,
  type MessageMenuItem,
} from '@/components/chat/MessageActionMenu';
import { applyServerClock, initialState } from '@/lib/chat/chat-store';
import type { ChatMark } from '@/lib/chat/marks';
import type { ThreadMessage } from '@/lib/chat/thread';

type ItemProps = Parameters<typeof messageMenuItems>[0];

function labels(items: MessageMenuItem[]): string[] {
  return items.map((item) => (item.kind === 'divider' ? '---' : item.label));
}

function menu(over: Partial<ItemProps> = {}): string[] {
  return labels(
    messageMenuItems({
      canCopy: true,
      onReply: () => {},
      onCopy: () => {},
      markOptions: ['commitment', 'decision', 'pending'],
      onMark: () => {},
      canForward: true,
      onForward: () => {},
      canSelect: true,
      onSelect: () => {},
      ...over,
    }),
  );
}

const NOW = Date.parse('2026-09-29T12:00:00Z');
const MIN = 60 * 1000;

function msg(over: Partial<ThreadMessage> = {}): ThreadMessage {
  const createdAt = new Date(NOW - 5 * MIN).toISOString();
  return {
    id: 'm1',
    senderUserId: 'me',
    body: 'hello',
    createdAt,
    time: Date.parse(createdAt),
    provisionalTime: false,
    mine: true,
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

function ago(minutes: number): Partial<ThreadMessage> {
  const createdAt = new Date(NOW - minutes * MIN).toISOString();
  return { createdAt, time: Date.parse(createdAt) };
}

const MARK: ChatMark = {
  messageId: 'm1',
  channelId: 'c1',
  type: 'decision',
  priority: null,
  markedAt: '2026-09-29T11:59:00Z',
  resolved: false,
  resolvedBy: null,
  resolvedAt: null,
};

/** The row set the menu shows for a message at NOW (mark options as the thread computes them). */
function rowsFor(message: ThreadMessage, mark?: ChatMark): string[] {
  const own = ownMessageActions(message, mark, NOW);
  return menu({
    canCopy: message.body.trim() !== '',
    markOptions: mark === undefined ? ['commitment', 'decision', 'pending'] : [],
    markedAs: mark?.type ?? null,
    canEdit: own.canEdit,
    canDelete: own.canDelete,
    lockedByMark: own.lockedByMark,
  });
}

describe('ownMessageActions: the edit and delete windows', () => {
  it('own within 15 min: Edit and Delete', () => {
    expect(ownMessageActions(msg(ago(5)), undefined, NOW)).toEqual({
      canEdit: true,
      canDelete: true,
      lockedByMark: false,
    });
    expect(ownMessageActions(msg(ago(15)), undefined, NOW).canEdit).toBe(true);
  });

  it('own at 20 min: Delete only; own at 40 min: neither', () => {
    expect(ownMessageActions(msg(ago(20)), undefined, NOW)).toEqual({
      canEdit: false,
      canDelete: true,
      lockedByMark: false,
    });
    expect(ownMessageActions(msg(ago(40)), undefined, NOW)).toEqual({
      canEdit: false,
      canDelete: false,
      lockedByMark: false,
    });
  });

  it('marked own: the locked line, never Edit or Delete', () => {
    expect(ownMessageActions(msg(ago(1)), MARK, NOW)).toEqual({
      canEdit: false,
      canDelete: false,
      lockedByMark: true,
    });
  });

  it('peer, pending (no created_at), failed and deleted: nothing', () => {
    const none = { canEdit: false, canDelete: false, lockedByMark: false };
    expect(ownMessageActions(msg({ mine: false }), undefined, NOW)).toEqual(none);
    expect(ownMessageActions(msg({ mine: false }), MARK, NOW)).toEqual(none);
    expect(
      ownMessageActions(
        msg({ createdAt: '', state: 'sending', provisionalTime: true }),
        undefined,
        NOW,
      ),
    ).toEqual(none);
    expect(ownMessageActions(msg({ createdAt: '' }), undefined, NOW)).toEqual(none);
    expect(ownMessageActions(msg({ state: 'failed' }), undefined, NOW)).toEqual(none);
    expect(ownMessageActions(msg({ deleted: true }), undefined, NOW)).toEqual(none);
  });

  it('Edit needs a body: a card or attachment only message can be deleted, not edited', () => {
    const cardOnly = msg({ body: '', sharedPostIds: ['p1'] });
    expect(ownMessageActions(cardOnly, undefined, NOW)).toEqual({
      canEdit: false,
      canDelete: true,
      lockedByMark: false,
    });
  });

  it('judges the window from the server created_at against the given moment', () => {
    const m = msg(ago(0));
    const created = Date.parse(m.createdAt);
    expect(ownMessageActions(m, undefined, created + EDIT_WINDOW_MS).canEdit).toBe(true);
    expect(ownMessageActions(m, undefined, created + EDIT_WINDOW_MS + 1).canEdit).toBe(false);
    expect(ownMessageActions(m, undefined, created + DELETE_WINDOW_MS).canDelete).toBe(true);
    expect(ownMessageActions(m, undefined, created + DELETE_WINDOW_MS + 1).canDelete).toBe(false);
  });
});

describe('messageMenuItems: row set per case', () => {
  it('own within 15 min', () => {
    expect(rowsFor(msg(ago(5)))).toEqual([
      'Reply',
      'Forward',
      'Copy',
      'Mark as',
      'Edit',
      'Delete',
      '---',
      'Select',
    ]);
  });

  it('own at 20 min: no Edit', () => {
    expect(rowsFor(msg(ago(20)))).toEqual([
      'Reply',
      'Forward',
      'Copy',
      'Mark as',
      'Delete',
      '---',
      'Select',
    ]);
  });

  it('own at 40 min: neither Edit nor Delete', () => {
    expect(rowsFor(msg(ago(40)))).toEqual(['Reply', 'Forward', 'Copy', 'Mark as', '---', 'Select']);
  });

  it('marked own: "Marked as <type>" and the single locked line', () => {
    expect(rowsFor(msg(ago(2)), MARK)).toEqual([
      'Reply',
      'Forward',
      'Copy',
      'Marked as Decision',
      MARKED_LOCKED_LABEL,
      '---',
      'Select',
    ]);
  });

  it('peer: never Edit, Delete or the locked line', () => {
    expect(rowsFor(msg({ ...ago(1), mine: false }))).toEqual([
      'Reply',
      'Forward',
      'Copy',
      'Mark as',
      '---',
      'Select',
    ]);
    expect(rowsFor(msg({ ...ago(1), mine: false }), MARK)).toEqual([
      'Reply',
      'Forward',
      'Copy',
      'Marked as Decision',
      '---',
      'Select',
    ]);
  });

  it('pending: no Edit or Delete (no created_at)', () => {
    const pending = msg({ createdAt: '', state: 'sending', provisionalTime: true });
    const own = ownMessageActions(pending, undefined, NOW);
    expect(
      menu({
        canForward: false,
        markOptions: [],
        canEdit: own.canEdit,
        canDelete: own.canDelete,
        lockedByMark: own.lockedByMark,
        canSelect: false,
      }),
    ).toEqual(['Reply', 'Copy']);
  });

  it('hides rows that do not apply (never greyed)', () => {
    expect(menu({ canForward: false, canCopy: false, markOptions: [], canSelect: false })).toEqual([
      'Reply',
    ]);
  });

  it('the marked note and locked line are not interactive; Delete is danger with its hint', () => {
    const items = messageMenuItems({
      canCopy: false,
      onReply: () => {},
      onCopy: () => {},
      markedAs: 'commitment',
      lockedByMark: true,
    });
    expect(items.filter((i) => i.kind === 'note').map((i) => i.key)).toEqual(['marked', 'locked']);
    const withDelete = messageMenuItems({
      canCopy: false,
      onReply: () => {},
      onCopy: () => {},
      canEdit: true,
      canDelete: true,
    });
    const edit = withDelete.find((i) => i.key === 'edit');
    const del = withDelete.find((i) => i.key === 'delete');
    expect(edit?.kind === 'action' && edit.hint).toBe('15 min');
    expect(del?.kind === 'action' && del.hint).toBe('30 min');
    expect(del?.kind === 'action' && del.danger).toBe(true);
  });

  it('runs the forward, edit and delete handlers', () => {
    const onForward = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const items = messageMenuItems({
      canCopy: false,
      onReply: () => {},
      onCopy: () => {},
      canForward: true,
      onForward,
      canEdit: true,
      onEdit,
      canDelete: true,
      onDelete,
    });
    for (const key of ['forward', 'edit', 'delete']) {
      const item = items.find((i) => i.key === key);
      if (item?.kind === 'action') item.run();
    }
    expect(onForward).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe('Mark as submenu', () => {
  it('Back, then Commitment, Decision, Pending, each with its colour dot', () => {
    const onBack = vi.fn();
    const onMark = vi.fn();
    const items = markSubmenuItems(
      { markOptions: ['commitment', 'decision', 'pending'], onMark },
      onBack,
    );
    expect(labels(items)).toEqual(['Back', 'Commitment', 'Decision', 'Pending']);
    expect(items.map((i) => (i.kind === 'action' ? i.dot : undefined))).toEqual([
      undefined,
      'commitment',
      'decision',
      'pending',
    ]);
    for (const item of items) if (item.kind === 'action') item.run();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onMark.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      'commitment',
      'decision',
      'pending',
    ]);
  });

  it('the main row opens the submenu (no run, no close)', () => {
    const item = messageMenuItems({
      canCopy: false,
      onReply: () => {},
      onCopy: () => {},
      markOptions: ['pending'],
    }).find((i) => i.key === 'mark');
    expect(item?.kind === 'action' && item.submenu).toBe(true);
  });
});

describe('QUICK_REACTIONS', () => {
  it('is exactly the approved quick-react set, in order, followed by the "+"', () => {
    expect([...QUICK_REACTIONS]).toEqual(['👍', '❤️', '😂', '🆗', '🙏']);
    const buttons = rowButtons(row());
    expect(buttons.map((b) => b.props['aria-label'])).toEqual([
      ...QUICK_REACTIONS.map((e) => `React ${e}`),
      MORE_REACTIONS_LABEL,
    ]);
  });
});

/** Every element in a tree (hook-free components only are expanded). */
function all(node: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!isValidElement(n)) return;
    out.push(n);
    walk((n.props as { children?: ReactNode }).children);
  };
  walk(node);
  return out;
}

function row(
  over: Partial<Parameters<typeof ReactionsRow>[0]> = {},
): ReturnType<typeof ReactionsRow> {
  return ReactionsRow({
    currentReaction: null,
    reactionsOnly: false,
    onReact: () => {},
    onMore: () => {},
    ...over,
  });
}

function rowButtons(el: ReactElement): ReactElement<Record<string, unknown>>[] {
  return all(el).filter((e) => e.type === 'button') as ReactElement<Record<string, unknown>>[];
}

describe('D6: the reactions row and its "+"', () => {
  it('six 44x44 controls: the five quick reactions, then "+"', () => {
    const buttons = rowButtons(row());
    expect(buttons).toHaveLength(6);
    for (const b of buttons) {
      expect(String(b.props.className)).toContain('h-11');
      expect(String(b.props.className)).toContain('w-11');
    }
    expect(buttons[5]?.props['data-react-more']).toBe('');
  });

  it('"+" opens the picker; a quick reaction reacts', () => {
    const onMore = vi.fn();
    const onReact = vi.fn();
    const buttons = rowButtons(row({ onMore, onReact }));
    (buttons[5]?.props.onClick as () => void)();
    expect(onMore).toHaveBeenCalledOnce();
    expect(onReact).not.toHaveBeenCalled();
    (buttons[0]?.props.onClick as () => void)();
    expect(onReact).toHaveBeenCalledWith('👍');
  });

  it('the laptop smiley row (reactionsOnly) carries the "+" too, as a focus stop', () => {
    const buttons = rowButtons(row({ reactionsOnly: true }));
    expect(buttons).toHaveLength(6);
    expect(buttons[5]?.props['data-menu-item']).toBe('react-more');
  });

  it('a pick reacts once through the same path, then closes the picker and the menu', () => {
    const order: string[] = [];
    const onReact = vi.fn((emoji: string) => order.push(`react ${emoji}`));
    pickReaction('🦄', {
      onReact,
      closePicker: () => order.push('close picker'),
      closeMenu: () => order.push('close menu'),
    });
    expect(onReact).toHaveBeenCalledOnce();
    expect(order).toEqual(['react 🦄', 'close picker', 'close menu']);
  });

  it("the picker grid's own scroll never closes the menu", () => {
    expect(scrollFromPicker(null)).toBe(false);
  });
});

describe('D3: window visibility on server time', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies the server clock offset: a device clock 10 min behind still hides Edit at 16 server-min', () => {
    const deviceNow = NOW;
    const created = new Date(NOW - 6 * MIN).toISOString();
    // The ack showed the server 10 minutes ahead of this device.
    const offset = applyServerClock(
      initialState(),
      new Date(NOW + 10 * MIN).toISOString(),
      NOW,
    ).serverClockOffsetMs;
    expect(offset).toBe(10 * MIN);
    const onDevice = ownMessageActions(msg({ createdAt: created }), undefined, deviceNow);
    const onServer = ownMessageActions(msg({ createdAt: created }), undefined, deviceNow + offset);
    expect(onDevice.canEdit).toBe(true);
    expect(onServer.canEdit).toBe(false);
    expect(onServer.canDelete).toBe(true);
  });

  it('the next boundary is 15 min, then 30 min, then none', () => {
    const created = new Date(NOW - 5 * MIN).toISOString();
    expect(nextWindowBoundaryMs(created, NOW)).toBe(10 * MIN + 1);
    expect(nextWindowBoundaryMs(created, NOW + 10 * MIN + 1)).toBe(15 * MIN);
    expect(nextWindowBoundaryMs(created, NOW + 25 * MIN + 1)).toBeNull();
    expect(nextWindowBoundaryMs('', NOW)).toBeNull();
  });

  it('while open, re-computes the rows at 15 and at 30 min (one timeout at a time, no interval)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const offset = 2 * MIN;
    const serverNow = (): number => Date.now() + offset;
    // Created 5 server-minutes ago.
    const message = msg({ createdAt: new Date(serverNow() - 5 * MIN).toISOString() });
    let rows = ownMessageActions(message, undefined, serverNow());
    const recomputed: string[] = [];
    let cancel = (): void => {};
    const arm = (): void => {
      cancel = scheduleWindowBoundary({
        createdAt: message.createdAt,
        now: serverNow,
        onBoundary: () => {
          rows = ownMessageActions(message, undefined, serverNow());
          recomputed.push(`${rows.canEdit ? 'edit' : '-'} ${rows.canDelete ? 'delete' : '-'}`);
          arm(); // the menu re-schedules from its new moment
        },
      });
    };
    arm();
    expect(rows).toMatchObject({ canEdit: true, canDelete: true });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10 * MIN);
    expect(recomputed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(recomputed).toEqual(['- delete']);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(15 * MIN);
    expect(recomputed).toEqual(['- delete', '- -']);
    expect(vi.getTimerCount()).toBe(0);
    cancel();
  });

  it('closing the menu clears the timer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const onBoundary = vi.fn();
    const cancel = scheduleWindowBoundary({
      createdAt: new Date(NOW - 5 * MIN).toISOString(),
      now: () => Date.now(),
      onBoundary,
    });
    expect(vi.getTimerCount()).toBe(1);
    cancel();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60 * MIN);
    expect(onBoundary).not.toHaveBeenCalled();
  });
});
