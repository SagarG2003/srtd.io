import { describe, expect, it, vi } from 'vitest';
import type { SendRecordResult } from '@/lib/chat/record';
import type { ChatMessageRow, LiveMessageIds } from '@/lib/chat/thread';
import { createInFlightGuard } from '@/lib/chat/thread-actions';
import {
  sharePostToChannel,
  type SharePostDeps,
  type SharePostRecordInput,
} from '@/lib/chat/share-post';

const ROW_ID = 'row-1';
const INPUT = { channelId: 'ch-1', postId: 'post-1' };

function okRecord(): SendRecordResult {
  return { ok: true, row: { id: ROW_ID } as ChatMessageRow };
}

function deps(overrides: Partial<SharePostDeps> = {}): SharePostDeps {
  return {
    guard: createInFlightGuard(),
    record: vi.fn(() => Promise.resolve(okRecord())),
    publish: null,
    newMessageId: () => 'msg-1',
    newTraceId: () => 'trace-1',
    onPublishFailed: vi.fn(),
    ...overrides,
  };
}

describe('sharePostToChannel: record first, never gated on the live connection', () => {
  it('no live connection: records the shared post and succeeds without publishing', async () => {
    const record = vi.fn<(input: SharePostRecordInput) => Promise<SendRecordResult>>(() =>
      Promise.resolve(okRecord()),
    );
    const result = await sharePostToChannel(deps({ record, publish: null }), INPUT);
    expect(result).toEqual({ ok: true });
    expect(record).toHaveBeenCalledWith({
      id: 'msg-1',
      channelId: 'ch-1',
      traceId: 'trace-1',
      body: '',
      attachmentAssetIds: [],
      sharedPostIds: ['post-1'],
    });
  });

  it('record fails: reports the failure and never publishes', async () => {
    const publish = vi.fn(() => Promise.resolve());
    const result = await sharePostToChannel(
      deps({
        record: () => Promise.resolve({ ok: false, reason: 'error', message: 'refused' }),
        publish,
      }),
      INPUT,
    );
    expect(result).toEqual({ ok: false, reason: 'record', message: 'refused' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('record ok and live: publishes after the record with the returned row ids', async () => {
    const order: string[] = [];
    const publish = vi.fn<(ids: LiveMessageIds) => Promise<void>>(() => {
      order.push('publish');
      return Promise.resolve();
    });
    const result = await sharePostToChannel(
      deps({
        record: () => {
          order.push('record');
          return Promise.resolve(okRecord());
        },
        publish,
      }),
      INPUT,
    );
    expect(result).toEqual({ ok: true });
    expect(order).toEqual(['record', 'publish']);
    expect(publish).toHaveBeenCalledWith({ sorted_message_id: ROW_ID, sorted_channel_id: 'ch-1' });
  });

  it('live publish rejects: still succeeds and reports the publish failure', async () => {
    const onPublishFailed = vi.fn();
    const result = await sharePostToChannel(
      deps({ publish: () => Promise.reject(new Error('boom')), onPublishFailed }),
      INPUT,
    );
    expect(result).toEqual({ ok: true });
    expect(onPublishFailed).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 'trace-1', messageId: ROW_ID }),
    );
  });

  it('live publish throws synchronously: still succeeds', async () => {
    const result = await sharePostToChannel(
      deps({
        publish: () => {
          throw new Error('sync boom');
        },
      }),
      INPUT,
    );
    expect(result).toEqual({ ok: true });
  });

  it('live publish slower than the timeout: still succeeds', async () => {
    const onPublishFailed = vi.fn();
    const result = await sharePostToChannel(
      deps({
        publish: () => new Promise(() => {}),
        publishTimeoutMs: 5,
        onPublishFailed,
      }),
      INPUT,
    );
    expect(result).toEqual({ ok: true });
    expect(onPublishFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'live publish timed out' }),
    );
  });

  it('Notes channel (no live target): records, no publish', async () => {
    const record = vi.fn(() => Promise.resolve(okRecord()));
    const result = await sharePostToChannel(deps({ record, publish: null }), {
      channelId: 'notes-1',
      postId: 'post-1',
    });
    expect(result).toEqual({ ok: true });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('double tap: one record; the second tap is reported busy', async () => {
    let release: (v: SendRecordResult) => void = () => {};
    const record = vi
      .fn<(input: SharePostRecordInput) => Promise<SendRecordResult>>(() =>
        Promise.resolve(okRecord()),
      )
      .mockImplementationOnce(
        () =>
          new Promise<SendRecordResult>((resolve) => {
            release = resolve;
          }),
      );
    const shared = deps({ record });
    const first = sharePostToChannel(shared, INPUT);
    const second = await sharePostToChannel(shared, INPUT);
    expect(second).toEqual({ ok: false, reason: 'busy' });
    release(okRecord());
    expect(await first).toEqual({ ok: true });
    expect(record).toHaveBeenCalledTimes(1);
    // The guard frees after the first settles.
    expect(await sharePostToChannel(shared, INPUT)).toEqual({ ok: true });
    expect(record).toHaveBeenCalledTimes(2);
  });
});
