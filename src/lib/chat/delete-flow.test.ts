import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import { runDelete } from '@/lib/chat/delete-flow';
import { parseLiveEvent } from '@/lib/chat/thread';

function client(fail = false): { client: Client; rpc: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn(() =>
    Promise.resolve(
      fail ? { data: null, error: { message: 'nope' } } : { data: null, error: null },
    ),
  );
  return { client: { rpc } as unknown as Client, rpc };
}

describe('runDelete', () => {
  const ids = Array.from({ length: 150 }, (_, i) => `m${i}`);

  it('records in chunks of 100, removes each chunk locally and sends the delete cmd per chunk', async () => {
    const { client: db, rpc } = client();
    const removeLocal = vi.fn();
    const signal = vi.fn(() => Promise.resolve({}));
    const result = await runDelete(
      { client: db, removeLocal, signal, onSignalFailed: vi.fn() },
      { channelId: 'c', messageIds: ids, traceId: 't' },
    );
    expect(result).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(removeLocal.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      ids.slice(0, 100),
      ids.slice(100),
    ]);
    const exts = signal.mock.calls.map((c) => parseLiveEvent((c as unknown[])[0]));
    expect(exts).toEqual([
      { kind: 'delete', messageIds: ids.slice(0, 100) },
      { kind: 'delete', messageIds: ids.slice(100) },
    ]);
  });

  it('a failed record removes nothing, signals nothing and returns the proc message', async () => {
    const { client: db } = client(true);
    const removeLocal = vi.fn();
    const signal = vi.fn(() => Promise.resolve({}));
    const result = await runDelete(
      { client: db, removeLocal, signal, onSignalFailed: vi.fn() },
      { channelId: 'c', messageIds: ['a'], traceId: 't' },
    );
    expect(result).toEqual({ ok: false, message: 'nope', deleted: [] });
    expect(removeLocal).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it('a failed signal never fails the delete', async () => {
    const { client: db } = client();
    const onSignalFailed = vi.fn();
    const result = await runDelete(
      {
        client: db,
        removeLocal: vi.fn(),
        signal: () => Promise.reject(new Error('offline')),
        onSignalFailed,
      },
      { channelId: 'c', messageIds: ['a'], traceId: 't' },
    );
    await Promise.resolve();
    expect(result).toEqual({ ok: true });
    await vi.waitFor(() => expect(onSignalFailed).toHaveBeenCalledOnce());
  });
});
