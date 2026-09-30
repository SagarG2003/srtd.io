import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';

// jose's Node build resolves a remote JWKS via node:http, so we mock the
// remote-JWKS constructor to serve a local public key instead. ES256 signature
// verification itself stays real. Mirrors chat-token.test.ts.
const mockedJwks = vi.hoisted(() => ({ keys: [] as JWK[] }));
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    createRemoteJWKSet: () => actual.createLocalJWKSet(mockedJwks),
  };
});

import worker, {
  DAILY_CAP_BYTES,
  MAX_AUDIO_BYTES,
  usageKey,
  type ChatTranscribeEnv,
  type UsageKv,
} from './chat-transcribe';

const USER = '33333333-3333-7333-8333-333333333333';
const SUPABASE_URL = 'https://test.supabase.co';
const KID = 'test-es256-key';

/** A mock Workers AI binding whose run() returns the configured transcript. */
function aiReturning(text: unknown): ChatTranscribeEnv['AI'] {
  return { run: vi.fn(() => Promise.resolve({ text } as { text: string })) };
}

function makeEnv(ai: ChatTranscribeEnv['AI']): ChatTranscribeEnv {
  return { SUPABASE_URL, AI: ai };
}

let signingKey: KeyLike;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  signingKey = privateKey;
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), alg: 'ES256', use: 'sig', kid: KID };
  mockedJwks.keys = [publicJwk];
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function mintToken(sub: string, expSecondsFromNow = 3600): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setSubject(sub)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + expSecondsFromNow)
    .sign(signingKey);
}

/** An in-memory KV namespace for the daily byte counter. */
function memoryKv(initial: Record<string, string> = {}): UsageKv & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: vi.fn((key: string) => Promise.resolve(data.get(key) ?? null)),
    put: vi.fn((key: string, value: string) => {
      data.set(key, value);
      return Promise.resolve();
    }),
  };
}

function audioRequest(
  token: string | null,
  body: BodyInit | null,
  contentType = 'audio/webm',
  extraHeaders: Record<string, string> = {},
): Request {
  const headers = new Headers({ 'content-type': contentType, ...extraHeaders });
  if (token !== null) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return new Request('https://worker.test/', { method: 'POST', headers, body });
}

describe('chat-transcribe worker.fetch', () => {
  it('returns { ok: true, transcript } from the AI text for a valid request', async () => {
    const token = await mintToken(USER);
    const ai = aiReturning('namaste, this is the note');
    const res = await worker.fetch(audioRequest(token, new Uint8Array([1, 2, 3, 4])), makeEnv(ai));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; transcript: string };
    expect(body.ok).toBe(true);
    expect(body.transcript).toBe('namaste, this is the note');
    expect(ai.run).toHaveBeenCalledOnce();
  });

  it('returns 401 when the bearer token is absent', async () => {
    const ai = aiReturning('should not run');
    const res = await worker.fetch(audioRequest(null, new Uint8Array([1, 2, 3])), makeEnv(ai));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
    // An unauthenticated caller never reaches the AI binding.
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('returns 401 for an invalid token', async () => {
    const ai = aiReturning('should not run');
    const res = await worker.fetch(
      audioRequest('not-a-real-jwt', new Uint8Array([9])),
      makeEnv(ai),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty body', async () => {
    const token = await mintToken(USER);
    const ai = aiReturning('should not run');
    const res = await worker.fetch(audioRequest(token, null), makeEnv(ai));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('returns 500 when the AI binding throws', async () => {
    const token = await mintToken(USER);
    const ai: ChatTranscribeEnv['AI'] = {
      run: vi.fn(() => Promise.reject(new Error('inference unavailable'))),
    };
    const res = await worker.fetch(audioRequest(token, new Uint8Array([1, 2])), makeEnv(ai));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it('returns 405 for an unsupported verb', async () => {
    const ai = aiReturning('should not run');
    const res = await worker.fetch(
      new Request('https://worker.test/', { method: 'GET' }),
      makeEnv(ai),
    );
    expect(res.status).toBe(405);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('returns 415 for a non-audio content type, before reading or transcribing', async () => {
    const token = await mintToken(USER);
    const ai = aiReturning('should not run');
    const res = await worker.fetch(
      audioRequest(token, new Uint8Array([1, 2, 3]), 'application/octet-stream'),
      makeEnv(ai),
    );
    expect(res.status).toBe(415);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('accepts any audio/* type with parameters (audio/webm;codecs=opus)', async () => {
    const token = await mintToken(USER);
    const ai = aiReturning('ok');
    const res = await worker.fetch(
      audioRequest(token, new Uint8Array([1]), 'audio/webm;codecs=opus'),
      makeEnv(ai),
    );
    expect(res.status).toBe(200);
  });

  it('returns 413 from Content-Length alone when it declares more than 8 MB', async () => {
    const token = await mintToken(USER);
    const ai = aiReturning('should not run');
    const res = await worker.fetch(
      audioRequest(token, new Uint8Array([1, 2, 3]), 'audio/webm', {
        'content-length': String(MAX_AUDIO_BYTES + 1),
      }),
      makeEnv(ai),
    );
    expect(res.status).toBe(413);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('returns 413 when the body read runs past 8 MB', async () => {
    const token = await mintToken(USER);
    const ai = aiReturning('should not run');
    const res = await worker.fetch(
      audioRequest(token, new Uint8Array(MAX_AUDIO_BYTES + 1)),
      makeEnv(ai),
    );
    expect(res.status).toBe(413);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('accepts a body of exactly 8 MB', async () => {
    const token = await mintToken(USER);
    const ai = aiReturning('long note');
    const res = await worker.fetch(
      audioRequest(token, new Uint8Array(MAX_AUDIO_BYTES)),
      makeEnv(ai),
    );
    expect(res.status).toBe(200);
  });

  it('counts the bytes against the UTC day in KV on an ok transcription', async () => {
    const token = await mintToken(USER);
    const kv = memoryKv();
    const ai = aiReturning('counted');
    const res = await worker.fetch(audioRequest(token, new Uint8Array(1_000)), {
      ...makeEnv(ai),
      TRANSCRIBE_USAGE: kv,
    });
    expect(res.status).toBe(200);
    expect(kv.data.get(usageKey(new Date()))).toBe('1000');
  });

  it('returns 429 { ok: false, reason: daily_cap } once the day is over 240 MB', async () => {
    const token = await mintToken(USER);
    const kv = memoryKv({ [usageKey(new Date())]: String(DAILY_CAP_BYTES - 10) });
    const ai = aiReturning('should not run');
    const res = await worker.fetch(audioRequest(token, new Uint8Array(11)), {
      ...makeEnv(ai),
      TRANSCRIBE_USAGE: kv,
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, reason: 'daily_cap' });
    expect(ai.run).not.toHaveBeenCalled();
    expect(kv.data.get(usageKey(new Date()))).toBe(String(DAILY_CAP_BYTES - 10));
  });

  it('keys the counter by UTC day', () => {
    expect(usageKey(new Date('2026-09-30T23:59:59.000Z'))).toBe('usage:2026-09-30');
    expect(usageKey(new Date('2026-10-01T00:00:00.000Z'))).toBe('usage:2026-10-01');
  });
});
