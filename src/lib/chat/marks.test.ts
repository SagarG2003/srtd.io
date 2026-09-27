import { describe, expect, it, vi } from 'vitest';
import type { AgoraChat } from 'agora-chat';
import type { Client } from '@srtdio/rpc';
import {
  canChangePriority,
  findInOlderPages,
  indexMarks,
  loadChannelMarks,
  markBadgeLabel,
  markCounts,
  markMenuLabel,
  markMenuOptions,
  markRowText,
  marksForTab,
  markStripLabel,
  MARKS_EVENT_HANDLER_ID,
  pruneSelection,
  rowToMark,
  selectionRole,
  subscribeMarkEvents,
  toggleSelected,
  deleteConfirmTitle,
  type ChatMark,
} from '@/lib/chat/marks';
import { markEventExt, type ChatMessageRow, type ThreadMessage } from '@/lib/chat/thread';

function mark(over: Partial<ChatMark>): ChatMark {
  return {
    messageId: 'm1',
    channelId: 'c1',
    type: 'commitment',
    priority: null,
    markedAt: '2026-09-27T10:00:00+00:00',
    resolved: false,
    ...over,
  };
}

function message(over: Partial<ThreadMessage>): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: 'me',
    body: 'hello',
    createdAt: '2026-09-27T10:00:00+00:00',
    time: 1,
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

function row(id: string, created: string): ChatMessageRow {
  return {
    id,
    channel_id: 'c1',
    workspace_id: 'w',
    sender_user_id: 'u',
    body: 'b',
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: created,
    edited_at: null,
    deleted_at: null,
  };
}

describe('marks menu', () => {
  it('offers all three types on an unmarked recorded message, in order', () => {
    expect(markMenuOptions(message({}), undefined)).toEqual(['commitment', 'decision', 'pending']);
    expect(markMenuOptions(message({}), undefined).map(markMenuLabel)).toEqual([
      'Mark as Commitment',
      'Mark as Decision',
      'Mark as Pending',
    ]);
  });

  it('frozen marks expose no actions: commitment, decision, resolved pending', () => {
    for (const m of [
      mark({ type: 'commitment' }),
      mark({ type: 'decision' }),
      mark({ type: 'pending', resolved: true }),
    ]) {
      expect(markMenuOptions(message({}), m)).toEqual([]);
      expect(canChangePriority(m)).toBe(false);
    }
  });

  it('an open pending mark shows no menu options but its badge changes priority', () => {
    const pending = mark({ type: 'pending', priority: 1 });
    expect(markMenuOptions(message({}), pending)).toEqual([]);
    expect(canChangePriority(pending)).toBe(true);
  });

  it('an unrecorded message cannot be marked', () => {
    expect(markMenuOptions(message({ state: 'sending' }), undefined)).toEqual([]);
    expect(markMenuOptions(message({ state: 'failed' }), undefined)).toEqual([]);
  });
});

describe('badges', () => {
  it('labels each type, adds P1/P2 on pending, and hides resolved', () => {
    expect(markBadgeLabel(undefined)).toBe('');
    expect(markBadgeLabel(mark({ type: 'commitment' }))).toBe('Commitment');
    expect(markBadgeLabel(mark({ type: 'decision' }))).toBe('Decision');
    expect(markBadgeLabel(mark({ type: 'pending' }))).toBe('Pending');
    expect(markBadgeLabel(mark({ type: 'pending', priority: 2 }))).toBe('Pending P2');
    expect(markBadgeLabel(mark({ type: 'pending', priority: 1, resolved: true }))).toBe('');
  });
});

describe('strip counts', () => {
  it('counts open marks and P1s, hiding zero counts', () => {
    const marks = [
      mark({ messageId: 'a', type: 'commitment' }),
      mark({ messageId: 'b', type: 'commitment' }),
      mark({ messageId: 'c', type: 'pending', priority: 1 }),
      mark({ messageId: 'd', type: 'pending' }),
      mark({ messageId: 'e', type: 'pending', priority: 1, resolved: true }),
    ];
    const counts = markCounts(marks);
    expect(counts).toEqual({ commitments: 2, decisions: 0, pending: 2, p1: 1 });
    expect(markStripLabel(counts)).toBe('2 commitments · 2 pending (1 P1)');
    expect(markStripLabel(markCounts([mark({ type: 'decision' })]))).toBe('1 decision');
    expect(markStripLabel(markCounts([mark({ type: 'pending' })]))).toBe('1 pending');
    expect(markStripLabel(markCounts([]))).toBe('');
  });
});

describe('sheet lists', () => {
  const time = (m: ChatMark): number => Date.parse(m.markedAt);

  it('commitments and decisions are newest first', () => {
    const list = marksForTab(
      [
        mark({ messageId: 'old', markedAt: '2026-09-01T00:00:00Z' }),
        mark({ messageId: 'new', markedAt: '2026-09-20T00:00:00Z' }),
        mark({ messageId: 'dec', type: 'decision' }),
      ],
      'commitment',
      time,
    );
    expect(list.map((m) => m.messageId)).toEqual(['new', 'old']);
  });

  it('pending sorts P1, P2, unranked, then oldest first', () => {
    const list = marksForTab(
      [
        mark({ messageId: 'u-new', type: 'pending', markedAt: '2026-09-20T00:00:00Z' }),
        mark({ messageId: 'p2', type: 'pending', priority: 2, markedAt: '2026-09-01T00:00:00Z' }),
        mark({ messageId: 'u-old', type: 'pending', markedAt: '2026-09-02T00:00:00Z' }),
        mark({
          messageId: 'p1-new',
          type: 'pending',
          priority: 1,
          markedAt: '2026-09-10T00:00:00Z',
        }),
        mark({
          messageId: 'p1-old',
          type: 'pending',
          priority: 1,
          markedAt: '2026-09-03T00:00:00Z',
        }),
      ],
      'pending',
      time,
    );
    expect(list.map((m) => m.messageId)).toEqual(['p1-old', 'p1-new', 'p2', 'u-old', 'u-new']);
  });

  it('resolve removes the row from the pending list', () => {
    const open = mark({ messageId: 'a', type: 'pending' });
    const before = indexMarks([open, mark({ messageId: 'b', type: 'pending' })]);
    expect(marksForTab(before.values(), 'pending', time)).toHaveLength(2);
    const after = new Map(before);
    after.set('a', { ...open, resolved: true });
    expect(marksForTab(after.values(), 'pending', time).map((m) => m.messageId)).toEqual(['b']);
    expect(markCounts(after.values()).pending).toBe(1);
  });

  it('row text is the first 80 chars, else the card title', () => {
    expect(markRowText(message({ body: 'x'.repeat(100) }), undefined)).toBe(`${'x'.repeat(80)}…`);
    expect(markRowText(message({ body: '', sharedBriefIds: ['b'] }), 'Autumn launch')).toBe(
      'Autumn launch',
    );
    expect(markRowText(message({ body: '', sharedBriefIds: ['b'] }), undefined)).toBe(
      'Shared brief',
    );
    expect(markRowText(undefined, undefined)).toBe('Message');
  });
});

describe('selection mode', () => {
  const marks = indexMarks([
    mark({ messageId: 'marked' }),
    mark({ messageId: 'resolved', type: 'pending', resolved: true }),
  ]);

  it("excludes others' messages and locks own marked ones (resolved included)", () => {
    expect(selectionRole(message({ id: 'own' }), marks)).toBe('selectable');
    expect(selectionRole(message({ id: 'theirs', mine: false }), marks)).toBe('none');
    expect(selectionRole(message({ id: 'marked' }), marks)).toBe('locked');
    expect(selectionRole(message({ id: 'resolved' }), marks)).toBe('locked');
    expect(selectionRole(message({ id: 'sending', state: 'sending' }), marks)).toBe('none');
  });

  it('toggles and prunes ids that stopped being selectable', () => {
    const selected = toggleSelected(toggleSelected(new Set(), 'own'), 'marked');
    expect([...selected]).toEqual(['own', 'marked']);
    expect([...toggleSelected(selected, 'own')]).toEqual(['marked']);
    const pruned = pruneSelection(
      selected,
      [message({ id: 'own' }), message({ id: 'marked' })],
      marks,
    );
    expect([...pruned]).toEqual(['own']);
    expect(deleteConfirmTitle(1)).toBe('Delete 1 message for everyone?');
    expect(deleteConfirmTitle(3)).toBe('Delete 3 messages for everyone?');
  });
});

describe('findInOlderPages (jump-to)', () => {
  function pager(pages: number, targetOn: number | null) {
    let page = 0;
    return vi.fn(() => {
      page += 1;
      const ids = [`p${page}-a`, `p${page}-b`];
      if (page === targetOn) ids.push('target');
      return Promise.resolve({
        ok: true as const,
        data: {
          rows: ids.map((id, i) =>
            row(id, `2026-09-${String(30 - page).padStart(2, '0')}T0${i}:00:00Z`),
          ),
          hasMore: page < pages,
        },
      });
    });
  }
  const start = { createdAt: '2026-09-30T00:00:00Z', id: 'newest' };

  it('loads older pages until the target is found, folding each page', async () => {
    const loadPage = pager(20, 3);
    const onPage = vi.fn();
    const outcome = await findInOlderPages({ start, targetId: 'target', loadPage, onPage });
    expect(outcome).toBe('found');
    expect(loadPage).toHaveBeenCalledTimes(3);
    expect(onPage).toHaveBeenCalledTimes(3);
    // Each next page continues from the oldest row of the previous one.
    expect((loadPage.mock.calls[1] as unknown[] | undefined)?.[0]).toEqual({
      createdAt: '2026-09-29T00:00:00Z',
      id: 'p1-a',
    });
  });

  it('gives up after 10 pages', async () => {
    const loadPage = pager(50, null);
    const outcome = await findInOlderPages({
      start,
      targetId: 'target',
      loadPage,
      onPage: vi.fn(),
    });
    expect(outcome).toBe('exhausted');
    expect(loadPage).toHaveBeenCalledTimes(10);
  });

  it('stops when history runs out, and reports a failed page', async () => {
    const loadPage = pager(2, null);
    expect(await findInOlderPages({ start, targetId: 'target', loadPage, onPage: vi.fn() })).toBe(
      'not_found',
    );
    expect(loadPage).toHaveBeenCalledTimes(2);
    expect(
      await findInOlderPages({
        start,
        targetId: 'target',
        loadPage: () => Promise.resolve({ ok: false, error: { code: 'unknown', message: 'x' } }),
        onPage: vi.fn(),
      }),
    ).toBe('error');
    expect(
      await findInOlderPages({ start: undefined, targetId: 't', loadPage, onPage: vi.fn() }),
    ).toBe('not_found');
  });
});

describe('mark reads and live signal', () => {
  it('maps rows, keeping priority for pending only', () => {
    const base = {
      message_id: 'm',
      channel_id: 'c',
      workspace_id: 'w',
      marked_at: 't',
      marked_by: null,
      resolved_by: null,
    };
    expect(rowToMark({ ...base, mark_type: 'pending', priority: 1, resolved_at: null })).toEqual({
      messageId: 'm',
      channelId: 'c',
      type: 'pending',
      priority: 1,
      markedAt: 't',
      resolved: false,
    });
    expect(
      rowToMark({ ...base, mark_type: 'decision', priority: 2, resolved_at: null })?.priority,
    ).toBeNull();
    expect(
      rowToMark({ ...base, mark_type: 'bogus', priority: null, resolved_at: null }),
    ).toBeUndefined();
  });

  it('loads every mark of a channel in one query', async () => {
    const eq = vi.fn(() =>
      Promise.resolve({
        data: [
          {
            message_id: 'm',
            channel_id: 'c',
            workspace_id: 'w',
            mark_type: 'pending',
            priority: null,
            marked_by: null,
            marked_at: 't',
            resolved_by: 'u',
            resolved_at: 't2',
          },
        ],
        error: null,
      }),
    );
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const result = await loadChannelMarks({ from } as unknown as Client, 'c');
    expect(from).toHaveBeenCalledWith('chat_message_marks');
    expect(eq).toHaveBeenCalledWith('channel_id', 'c');
    expect(result.ok && result.data[0]?.resolved).toBe(true);
  });

  it('routes a mark cmd to onMark under its own handler id', () => {
    const handlers: Record<string, AgoraChat.EventHandlerType> = {};
    const connection = {
      addEventHandler: vi.fn((id: string, h: AgoraChat.EventHandlerType) => {
        handlers[id] = h;
      }),
      removeEventHandler: vi.fn(),
    };
    const onMark = vi.fn();
    const teardown = subscribeMarkEvents(connection, onMark);
    const handler = handlers[MARKS_EVENT_HANDLER_ID];
    handler?.onCmdMessage?.({
      ext: markEventExt({ messageId: 'm7' }),
    } as unknown as AgoraChat.CmdMsgBody);
    handler?.onCmdMessage?.({
      ext: { sorted_event: 'read', message_id: 'x', channel_id: 'c' },
    } as unknown as AgoraChat.CmdMsgBody);
    expect(onMark).toHaveBeenCalledTimes(1);
    expect(onMark).toHaveBeenCalledWith('m7');
    teardown();
    expect(connection.removeEventHandler).toHaveBeenCalledWith(MARKS_EVENT_HANDLER_ID);
  });
});
