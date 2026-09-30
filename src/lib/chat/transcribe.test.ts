import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRANSCRIBE_TIMEOUT_MS, transcribeAudio } from '@/lib/chat/transcribe';

// The fetcher is injected, so no network is touched: each test supplies a stub
// that records the request and returns a canned Response. The contract under
// test is that transcribeAudio never throws and returns a Result that is ok only
// for a 200 carrying { ok: true, transcript: string }.

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

const url = 'https://acct.r2.cloudflarestorage.com/assets-ws/voice.webm?X-Amz-Signature=sig';

describe('transcribeAudio', () => {
  it('returns the transcript and sends the Bearer token + { url } JSON on a 200', async () => {
    let seenInput = '';
    let seenInit: RequestInit | null = null;
    const result = await transcribeAudio({
      url,
      endpoint: 'https://transcribe.example.dev',
      token: 'tok-123',
      fetcher: async (input, init) => {
        seenInput = input;
        seenInit = init;
        return jsonResponse({ ok: true, transcript: 'hi' });
      },
    });
    expect(result).toEqual({ ok: true, transcript: 'hi' });
    expect(seenInput).toBe('https://transcribe.example.dev');
    const init = seenInit as unknown as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ url });
    expect(init.method).toBe('POST');
  });

  it('returns ok:false on a non-ok response', async () => {
    const result = await transcribeAudio({
      url,
      endpoint: 'https://transcribe.example.dev',
      token: 'tok',
      fetcher: async () => jsonResponse({ ok: true, transcript: 'x' }, false),
    });
    expect(result.ok).toBe(false);
  });

  it('returns ok:false (never throws) when the fetcher throws', async () => {
    const result = await transcribeAudio({
      url,
      endpoint: 'https://transcribe.example.dev',
      token: 'tok',
      fetcher: async () => {
        throw new Error('network down');
      },
    });
    expect(result.ok).toBe(false);
  });

  it('returns ok:false on malformed JSON / missing transcript', async () => {
    const missing = await transcribeAudio({
      url,
      endpoint: 'https://transcribe.example.dev',
      token: 'tok',
      fetcher: async () => jsonResponse({ ok: true }),
    });
    expect(missing.ok).toBe(false);

    const malformed = await transcribeAudio({
      url,
      endpoint: 'https://transcribe.example.dev',
      token: 'tok',
      fetcher: async () =>
        ({
          ok: true,
          json: async () => {
            throw new Error('not json');
          },
        }) as unknown as Response,
    });
    expect(malformed.ok).toBe(false);
  });
});

describe('tap-to-transcribe timeouts and audio fetch', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts the transcribe request after 20s and returns ok:false', async () => {
    vi.useFakeTimers();
    expect(TRANSCRIBE_TIMEOUT_MS).toBe(20_000);
    const pending = transcribeAudio({
      url,
      endpoint: 'https://transcribe.example.dev',
      token: 'tok',
      fetcher: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await vi.advanceTimersByTimeAsync(TRANSCRIBE_TIMEOUT_MS);
    expect((await pending).ok).toBe(false);
  });
});
