// Files of pending sends survive a reload: stored at enqueue, read back onto
// restored entries on boot, deleted on success and on Remove, and a throwing
// or missing IndexedDB falls back to today's filesMissing state.

import { describe, expect, it } from 'vitest';
import {
  clearOutboxFiles,
  deleteOutboxFiles,
  openIndexedDbFiles,
  outboxFileKey,
  pruneOutboxFiles,
  restoreOutboxFiles,
  saveOutboxFiles,
  type OutboxFileAdapter,
  type StoredOutboxFile,
} from '@/lib/chat/outbox-files';
import {
  awaitRestoredFiles,
  persistedOutboxIds,
  readPersistedOutbox,
  writePersistedOutbox,
  type OutboxEntry,
  type OutboxStorage,
} from '@/lib/chat/chat-store';
import { createOutboxSender } from '@/lib/chat/send-flow';
import { rowToThreadMessage, type ChatMessageRow } from '@/lib/chat/thread';

const ME = '11111111-1111-4111-8111-111111111111';
const CHANNEL = 'group__ws__g1';
const SCOPE = { workspaceId: 'ws', userId: ME };

/** An in-memory stand-in for IndexedDB. */
function fakeAdapter(): OutboxFileAdapter & { data: Map<string, StoredOutboxFile> } {
  const data = new Map<string, StoredOutboxFile>();
  return {
    data,
    put: async (key, value) => {
      data.set(key, value);
    },
    get: async (key) => data.get(key),
    keys: async () => [...data.keys()],
    delete: async (keys) => {
      for (const key of keys) data.delete(key);
    },
    clear: async () => {
      data.clear();
    },
    close: () => {},
  };
}

/** Every call throws, like a blocked or broken IndexedDB. */
function throwingAdapter(): OutboxFileAdapter {
  const boom = async (): Promise<never> => {
    throw new Error('InvalidStateError');
  };
  return { put: boom, get: boom, keys: boom, delete: boom, clear: boom, close: () => {} };
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

function withFiles(id: string): OutboxEntry {
  return {
    id,
    text: '',
    local: {
      attachments: [
        { assetId: 'ver-done', name: 'done.png', mime: 'image/png', size: 1 },
        {
          assetId: '',
          name: 'a.png',
          mime: 'image/png',
          size: 3,
          local: {
            key: 'local-a',
            file: new File(['abc'], 'a.png', { type: 'image/png', lastModified: 42 }),
            previewUrl: 'blob:a',
            progress: 0,
          },
        },
        {
          assetId: '',
          name: 'voice-note.webm',
          mime: 'audio/webm',
          size: 4,
          durationMs: 2000,
          local: {
            key: 'local-v',
            file: new File(['wxyz'], 'voice-note.webm', { type: 'audio/webm' }),
            previewUrl: null,
            progress: 0,
          },
        },
      ],
      sharedPostIds: [],
      reply: null,
    },
    state: 'sending',
    createdMs: 1_700_000_000_000,
  };
}

/** The entry as a reload reads it back from localStorage (no File objects). */
function reloaded(entry: OutboxEntry): OutboxEntry {
  const storage = memoryStorage();
  writePersistedOutbox(storage, SCOPE, { [CHANNEL]: [entry] });
  const restored = readPersistedOutbox(storage, SCOPE)[CHANNEL]?.[0];
  if (restored === undefined) throw new Error('not persisted');
  return restored;
}

describe('outbox-files', () => {
  it('stores each file still to upload, keyed by entry id + index', async () => {
    const adapter = fakeAdapter();
    expect(await saveOutboxFiles(adapter, withFiles('m1'))).toBe(true);
    expect([...adapter.data.keys()].sort()).toEqual([
      outboxFileKey('m1', 1),
      outboxFileKey('m1', 2),
    ]);
    expect(adapter.data.get('m1:1')).toMatchObject({
      entryId: 'm1',
      index: 1,
      name: 'a.png',
      type: 'image/png',
      lastModified: 42,
    });
  });

  it('restore on boot: the reloaded entry waits (clock), then gets its files back and uploads', async () => {
    const adapter = fakeAdapter();
    await saveOutboxFiles(adapter, withFiles('m1'));
    const restoredEntry = reloaded(withFiles('m1'));
    // localStorage alone: filesMissing, as before.
    expect(restoredEntry).toMatchObject({ state: 'failed', filesMissing: true });
    expect(restoredEntry.createdMs).toBe(1_700_000_000_000);
    // With a file store it waits for its bytes instead.
    const waiting = awaitRestoredFiles({ [CHANNEL]: [restoredEntry] })[CHANNEL]?.[0];
    expect(waiting).toMatchObject({ state: 'sending', restoring: true });
    expect(waiting?.filesMissing).toBeUndefined();

    const attachments = await restoreOutboxFiles(adapter, restoredEntry, (file) =>
      file.type.startsWith('image/') ? `blob:restored-${file.name}` : null,
    );
    expect(attachments).not.toBeNull();
    expect(attachments?.[0]).toEqual({
      assetId: 'ver-done',
      name: 'done.png',
      mime: 'image/png',
      size: 1,
    });
    expect(attachments?.[1]?.local?.file?.name).toBe('a.png');
    expect(attachments?.[1]?.local?.previewUrl).toBe('blob:restored-a.png');
    expect(await attachments?.[1]?.local?.file?.text()).toBe('abc');
    expect(attachments?.[2]).toMatchObject({ durationMs: 2000, mime: 'audio/webm' });
    expect(await attachments?.[2]?.local?.file?.text()).toBe('wxyz');

    // The sender resumes it with the restored files and its fallback uploader.
    const uploaded: string[] = [];
    const recorded: string[] = [];
    const sender = createOutboxSender(
      {
        deliver: async (channelId, e, _trace, onRecorded) => {
          recorded.push(...e.local.attachments.map((a) => a.assetId));
          const row = { id: e.id, channel_id: channelId, created_at: '2026-09-30T10:00:00Z' };
          const message = rowToThreadMessage(row as ChatMessageRow, ME);
          onRecorded(message);
          return { ok: true, message, livePublished: false };
        },
        newTraceId: () => 't',
        onEvent: () => {},
        onChange: () => {},
        onAttemptFailed: () => {},
        upload: async (file) => {
          uploaded.push(file.name);
          return { ok: true, reused: false, versionId: `ver-${file.name}` };
        },
      },
      { [CHANNEL]: waiting !== undefined ? [waiting] : [] },
    );
    sender.restoreFiles(CHANNEL, 'm1', attachments);
    await expect.poll(() => recorded).toEqual(['ver-done', 'ver-a.png', 'ver-voice-note.webm']);
    expect(uploaded).toEqual(['a.png', 'voice-note.webm']);
  });

  it('delete on record success and on Remove drops only that entry', async () => {
    const adapter = fakeAdapter();
    await saveOutboxFiles(adapter, withFiles('m1'));
    await saveOutboxFiles(adapter, withFiles('m2'));
    await deleteOutboxFiles(adapter, ['m1']);
    expect([...adapter.data.keys()].sort()).toEqual(['m2:1', 'm2:2']);
    await deleteOutboxFiles(adapter, ['m2']);
    expect(adapter.data.size).toBe(0);
  });

  it('boot prunes blobs of entries no longer persisted; sign-out clears all', async () => {
    const adapter = fakeAdapter();
    await saveOutboxFiles(adapter, withFiles('kept'));
    await saveOutboxFiles(adapter, withFiles('orphan'));
    const storage = memoryStorage();
    writePersistedOutbox(storage, SCOPE, { [CHANNEL]: [withFiles('kept')] });
    const keep = persistedOutboxIds(storage);
    expect(keep).toEqual(new Set(['kept']));
    await pruneOutboxFiles(adapter, (id) => keep?.has(id) === true);
    expect([...adapter.data.keys()].sort()).toEqual(['kept:1', 'kept:2']);
    await clearOutboxFiles(adapter);
    expect(adapter.data.size).toBe(0);
  });

  it('a send queued while the boot prune runs keeps its files', async () => {
    const adapter = fakeAdapter();
    await saveOutboxFiles(adapter, withFiles('fresh'));
    const held = new Set<string>(['fresh']);
    await pruneOutboxFiles(adapter, (id) => held.has(id));
    expect([...adapter.data.keys()].sort()).toEqual(['fresh:1', 'fresh:2']);
  });

  it('a missing blob falls back to filesMissing (null)', async () => {
    const adapter = fakeAdapter();
    await saveOutboxFiles(adapter, withFiles('m1'));
    adapter.data.delete('m1:2');
    expect(await restoreOutboxFiles(adapter, reloaded(withFiles('m1')))).toBeNull();
  });

  it('IndexedDB throwing (or absent) never throws and falls back to filesMissing', async () => {
    const broken = throwingAdapter();
    const entry = reloaded(withFiles('m1'));
    await expect(saveOutboxFiles(broken, withFiles('m1'))).resolves.toBe(false);
    await expect(restoreOutboxFiles(broken, entry)).resolves.toBeNull();
    await expect(deleteOutboxFiles(broken, ['m1'])).resolves.toBeUndefined();
    await expect(pruneOutboxFiles(broken, () => false)).resolves.toBeUndefined();
    await expect(clearOutboxFiles(broken)).resolves.toBeUndefined();
    await expect(saveOutboxFiles(null, withFiles('m1'))).resolves.toBe(false);
    await expect(restoreOutboxFiles(null, entry)).resolves.toBeNull();
    // No IndexedDB in this environment: no adapter, so the provider keeps filesMissing.
    expect(openIndexedDbFiles()).toBeNull();
    const sender = createOutboxSender(
      {
        deliver: async () => ({ ok: false, reason: 'error', error: 'unused' }),
        newTraceId: () => 't',
        onEvent: () => {},
        onChange: () => {},
        onAttemptFailed: () => {},
      },
      { [CHANNEL]: [entry] },
    );
    sender.restoreFiles(CHANNEL, 'm1', null);
    expect(sender.entries(CHANNEL)[0]).toMatchObject({ state: 'failed', filesMissing: true });
    sender.dispose();
  });

  it('an IDBFactory whose open throws yields calls that reject, never a throw at open', async () => {
    const factory = {
      open: () => {
        throw new Error('SecurityError');
      },
    } as unknown as IDBFactory;
    const adapter = openIndexedDbFiles(factory);
    expect(adapter).not.toBeNull();
    await expect(saveOutboxFiles(adapter, withFiles('m1'))).resolves.toBe(false);
    await expect(restoreOutboxFiles(adapter, reloaded(withFiles('m1')))).resolves.toBeNull();
    adapter?.close();
  });
});
