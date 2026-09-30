// A pending own bubble's time: the device clock at the Send tap, never another
// message's time and never epoch; its day pill shows at send; it sorts after
// every recorded row; the recorded row replaces it in place with the same id.

import { describe, expect, it, vi } from 'vitest';

// MessageThread's import graph pulls the real agora-chat browser SDK; mock it
// so importing the module in node never touches browser globals.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
import {
  compareMessages,
  rowToThreadMessage,
  upsertMessage,
  withOutboxBubbles,
  type ChatMessageRow,
  type ThreadMessage,
  type UnrecordedSend,
} from '@/lib/chat/thread';
import { withDaySeparators } from '@/components/chat/day-separators';
import { bubbleMeta, messageTimeSource } from '@/components/chat/MessageThread';
import { formatClockTime } from '@/lib/chat/time-format';

const ME = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const TZ = 'UTC';

function row(over: Partial<ChatMessageRow>): ChatMessageRow {
  return {
    id: 'r',
    channel_id: 'c1',
    workspace_id: 'ws',
    sender_user_id: PEER,
    body: 'hello',
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: '2026-09-29T21:00:00+00:00',
    edited_at: null,
    deleted_at: null,
    ...over,
  };
}

function send(id: string, createdMs: number): UnrecordedSend {
  return {
    id,
    text: `body ${id}`,
    local: { attachments: [], sharedPostIds: [], reply: null },
    state: 'sending',
    createdMs,
  };
}

const YESTERDAY_ROW = rowToThreadMessage(row({ id: 'y1' }), ME);
const TAP = Date.parse('2026-09-30T09:15:00Z');

describe('pending bubble time', () => {
  it('the optimistic time is the enqueue clock, not the previous message time + 1ms', () => {
    const [, pending] = withOutboxBubbles([YESTERDAY_ROW], [send('p1', TAP)], ME);
    expect(pending?.localSentMs).toBe(TAP);
    expect(pending?.time).toBe(TAP);
    expect(messageTimeSource(pending as ThreadMessage)).toBe(TAP);
    expect(bubbleMeta(pending as ThreadMessage, TZ, { showTicks: true }).time).toBe(
      formatClockTime(TAP, TZ),
    );
    expect(bubbleMeta(pending as ThreadMessage, TZ, { showTicks: true }).time).not.toBe(
      formatClockTime(YESTERDAY_ROW.time + 1, TZ),
    );
  });

  it('an empty chat never shows epoch', () => {
    const [pending] = withOutboxBubbles([], [send('p1', TAP)], ME);
    expect(pending?.time).toBe(TAP);
    expect(messageTimeSource(pending as ThreadMessage)).toBe(TAP);
    expect(bubbleMeta(pending as ThreadMessage, TZ, { showTicks: false }).time).toBe(
      formatClockTime(TAP, TZ),
    );
    // A send persisted before its tap time was kept reads the given now, not 0.
    const legacy: UnrecordedSend = { ...send('p0', TAP) };
    delete legacy.createdMs;
    const [restored] = withOutboxBubbles([], [legacy], ME, TAP + 5);
    expect(restored?.time).toBe(TAP + 5);
  });

  it('a first-of-day send shows the "Today" pill before its row lands', () => {
    const list = withOutboxBubbles([YESTERDAY_ROW], [send('p1', TAP)], ME);
    const items = withDaySeparators(list, TAP + 60_000, TZ);
    expect(items.map((i) => (i.kind === 'day' ? i.label : i.message.id))).toEqual([
      'Yesterday',
      'y1',
      'Today',
      'p1',
    ]);
  });

  it('pending sorts after every recorded row, even one timed after the tap', () => {
    const [pending] = withOutboxBubbles([], [send('p1', TAP)], ME);
    // A peer's row lands (live) with a later server time while p1 is pending.
    const later = rowToThreadMessage(
      row({ id: 'r2', created_at: new Date(TAP + 30_000).toISOString() }),
      ME,
    );
    const list = upsertMessage([YESTERDAY_ROW, pending as ThreadMessage], later);
    expect(list.map((m) => m.id)).toEqual(['y1', 'r2', 'p1']);
    expect(compareMessages(pending as ThreadMessage, later)).toBeGreaterThan(0);
  });

  it('the recorded row replaces the bubble in place with the same id', () => {
    const list = withOutboxBubbles([YESTERDAY_ROW], [send('p1', TAP), send('p2', TAP + 1)], ME);
    const recorded = rowToThreadMessage(
      row({ id: 'p1', sender_user_id: ME, created_at: new Date(TAP + 400).toISOString() }),
      ME,
    );
    const next = upsertMessage(list, recorded);
    expect(next.map((m) => m.id)).toEqual(['y1', 'p1', 'p2']);
    expect(next[1]?.state).toBe('sent');
    expect(next[1]?.createdAt).toBe(new Date(TAP + 400).toISOString());
    // Same minute: the label does not change.
    expect(bubbleMeta(next[1] as ThreadMessage, TZ, { showTicks: true }).time).toBe(
      bubbleMeta(list[1] as ThreadMessage, TZ, { showTicks: true }).time,
    );
  });
});
