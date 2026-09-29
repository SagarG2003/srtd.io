import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import { runDelete, runEdit } from '@/lib/chat/delete-flow';
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

  it('records in chunks of 100, marks each chunk deleted locally and sends the delete cmd per chunk', async () => {
    const { client: db, rpc } = client();
    const markDeletedLocal = vi.fn();
    const signal = vi.fn(() => Promise.resolve({}));
    const result = await runDelete(
      { client: db, markDeletedLocal, signal, onSignalFailed: vi.fn() },
      { channelId: 'c', messageIds: ids, traceId: 't' },
    );
    expect(result).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(markDeletedLocal.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      ids.slice(0, 100),
      ids.slice(100),
    ]);
    const exts = signal.mock.calls.map((c) => parseLiveEvent((c as unknown[])[0]));
    expect(exts).toEqual([
      { kind: 'delete', messageIds: ids.slice(0, 100) },
      { kind: 'delete', messageIds: ids.slice(100) },
    ]);
  });

  it('a failed record marks nothing, signals nothing and returns the proc message', async () => {
    const { client: db } = client(true);
    const markDeletedLocal = vi.fn();
    const signal = vi.fn(() => Promise.resolve({}));
    const result = await runDelete(
      { client: db, markDeletedLocal, signal, onSignalFailed: vi.fn() },
      { channelId: 'c', messageIds: ['a'], traceId: 't' },
    );
    expect(result).toEqual({ ok: false, message: 'nope', deleted: [] });
    expect(markDeletedLocal).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it('a failed signal never fails the delete', async () => {
    const { client: db } = client();
    const onSignalFailed = vi.fn();
    const result = await runDelete(
      {
        client: db,
        markDeletedLocal: vi.fn(),
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

describe('runEdit', () => {
  const row = { id: 'm1', body: 'new', edited_at: '2026-09-22T10:05:00+00:00' };

  function editClient(result: { data: unknown; error: { message: string } | null }): {
    client: Client;
    rpc: ReturnType<typeof vi.fn>;
  } {
    const rpc = vi.fn(() => ({
      abortSignal: () => Promise.resolve(result),
    }));
    return { client: { rpc } as unknown as Client, rpc };
  }

  it('records first, then shows the returned row, then signals the edit event', async () => {
    const order: string[] = [];
    const { client, rpc } = editClient({ data: row, error: null });
    rpc.mockImplementation(() => {
      order.push('record');
      return { abortSignal: () => Promise.resolve({ data: row, error: null }) };
    });
    const applyLocal = vi.fn(() => order.push('local'));
    const signal = vi.fn(() => {
      order.push('signal');
      return Promise.resolve({});
    });
    const result = await runEdit(
      { client, applyLocal, signal, onSignalFailed: vi.fn() },
      { channelId: 'c', messageId: 'm1', body: 'new', traceId: 't' },
    );
    expect(result).toEqual({ ok: true });
    expect(order).toEqual(['record', 'local', 'signal']);
    expect(applyLocal).toHaveBeenCalledWith(row);
    expect(parseLiveEvent((signal.mock.calls[0] as unknown[])[0])).toEqual({
      kind: 'edit',
      messageId: 'm1',
      body: 'new',
      editedAt: '2026-09-22T10:05:00+00:00',
    });
  });

  it('a failed record changes nothing locally, signals nothing and returns the mapped copy', async () => {
    const { client } = editClient({ data: null, error: { message: 'edit window has closed' } });
    const applyLocal = vi.fn();
    const signal = vi.fn(() => Promise.resolve({}));
    const result = await runEdit(
      { client, applyLocal, signal, onSignalFailed: vi.fn() },
      { channelId: 'c', messageId: 'm1', body: 'new', traceId: 't' },
    );
    expect(result).toEqual({
      ok: false,
      message: 'Edit window has closed (15 min)',
      error: 'edit window has closed',
    });
    expect(applyLocal).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
  });

  it('a failed signal never fails the edit', async () => {
    const { client } = editClient({ data: row, error: null });
    const onSignalFailed = vi.fn();
    const result = await runEdit(
      {
        client,
        applyLocal: vi.fn(),
        signal: () => Promise.reject(new Error('offline')),
        onSignalFailed,
      },
      { channelId: 'c', messageId: 'm1', body: 'new', traceId: 't' },
    );
    expect(result).toEqual({ ok: true });
    await vi.waitFor(() => expect(onSignalFailed).toHaveBeenCalledOnce());
  });
});
