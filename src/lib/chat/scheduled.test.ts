import { describe, expect, it, vi } from 'vitest';
import {
  cancelScheduledMessage,
  customSummary,
  dateInputValue,
  formatClock,
  formatDayTime,
  formatSendLabel,
  fromInputs,
  inSentence,
  isWithinScheduleWindow,
  mapScheduleError,
  MAX_LEAD_MS,
  presetTimes,
  readScheduledMessages,
  rowMentions,
  scheduledCountLabel,
  scheduleMessage,
  sendScheduledNow,
  shortZoneName,
  soonestFirst,
  timeInputValue,
  updateScheduledMessage,
  type ScheduledRow,
} from '@/lib/chat/scheduled';
import type { Client } from '@srtdio/rpc';

const EM_DASH = String.fromCharCode(0x2014);

/** Local wall-clock time (the device zone, like the app). */
function at(y: number, m: number, d: number, h = 12, min = 0): Date {
  return new Date(y, m - 1, d, h, min, 0, 0);
}

describe('presetTimes', () => {
  it('Saturday: tomorrow is Sunday, Monday is the day after', () => {
    const p = presetTimes(at(2026, 10, 3, 15, 20));
    expect(p.tomorrow).toEqual(at(2026, 10, 4, 9));
    expect(p.monday).toEqual(at(2026, 10, 5, 9));
  });

  it('Sunday: Monday is tomorrow', () => {
    const p = presetTimes(at(2026, 10, 4, 8));
    expect(p.tomorrow).toEqual(at(2026, 10, 5, 9));
    expect(p.monday).toEqual(at(2026, 10, 5, 9));
  });

  it('Monday: the next Monday, a week ahead (never today)', () => {
    const p = presetTimes(at(2026, 10, 5, 7));
    expect(p.tomorrow).toEqual(at(2026, 10, 6, 9));
    expect(p.monday).toEqual(at(2026, 10, 12, 9));
  });

  it('rolls over the month', () => {
    const p = presetTimes(at(2026, 10, 31, 10)); // Saturday
    expect(p.tomorrow).toEqual(at(2026, 11, 1, 9));
    expect(p.monday).toEqual(at(2026, 11, 2, 9));
  });

  it('rolls over the year', () => {
    const p = presetTimes(at(2026, 12, 31, 22)); // Thursday
    expect(p.tomorrow).toEqual(at(2027, 1, 1, 9));
    expect(p.monday).toEqual(at(2027, 1, 4, 9));
  });

  it('always 9:00 AM local', () => {
    const p = presetTimes(at(2026, 3, 10, 23, 59));
    expect(p.tomorrow.getHours()).toBe(9);
    expect(p.tomorrow.getMinutes()).toBe(0);
    expect(p.monday.getHours()).toBe(9);
  });
});

describe('isWithinScheduleWindow', () => {
  const now = at(2026, 10, 3, 12);
  it('1 minute ahead is the earliest', () => {
    expect(isWithinScheduleWindow(new Date(now.getTime() + 60_000), now)).toBe(true);
    expect(isWithinScheduleWindow(new Date(now.getTime() + 59_999), now)).toBe(false);
    expect(isWithinScheduleWindow(now, now)).toBe(false);
    expect(isWithinScheduleWindow(new Date(now.getTime() - 60_000), now)).toBe(false);
  });

  it('365 days ahead is the latest', () => {
    expect(isWithinScheduleWindow(new Date(now.getTime() + MAX_LEAD_MS), now)).toBe(true);
    expect(isWithinScheduleWindow(new Date(now.getTime() + MAX_LEAD_MS + 1), now)).toBe(false);
  });

  it('an invalid date is outside', () => {
    expect(isWithinScheduleWindow(new Date(Number.NaN), now)).toBe(false);
  });
});

describe('labels', () => {
  const now = at(2026, 10, 3, 15);
  it('formatClock', () => {
    expect(formatClock(at(2026, 10, 4, 9))).toBe('9:00 AM');
    expect(formatClock(at(2026, 10, 4, 0, 5))).toBe('12:05 AM');
    expect(formatClock(at(2026, 10, 4, 12, 0))).toBe('12:00 PM');
    expect(formatClock(at(2026, 10, 4, 23, 30))).toBe('11:30 PM');
  });

  it('formatDayTime: the preset row text', () => {
    expect(formatDayTime(at(2026, 10, 4, 9), now)).toBe('Sun 4 Oct, 9:00 AM');
    expect(formatDayTime(at(2027, 1, 4, 9), now)).toBe('Mon 4 Jan 2027, 9:00 AM');
  });

  it('formatSendLabel: today, tomorrow, else the day', () => {
    expect(formatSendLabel(at(2026, 10, 3, 18), now)).toBe('Today 6:00 PM');
    expect(formatSendLabel(at(2026, 10, 4, 9), now)).toBe('Tomorrow 9:00 AM');
    expect(formatSendLabel(at(2026, 10, 7, 11, 30), now)).toBe('Wed 7 Oct, 11:30 AM');
  });

  it('formatSendLabel: tomorrow across a month and a year', () => {
    expect(formatSendLabel(at(2026, 11, 1, 9), at(2026, 10, 31, 20))).toBe('Tomorrow 9:00 AM');
    expect(formatSendLabel(at(2027, 1, 1, 9), at(2026, 12, 31, 20))).toBe('Tomorrow 9:00 AM');
  });

  it('inSentence lowers only today / tomorrow', () => {
    expect(inSentence('Tomorrow 9:00 AM')).toBe('tomorrow 9:00 AM');
    expect(inSentence('Today 6:00 PM')).toBe('today 6:00 PM');
    expect(inSentence('Wed 7 Oct, 11:30 AM')).toBe('Wed 7 Oct, 11:30 AM');
  });

  it('customSummary', () => {
    expect(customSummary(at(2026, 10, 7, 11, 30), now)).toBe('Sends Wed 7 Oct at 11:30 AM');
  });

  it('count label', () => {
    expect(scheduledCountLabel(1)).toBe('1 scheduled message');
    expect(scheduledCountLabel(3)).toBe('3 scheduled messages');
  });

  it('no em-dash in any label', () => {
    for (const s of [
      formatSendLabel(at(2026, 10, 7), now),
      customSummary(at(2026, 10, 7), now),
      formatDayTime(at(2026, 10, 7), now),
    ]) {
      expect(s).not.toContain(EM_DASH);
    }
  });
});

describe('inputs', () => {
  it('round-trips native input values in local time', () => {
    const d = at(2026, 1, 5, 7, 4);
    expect(dateInputValue(d)).toBe('2026-01-05');
    expect(timeInputValue(d)).toBe('07:04');
    expect(fromInputs('2026-01-05', '07:04')).toEqual(d);
  });

  it('an incomplete value is null', () => {
    expect(fromInputs('', '09:00')).toBeNull();
    expect(fromInputs('2026-01-05', '')).toBeNull();
  });
});

describe('shortZoneName', () => {
  it('comes from Intl, never a fixed zone', () => {
    const name = shortZoneName(new Date());
    expect(typeof name).toBe('string');
  });
});

describe('mapScheduleError', () => {
  it('maps the proc messages', () => {
    expect(mapScheduleError('send time must be between 1 minute and 1 year from now')).toBe(
      'Pick a time at least 1 minute from now',
    );
    expect(mapScheduleError('too many scheduled messages')).toBe(
      'You already have 100 scheduled messages',
    );
    expect(mapScheduleError('scheduled message not found')).toBeNull();
    expect(mapScheduleError('TypeError: fetch failed')).toBe("Couldn't schedule. Try again.");
  });
});

describe('rows', () => {
  const row = (id: string, sendAt: string, status = 'scheduled'): ScheduledRow =>
    ({ id, send_at: sendAt, status, mentions: null }) as unknown as ScheduledRow;

  it('soonestFirst keeps scheduled rows only, soonest first', () => {
    const out = soonestFirst([
      row('b', '2026-10-07T06:00:00Z'),
      row('x', '2026-10-04T06:00:00Z', 'cancelled'),
      row('a', '2026-10-04T03:30:00Z'),
    ]);
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('rowMentions reads a JSON array of ids only', () => {
    expect(rowMentions({ mentions: ['u1', 'all', 3] })).toEqual(['u1', 'all']);
    expect(rowMentions({ mentions: null })).toEqual([]);
  });
});

/** A recording fake of the Supabase client: rpc(name, args).abortSignal(). */
function fakeClient(answer: { data: unknown; error: { message: string } | null }) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: vi.fn((name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { abortSignal: () => Promise.resolve({ ...answer, status: 200 }) };
    }),
  } as unknown as Client;
  return { client, calls };
}

describe('proc wrappers', () => {
  const sendAt = new Date('2026-10-04T03:30:00.000Z');

  it('chat_message_schedule: trace id explicit, empty parts omitted', async () => {
    const { client, calls } = fakeClient({ data: { id: 'm1' }, error: null });
    const res = await scheduleMessage({
      client,
      id: 'm1',
      channelId: 'c1',
      sendAt,
      traceId: 't1',
      body: '  hi @[u1]  ',
      mentions: ['u1'],
      attachmentAssetIds: [],
      sharedPostIds: ['p1'],
      sharedBriefIds: [],
      replyToMessageId: 'r1',
    });
    expect(res.ok).toBe(true);
    expect(calls[0]).toEqual({
      name: 'chat_message_schedule',
      args: {
        p_id: 'm1',
        p_channel_id: 'c1',
        p_send_at: '2026-10-04T03:30:00.000Z',
        p_trace_id: 't1',
        p_body: 'hi @[u1]',
        p_mentions: ['u1'],
        p_shared_post_ids: ['p1'],
        p_reply_to_message_id: 'r1',
      },
    });
  });

  it('an error resolves with the raw message, never throws', async () => {
    const { client } = fakeClient({
      data: null,
      error: { message: 'too many scheduled messages' },
    });
    const res = await scheduleMessage({
      client,
      id: 'm1',
      channelId: 'c1',
      sendAt,
      traceId: 't1',
      body: 'x',
      mentions: [],
      attachmentAssetIds: [],
      sharedPostIds: [],
      sharedBriefIds: [],
      replyToMessageId: null,
    });
    expect(res).toMatchObject({
      ok: false,
      reason: 'error',
      message: 'too many scheduled messages',
    });
  });

  it('update, cancel and send now pass p_id and p_trace_id', async () => {
    const { client, calls } = fakeClient({ data: { id: 'm1' }, error: null });
    await updateScheduledMessage({
      client,
      id: 'm1',
      sendAt,
      body: 'b',
      mentions: [],
      traceId: 't2',
    });
    await cancelScheduledMessage({ client, id: 'm1', traceId: 't3' });
    await sendScheduledNow({ client, id: 'm1', traceId: 't4' });
    expect(calls.map((c) => c.name)).toEqual([
      'chat_scheduled_update',
      'chat_scheduled_cancel',
      'chat_scheduled_send_now',
    ]);
    expect(calls[0]?.args).toEqual({
      p_id: 'm1',
      p_send_at: '2026-10-04T03:30:00.000Z',
      p_body: 'b',
      p_mentions: [],
      p_trace_id: 't2',
    });
    expect(calls[1]?.args).toEqual({ p_id: 'm1', p_trace_id: 't3' });
    expect(calls[2]?.args).toEqual({ p_id: 'm1', p_trace_id: 't4' });
  });

  it('a throw resolves to a failure', async () => {
    const client = {
      rpc: () => {
        throw new Error('boom');
      },
    } as unknown as Client;
    const res = await cancelScheduledMessage({ client, id: 'm1', traceId: 't' });
    expect(res.ok).toBe(false);
  });
});

describe('readScheduledMessages', () => {
  it('filters to the chat and status scheduled, soonest first', async () => {
    const filters: Array<[string, unknown]> = [];
    const builder = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return builder;
      },
      order: () =>
        Promise.resolve({
          data: [
            { id: 'b', send_at: '2026-10-07T06:00:00Z', status: 'scheduled' },
            { id: 'a', send_at: '2026-10-04T03:30:00Z', status: 'scheduled' },
          ],
          error: null,
        }),
    };
    const client = { from: () => builder } as unknown as Client;
    const res = await readScheduledMessages(client, { channelId: 'c1' });
    expect(filters).toEqual([
      ['channel_id', 'c1'],
      ['status', 'scheduled'],
    ]);
    expect(res.ok && res.data.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
