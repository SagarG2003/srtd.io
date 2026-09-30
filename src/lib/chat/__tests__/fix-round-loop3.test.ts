import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client, Result } from '@srtdio/rpc';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { LATE_READ_GRACE_MS, READ_TIMEOUT_MS, listChannelSummaries } from '@/lib/chat-reads';
import { attachmentPreviewKind } from '@/lib/chat/history';
import { editEventExt } from '@/lib/chat/thread';
import { routeGlobalCmd } from '@/components/chat/ChatStoreProvider';

afterEach(() => {
  vi.useRealTimers();
});

describe('first-load roster: a hung names read settles at 5s, the list lands', () => {
  it('registry at the late grace, users hanging: ok within 5s of the registry', async () => {
    vi.useFakeTimers();
    const from = (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'in', 'is']) b[m] = () => b;
      b.then = (resolve: (v: unknown) => unknown) =>
        (table === 'users'
          ? new Promise(() => {})
          : Promise.resolve({
              data:
                table === 'chat_channels'
                  ? [
                      {
                        channel_id: 'd1',
                        channel_type: 'dm',
                        entity_id: null,
                        agora_group_id: null,
                        dm_user_a: 'me',
                        dm_user_b: 'peer',
                        created_at: '2026-09-01T00:00:00Z',
                      },
                    ]
                  : [],
              error: null,
            })
        ).then(resolve);
      return b;
    };
    let result: Result<unknown> | null = null;
    void listChannelSummaries(
      { from } as unknown as Client,
      { workspaceId: 'w', currentUserId: 'me' },
      undefined,
      LATE_READ_GRACE_MS,
    ).then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    expect(result).toMatchObject({ ok: true });
  });
});

describe('a live edit of a message no chat shows as its line is not re-read', () => {
  it('isShownLine false: no read', async () => {
    const loadByIds = vi.fn(async () => ({ ok: true as const, data: [] }));
    await routeGlobalCmd(
      editEventExt({ messageId: 'm1', body: 'x', editedAt: '2026-09-30T10:00:00Z' }),
      {
        loadByIds,
        onDeleted: vi.fn(),
        onEdited: vi.fn(),
        isShownLine: () => false,
      },
    );
    expect(loadByIds).not.toHaveBeenCalled();
  });
});

describe('a .webm with no mime and no length is a file (may be a video)', () => {
  it('only a recorded length makes it a voice note', () => {
    expect(attachmentPreviewKind({ mime: '', name: 'clip.webm' })).toBe('file');
    expect(attachmentPreviewKind({ mime: '', name: 'note.webm', durationMs: 900 })).toBe('audio');
  });
});
