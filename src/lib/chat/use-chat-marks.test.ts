import { describe, expect, it, vi } from 'vitest';

// The hook module's import graph reaches the agora-chat browser SDK through the
// message factory; mock it so the framework-free transition imports in node.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import type { Client } from '@srtdio/rpc';
import { indexMarks, marksForTab, upsertMark, type ChatMark } from '@/lib/chat/marks';
import { runMarkTransition } from '@/lib/chat/use-chat-marks';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MARKED_AT = '2026-09-27T10:00:00+00:00';
const NOW = '2026-09-28T09:00:00.000Z';

function mark(over: Partial<ChatMark> = {}): ChatMark {
  return {
    messageId: 'm1',
    channelId: 'group__ws__g1',
    type: 'commitment',
    priority: null,
    markedAt: MARKED_AT,
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
    ...over,
  };
}

function fakeClient(error: { message: string } | null) {
  const rpc = vi.fn(() => Promise.resolve({ data: null, error }));
  return { db: { rpc } as unknown as Client, rpc };
}

/** A tiny store standing in for the hook's marks state. */
function store(initial: ChatMark) {
  let marks = indexMarks([initial]);
  const seen: Map<string, ChatMark>[] = [];
  return {
    apply: (next: ChatMark) => {
      marks = upsertMark(marks, next);
      seen.push(marks);
    },
    get: () => marks,
    seen,
  };
}

const time = (m: ChatMark): number => Date.parse(m.markedAt);

describe('runMarkTransition', () => {
  it('stamp: calls chat_mark_resolve once with message, channel and a uuid trace id; moves to History', async () => {
    const { db, rpc } = fakeClient(null);
    const s = store(mark());
    const { result, traceId } = await runMarkTransition({
      db,
      mark: mark(),
      action: 'resolve',
      actorId: 'u1',
      apply: s.apply,
      now: () => NOW,
    });
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('chat_mark_resolve', {
      p_message_id: 'm1',
      p_channel_id: 'group__ws__g1',
      p_trace_id: traceId,
    });
    expect(traceId).toMatch(UUID);
    // No user id is ever sent: the actor is auth.uid() server-side.
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('u1');
    expect(marksForTab(s.get().values(), 'open', time)).toEqual([]);
    const [row] = marksForTab(s.get().values(), 'history', time);
    expect(row).toMatchObject({ resolved: true, resolvedBy: 'u1', resolvedAt: NOW });
  });

  it('stamp failure: the row moves to History at once, then reverts to Open', async () => {
    const { db } = fakeClient({ message: 'no open mark on this message' });
    const s = store(mark());
    const { result } = await runMarkTransition({
      db,
      mark: mark(),
      action: 'resolve',
      actorId: 'u1',
      apply: s.apply,
    });
    expect(result.ok).toBe(false);
    expect(s.seen[0]?.get('m1')?.resolved).toBe(true);
    expect(s.get().get('m1')).toEqual(mark());
  });

  it('reopen: calls chat_mark_reopen once; the row returns to Open with its original marked time', async () => {
    const { db, rpc } = fakeClient(null);
    const stamped = mark({ resolved: true, resolvedBy: 'u2', resolvedAt: NOW });
    const s = store(stamped);
    const { result, traceId } = await runMarkTransition({
      db,
      mark: stamped,
      action: 'reopen',
      actorId: 'u1',
      apply: s.apply,
    });
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('chat_mark_reopen', {
      p_message_id: 'm1',
      p_channel_id: 'group__ws__g1',
      p_trace_id: traceId,
    });
    expect(traceId).toMatch(UUID);
    expect(marksForTab(s.get().values(), 'history', time)).toEqual([]);
    const [row] = marksForTab(s.get().values(), 'open', time);
    expect(row).toEqual(mark());
    expect(row?.markedAt).toBe(MARKED_AT);
  });

  it('reopen failure reverts the row to History', async () => {
    const { db } = fakeClient({ message: 'no resolved mark on this message' });
    const stamped = mark({ resolved: true, resolvedBy: 'u2', resolvedAt: NOW });
    const s = store(stamped);
    const { result } = await runMarkTransition({
      db,
      mark: stamped,
      action: 'reopen',
      actorId: 'u1',
      apply: s.apply,
    });
    expect(result.ok).toBe(false);
    expect(s.seen[0]?.get('m1')?.resolved).toBe(false);
    expect(s.get().get('m1')).toEqual(stamped);
  });

  it('a thrown transport error also reverts', async () => {
    const rpc = vi.fn(() => Promise.reject(new Error('offline')));
    const s = store(mark());
    const { result } = await runMarkTransition({
      db: { rpc } as unknown as Client,
      mark: mark(),
      action: 'resolve',
      actorId: 'u1',
      apply: s.apply,
    });
    expect(result.ok).toBe(false);
    expect(s.get().get('m1')).toEqual(mark());
  });
});
