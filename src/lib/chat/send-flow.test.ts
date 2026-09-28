import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOutboxSender,
  FAILED_AFTER_MS,
  LIVE_PUBLISH_TIMEOUT_MS,
  runSend,
  type SendFlowDeps,
  type SendInput,
  type SendOutcome,
} from '@/lib/chat/send-flow';
import {
  readPersistedOutbox,
  writePersistedOutbox,
  type Outbox,
  type OutboxEntry,
  type OutboxEvent,
  type OutboxStorage,
} from '@/lib/chat/chat-store';
import { rowToThreadMessage, type ChatMessageRow } from '@/lib/chat/thread';

const ME = '11111111-1111-4111-8111-111111111111';
const CHANNEL = 'group__ws__g1';
const ID = '019935a0-0000-7000-8000-000000000001';

function row(over: Partial<ChatMessageRow> = {}): ChatMessageRow {
  return {
    id: ID,
    channel_id: CHANNEL,
    workspace_id: 'ws',
    sender_user_id: ME,
    body: 'hello',
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: '2026-09-22T10:00:00.123456+00:00',
    edited_at: null,
    deleted_at: null,
    ...over,
  };
}

function input(over: Partial<SendInput> = {}): SendInput {
  return {
    id: ID,
    channelId: CHANNEL,
    currentUserId: ME,
    traceId: 'trace-1',
    text: 'hello',
    local: { attachments: [], sharedPostIds: [], reply: null },
    ...over,
  };
}

function deps(over: Partial<SendFlowDeps> = {}): SendFlowDeps & {
  order: string[];
} {
  const order: string[] = [];
  return {
    order,
    recordMessage: vi.fn(async () => {
      order.push('record');
      return { ok: true as const, row: row() };
    }),
    publishLive: vi.fn(async () => {
      order.push('publish');
      return {};
    }),
    onLiveWarning: vi.fn(),
    ...over,
  };
}

describe('runSend', () => {
  it('records through chat_message_send BEFORE the Agora publish and renders the returned row', async () => {
    const d = deps();
    const outcome = await runSend(d, input());

    expect(d.order).toEqual(['record', 'publish']);
    expect(d.recordMessage).toHaveBeenCalledWith({
      id: ID,
      channelId: CHANNEL,
      traceId: 'trace-1',
      body: 'hello',
      attachmentAssetIds: [],
      sharedPostIds: [],
      sharedBriefIds: [],
      replyToMessageId: null,
      attachmentMeta: {},
    });
    expect(d.publishLive).toHaveBeenCalledWith({
      id: ID,
      channelId: CHANNEL,
      text: 'hello',
      local: { attachments: [], sharedPostIds: [], reply: null },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.livePublished).toBe(true);
    // The bubble shows the SERVER created_at, never a local clock.
    expect(outcome.message.createdAt).toBe('2026-09-22T10:00:00.123456+00:00');
    expect(outcome.message.provisionalTime).toBe(false);
    expect(outcome.message.state).toBe('sent');
    expect(outcome.message.mine).toBe(true);
  });

  it('passes attachment version ids to the record', async () => {
    const d = deps();
    await runSend(
      d,
      input({
        text: '',
        local: {
          attachments: [{ assetId: 'v1', name: 'p.png', mime: 'image/png' }],
          sharedPostIds: [],
          reply: null,
        },
      }),
    );
    expect(d.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: '', attachmentAssetIds: ['v1'] }),
    );
  });

  it('keeps the message sent when the live publish fails, and only warns', async () => {
    const d = deps({ publishLive: vi.fn().mockRejectedValue(new Error('agora down')) });
    const outcome = await runSend(d, input());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.livePublished).toBe(false);
    expect(outcome.message.state).toBe('sent');
    expect(d.onLiveWarning).toHaveBeenCalledWith(
      expect.objectContaining({ trace_id: 'trace-1', message_id: ID, error: 'Error: agora down' }),
    );
  });

  it('still sends with no live connection at all', async () => {
    const d = deps({ publishLive: undefined });
    const outcome = await runSend(d, input());
    expect(outcome.ok && outcome.livePublished).toBe(false);
    expect(outcome.ok && outcome.message.state).toBe('sent');
    expect(d.onLiveWarning).toHaveBeenCalledOnce();
  });

  it('reports failed (and never publishes) when the record write fails or times out', async () => {
    const failing = deps({
      recordMessage: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'timeout', message: 'aborted' }),
    });
    const outcome = await runSend(failing, input());
    expect(outcome).toEqual({ ok: false, reason: 'timeout', error: 'aborted' });
    expect(failing.publishLive).not.toHaveBeenCalled();
  });

  it('retries with the SAME message id so the idempotent proc returns the one row', async () => {
    const recordMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'timeout', message: 'aborted' })
      .mockResolvedValueOnce({ ok: true, row: row() });
    const d = deps({ recordMessage });

    const first = await runSend(d, input({ traceId: 'trace-1' }));
    const second = await runSend(d, input({ traceId: 'trace-2' }));

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(true);
    expect(recordMessage.mock.calls[0]?.[0].id).toBe(ID);
    expect(recordMessage.mock.calls[1]?.[0].id).toBe(ID);
    // Each attempt is its own user action with its own trace id.
    expect(recordMessage.mock.calls[1]?.[0].traceId).toBe('trace-2');
  });

  it('persists shared posts, the reply target and attachment meta (shared-posts-only, no body)', async () => {
    const d = deps();
    const longTranscript = 'x'.repeat(2001);
    await runSend(
      d,
      input({
        text: '',
        local: {
          attachments: [
            { assetId: 'v1', name: 'p.png', mime: 'image/png', size: 120 },
            {
              assetId: 'v2',
              name: 'voice.webm',
              mime: 'audio/webm',
              size: 900,
              durationMs: 4000,
              transcript: 'hello there',
            },
            { assetId: 'v3', name: 'long.webm', mime: 'audio/webm', transcript: longTranscript },
          ],
          sharedPostIds: ['post-1'],
          reply: { id: 'quoted-1', authorUserId: ME, preview: 'hi' },
        },
      }),
    );
    expect(d.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: '',
        sharedPostIds: ['post-1'],
        replyToMessageId: 'quoted-1',
        attachmentMeta: {
          v1: { mime: 'image/png', name: 'p.png', size: 120 },
          v2: {
            mime: 'audio/webm',
            name: 'voice.webm',
            size: 900,
            duration_ms: 4000,
            transcript: 'hello there',
          },
          // Over 2000 chars: the transcript is left out of the record.
          v3: { mime: 'audio/webm', name: 'long.webm', size: 0 },
        },
      }),
    );
  });
});

describe('runSend shared briefs', () => {
  it('passes shared brief ids to the record; a briefs-only send is valid', async () => {
    const d = deps();
    const outcome = await runSend(
      d,
      input({
        text: '',
        local: { attachments: [], sharedPostIds: [], sharedBriefIds: ['brief-1'], reply: null },
      }),
    );
    expect(d.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: '', sharedBriefIds: ['brief-1'], sharedPostIds: [] }),
    );
    expect(outcome.ok && outcome.message.sharedBriefIds).toEqual(['brief-1']);
  });
});

describe('runSend live publish timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up on a hung Agora publish after 5s: warns, bubble stays sent, send resolves', async () => {
    vi.useFakeTimers();
    const onRecorded = vi.fn();
    const d = deps({ publishLive: vi.fn(() => new Promise<unknown>(() => {})), onRecorded });
    const pending = runSend(d, input());
    await vi.advanceTimersByTimeAsync(0);
    // The row exists: the bubble goes sent before Agora answers.
    expect(onRecorded).toHaveBeenCalledWith(expect.objectContaining({ id: ID, state: 'sent' }));
    await vi.advanceTimersByTimeAsync(LIVE_PUBLISH_TIMEOUT_MS);
    const outcome = await pending;
    expect(outcome.ok && outcome.livePublished).toBe(false);
    expect(outcome.ok && outcome.message.state).toBe('sent');
    expect(d.onLiveWarning).toHaveBeenCalledWith(
      expect.objectContaining({ message_id: ID, error: 'live publish timed out' }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timer when the publish settles first', async () => {
    vi.useFakeTimers();
    const d = deps();
    const outcome = await runSend(d, input());
    expect(outcome.ok && outcome.livePublished).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createOutboxSender (background send, retries, persistence)', () => {
  const OTHER = 'group__ws__g2';
  const SCOPE = { workspaceId: 'ws', userId: ME };

  afterEach(() => {
    vi.useRealTimers();
  });

  function entry(id: string): OutboxEntry {
    return {
      id,
      text: `body ${id}`,
      local: { attachments: [], sharedPostIds: [], reply: null },
      state: 'sending',
    };
  }

  type Script = ('ok' | 'fail' | 'pending')[];

  /** A sender whose record attempts follow `script` (then succeed). */
  function harness(opts: { script?: Script; initial?: Outbox; storage?: OutboxStorage } = {}) {
    const script = [...(opts.script ?? [])];
    const calls: { channelId: string; id: string; traceId: string }[] = [];
    const events: OutboxEvent[] = [];
    let traceSeq = 0;
    const sender = createOutboxSender(
      {
        deliver: async (channelId, e, traceId, onRecorded) => {
          calls.push({ channelId, id: e.id, traceId });
          const step = script.shift() ?? 'ok';
          if (step === 'pending') return new Promise<SendOutcome>(() => {});
          if (step === 'fail') return { ok: false, reason: 'timeout', error: 'rpc timed out' };
          const message = rowToThreadMessage(row({ id: e.id, channel_id: channelId }), ME);
          onRecorded(message);
          return { ok: true, message, livePublished: true };
        },
        newTraceId: () => `trace-${(traceSeq += 1)}`,
        onEvent: (event) => events.push(event),
        onChange: (next) => writePersistedOutbox(opts.storage ?? null, SCOPE, next),
        onAttemptFailed: () => {},
        now: () => Date.now(),
      },
      opts.initial,
    );
    return { sender, calls, events };
  }

  function memoryStorage(): OutboxStorage {
    const data = new Map<string, string>();
    return {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
      removeItem: (key) => {
        data.delete(key);
      },
    };
  }

  it('enqueue returns before the record resolves; the entry is sending at once', () => {
    const { sender, calls } = harness({ script: ['pending'] });
    sender.enqueue(CHANNEL, entry('m1'));
    expect(sender.entries(CHANNEL)).toEqual([entry('m1')]);
    expect(calls).toHaveLength(1);
  });

  it('RPC rejects 3 times then resolves: sending throughout, then sent; one id, a new trace each attempt', async () => {
    vi.useFakeTimers();
    const { sender, calls, events } = harness({ script: ['fail', 'fail', 'fail', 'ok'] });
    sender.enqueue(CHANNEL, entry('m1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.entries(CHANNEL)[0]?.state).toBe('sending');
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls).toHaveLength(3);
    expect(sender.entries(CHANNEL)[0]?.state).toBe('sending');
    await vi.advanceTimersByTimeAsync(8_000);
    expect(calls).toHaveLength(4);
    expect(sender.entries(CHANNEL)).toEqual([]);
    expect(new Set(calls.map((c) => c.id))).toEqual(new Set(['m1']));
    expect(new Set(calls.map((c) => c.traceId)).size).toBe(4);
    expect(events.some((e) => e.type === 'state' && e.state === 'failed')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'recorded', channelId: CHANNEL });
  });

  it('backs off 2s, 4s, 8s, 16s, 30s, then every 30s', async () => {
    vi.useFakeTimers();
    const { sender, calls } = harness({ script: Array<'fail'>(8).fill('fail') });
    sender.enqueue(CHANNEL, entry('m1'));
    await vi.advanceTimersByTimeAsync(0);
    const at: number[] = [];
    for (const wait of [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      at.push(calls.length);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(at).toEqual([1, 2, 3, 4, 5, 6]);
    expect(calls).toHaveLength(7);
  });

  it(`fails only after ${FAILED_AFTER_MS}ms of continuous failure; Retry resumes with the same id`, async () => {
    vi.useFakeTimers();
    const { sender, calls, events } = harness({ script: Array<'fail'>(50).fill('fail') });
    sender.enqueue(CHANNEL, entry('m1'));
    await vi.advanceTimersByTimeAsync(FAILED_AFTER_MS - 1);
    expect(sender.entries(CHANNEL)[0]?.state).toBe('sending');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sender.entries(CHANNEL)[0]?.state).toBe('failed');
    expect(events).toContainEqual({ type: 'state', channelId: CHANNEL, id: 'm1', state: 'failed' });
    const attempts = calls.length;
    // Stopped: no more attempts on their own.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toHaveLength(attempts);
    sender.retry(CHANNEL, 'm1');
    expect(sender.entries(CHANNEL)[0]?.state).toBe('sending');
    expect(calls).toHaveLength(attempts + 1);
    expect(calls.at(-1)?.id).toBe('m1');
    // A double tap while the retry is in flight sends nothing more.
    sender.retry(CHANNEL, 'm1');
    expect(calls).toHaveLength(attempts + 1);
  });

  it('keeps FIFO per channel under retries; other channels are independent', async () => {
    vi.useFakeTimers();
    const { sender, calls } = harness({ script: ['fail', 'ok', 'ok', 'fail', 'ok'] });
    sender.enqueue(CHANNEL, entry('m1'));
    sender.enqueue(CHANNEL, entry('m2'));
    sender.enqueue(OTHER, entry('o1'));
    await vi.advanceTimersByTimeAsync(0);
    // m1 failed; o1 went ahead in its own channel; m2 waits behind m1.
    expect(calls.map((c) => c.id)).toEqual(['m1', 'o1']);
    await vi.advanceTimersByTimeAsync(2_000);
    // m1 recorded, then m2 attempted (and failed), retried after 2s.
    expect(calls.map((c) => c.id)).toEqual(['m1', 'o1', 'm1', 'm2']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.map((c) => c.id)).toEqual(['m1', 'o1', 'm1', 'm2', 'm2']);
    expect(sender.entries(CHANNEL)).toEqual([]);
    expect(sender.entries(OTHER)).toEqual([]);
  });

  it('kick (reconnect / tab visible) retries at once instead of waiting out the backoff', async () => {
    vi.useFakeTimers();
    const { sender, calls } = harness({ script: ['fail', 'fail', 'ok'] });
    sender.enqueue(CHANNEL, entry('m1'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(2);
    sender.kick();
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.entries(CHANNEL)).toEqual([]);
  });

  it('a row read back by catch-up settles the entry and no duplicate is sent', async () => {
    vi.useFakeTimers();
    const { sender, calls } = harness({ script: ['fail'] });
    sender.enqueue(CHANNEL, entry('m1'));
    await vi.advanceTimersByTimeAsync(0);
    sender.settle(CHANNEL, 'm1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    expect(sender.entries(CHANNEL)).toEqual([]);
  });

  it('reload: persisted, restored for the same workspace and user only, and resumed', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const first = harness({ script: ['pending'], storage });
    first.sender.enqueue(CHANNEL, entry('m1'));
    first.sender.dispose();

    const elsewhere = readPersistedOutbox(storage, { workspaceId: 'other', userId: ME });
    expect(elsewhere).toEqual({});
    const reloaded = harness({ initial: readPersistedOutbox(storage, SCOPE), storage });
    // Same scope: the entry comes back as sending and its send resumes, same id.
    expect(reloaded.calls.map((c) => c.id)).toEqual(['m1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(reloaded.sender.entries(CHANNEL)).toEqual([]);
    expect(readPersistedOutbox(storage, SCOPE)).toEqual({});
  });

  it('a throwing localStorage never prevents the send', async () => {
    vi.useFakeTimers();
    const boom = (): never => {
      throw new Error('QuotaExceededError');
    };
    const { sender, calls } = harness({
      storage: { getItem: boom, setItem: boom, removeItem: boom },
    });
    expect(() => sender.enqueue(CHANNEL, entry('m1'))).not.toThrow();
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.entries(CHANNEL)).toEqual([]);
  });

  it('dispose clears every timer and ignores answers still in flight', async () => {
    vi.useFakeTimers();
    const { sender, calls, events } = harness({ script: ['fail'] });
    sender.enqueue(CHANNEL, entry('m1'));
    await vi.advanceTimersByTimeAsync(0);
    sender.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    expect(events).toEqual([]);
  });
});
