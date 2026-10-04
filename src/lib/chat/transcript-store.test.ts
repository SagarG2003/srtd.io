import { describe, expect, it, vi } from 'vitest';
import {
  VOICE_STORE_KEY,
  canOfferTranscribe,
  clearVoiceTranscripts,
  createVoiceStore,
  parseVoiceRecords,
  transcribeVoiceNote,
  transcriptView,
  type VoiceStorage,
} from '@/lib/chat/transcript-store';

function memoryStorage(initial: Record<string, string> = {}): VoiceStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe('voice store persistence', () => {
  it('reads records back synchronously from storage (first paint is final)', () => {
    const storage = memoryStorage({
      [VOICE_STORE_KEY]: JSON.stringify([['m1', { transcript: 'namaste', collapsed: true }]]),
    });
    const store = createVoiceStore(storage);
    expect(store.get('m1')).toEqual({ transcript: 'namaste', collapsed: true });
  });

  it('writes under one namespaced key', () => {
    const storage = memoryStorage();
    const store = createVoiceStore(storage);
    store.update('m1', { playedAt: 5 });
    expect([...storage.data.keys()]).toEqual([VOICE_STORE_KEY]);
    expect(createVoiceStore(storage).get('m1')).toEqual({ playedAt: 5 });
  });

  it('merges fields and clears a field set to undefined', () => {
    const store = createVoiceStore(memoryStorage());
    store.update('m1', { failedAt: 1, playedAt: 2 });
    store.update('m1', { transcript: 'hi', failedAt: undefined });
    expect(store.get('m1')).toEqual({ playedAt: 2, transcript: 'hi' });
  });

  it('caps the records and evicts the least recently touched', () => {
    const store = createVoiceStore(memoryStorage(), 3);
    store.update('a', { playedAt: 1 });
    store.update('b', { playedAt: 1 });
    store.update('c', { playedAt: 1 });
    store.update('a', { collapsed: true });
    store.update('d', { playedAt: 1 });
    expect(store.get('b')).toBeUndefined();
    expect(store.get('a')).toEqual({ playedAt: 1, collapsed: true });
    expect(store.get('c')).toBeDefined();
    expect(store.get('d')).toBeDefined();
  });

  it('degrades to memory when storage throws, never into the caller', () => {
    const broken: VoiceStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const store = createVoiceStore(broken);
    expect(() => store.update('m1', { transcript: 'kept' })).not.toThrow();
    expect(store.get('m1')).toEqual({ transcript: 'kept' });
  });

  it('keeps working in memory after a write fails', () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    const store = createVoiceStore(storage);
    store.update('m1', { playedAt: 1 });
    store.update('m2', { playedAt: 2 });
    expect(store.get('m2')).toEqual({ playedAt: 2 });
  });

  it('reads malformed storage as empty', () => {
    expect(parseVoiceRecords('{not json').size).toBe(0);
    expect(parseVoiceRecords('{"a":1}').size).toBe(0);
    expect(
      parseVoiceRecords(
        JSON.stringify([
          ['m1', { transcript: 3 }],
          ['m2', {}],
        ]),
      ),
    ).toEqual(new Map([['m2', {}]]));
  });

  it('notifies subscribers on every write and pending change', () => {
    const store = createVoiceStore(null);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.update('m1', { playedAt: 1 });
    store.setPending('m1', true);
    store.setPending('m1', true);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    store.setPending('m1', false);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('transcript view and the menu row', () => {
  it('maps a record to what the bubble renders', () => {
    expect(transcriptView(undefined, false)).toEqual({ kind: 'none' });
    expect(transcriptView(undefined, true)).toEqual({ kind: 'pending' });
    expect(transcriptView({ failedAt: 1 }, false)).toEqual({ kind: 'failed' });
    expect(transcriptView({ transcript: 'hi' }, false)).toEqual({
      kind: 'shown',
      text: 'hi',
      collapsed: false,
    });
    expect(transcriptView({ transcript: 'hi', collapsed: true }, false)).toMatchObject({
      collapsed: true,
    });
  });

  it('offers Transcribe with no transcript or after a failure, never while loading', () => {
    expect(canOfferTranscribe(undefined, false)).toBe(true);
    expect(canOfferTranscribe({ failedAt: 1 }, false)).toBe(true);
    expect(canOfferTranscribe({ playedAt: 1 }, false)).toBe(true);
    expect(canOfferTranscribe(undefined, true)).toBe(false);
    expect(canOfferTranscribe({ transcript: 'hi' }, false)).toBe(false);
  });
});

describe('transcribeVoiceNote', () => {
  const blob = new Blob(['x'], { type: 'audio/webm' });

  it('stores the transcript expanded and clears pending', async () => {
    const store = createVoiceStore(null);
    const transcribe = vi.fn(async () => ({ ok: true as const, transcript: ' नमस्ते, hello ' }));
    const done = transcribeVoiceNote({
      messageId: 'm1',
      fetchAudio: async () => blob,
      transcribe,
      store,
    });
    expect(store.isPending('m1')).toBe(true);
    await done;
    expect(store.isPending('m1')).toBe(false);
    expect(store.get('m1')).toEqual({ transcript: 'नमस्ते, hello', collapsed: false });
    expect(transcribe).toHaveBeenCalledWith(blob);
  });

  it('stores failed when the worker says no, the audio fetch throws, or the text is empty', async () => {
    const store = createVoiceStore(null);
    await transcribeVoiceNote({
      messageId: 'a',
      fetchAudio: async () => blob,
      transcribe: async () => ({ ok: false }),
      store,
      now: () => 7,
    });
    await transcribeVoiceNote({
      messageId: 'b',
      fetchAudio: async () => {
        throw new Error('aborted');
      },
      transcribe: async () => ({ ok: true, transcript: 'x' }),
      store,
      now: () => 8,
    });
    await transcribeVoiceNote({
      messageId: 'c',
      fetchAudio: async () => blob,
      transcribe: async () => ({ ok: true, transcript: '   ' }),
      store,
      now: () => 9,
    });
    expect(store.get('a')).toEqual({ failedAt: 7 });
    expect(store.get('b')).toEqual({ failedAt: 8 });
    expect(store.get('c')).toEqual({ failedAt: 9 });
    expect(transcriptView(store.get('a'), store.isPending('a'))).toEqual({ kind: 'failed' });
  });

  it('a retry after a failure replaces it with the transcript', async () => {
    const store = createVoiceStore(null);
    store.update('m1', { failedAt: 1, playedAt: 3 });
    await transcribeVoiceNote({
      messageId: 'm1',
      fetchAudio: async () => blob,
      transcribe: async () => ({ ok: true, transcript: 'ok' }),
      store,
    });
    expect(store.get('m1')).toEqual({ playedAt: 3, transcript: 'ok', collapsed: false });
  });

  it('ignores a second tap while one is in flight', async () => {
    const store = createVoiceStore(null);
    const transcribe = vi.fn(async () => ({ ok: true as const, transcript: 'once' }));
    const first = transcribeVoiceNote({
      messageId: 'm1',
      fetchAudio: async () => blob,
      transcribe,
      store,
    });
    await transcribeVoiceNote({ messageId: 'm1', fetchAudio: async () => blob, transcribe, store });
    await first;
    expect(transcribe).toHaveBeenCalledOnce();
  });
});

describe('clearVoiceTranscripts', () => {
  it('removes the stored key, the in-memory records and pending flags, and notifies', () => {
    const data = new Map<string, string>();
    const storage: VoiceStorage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => void data.set(key, value),
      removeItem: (key) => void data.delete(key),
    };
    const store = createVoiceStore(storage);
    store.update('m1', { transcript: 'hello' });
    store.setPending('m2', true);
    expect(data.has(VOICE_STORE_KEY)).toBe(true);
    const listener = vi.fn();
    store.subscribe(listener);
    clearVoiceTranscripts(store);
    expect(data.has(VOICE_STORE_KEY)).toBe(false);
    expect(store.get('m1')).toBeUndefined();
    expect(store.isPending('m2')).toBe(false);
    expect(listener).toHaveBeenCalled();
    // A fresh store over the same storage reads nothing back.
    expect(createVoiceStore(storage).get('m1')).toBeUndefined();
  });

  it('never throws on blocked storage', () => {
    const store = createVoiceStore({
      getItem: () => null,
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    store.update('m1', { transcript: 'x' });
    expect(() => clearVoiceTranscripts(store)).not.toThrow();
    expect(store.get('m1')).toBeUndefined();
  });
});
