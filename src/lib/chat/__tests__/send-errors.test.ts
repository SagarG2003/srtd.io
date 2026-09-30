// The send failure classifier: only a server refusal is permanent ("Not
// sent" + Retry); network trouble of every kind, and anything unknown, keeps
// the message pending. Also: the record write carries the error code and HTTP
// status the classifier reads.

import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/rpc';
import { classifyRecordFailure, classifyUploadFailure } from '@/lib/chat/send-errors';
import { sendMessageRecord } from '@/lib/chat/record';
import { uploadErrorMessage } from '@/lib/asset-upload';

describe('classifyRecordFailure', () => {
  it('network errors, aborts and our own timeout are transient', () => {
    expect(
      classifyRecordFailure({ status: 0, code: '', message: 'TypeError: Failed to fetch' }),
    ).toBe('transient');
    expect(
      classifyRecordFailure({ status: 0, code: '', message: 'AbortError: signal is aborted' }),
    ).toBe('transient');
    expect(classifyRecordFailure({ reason: 'timeout', message: 'AbortError' })).toBe('transient');
    expect(classifyRecordFailure({ message: 'TypeError: Load failed' })).toBe('transient');
  });

  it.each([408, 429, 500, 502, 503, 504])('HTTP %i is transient', (status) => {
    expect(classifyRecordFailure({ status, message: 'x' })).toBe('transient');
    // Even with a code on it: the server was not answering about this message.
    expect(classifyRecordFailure({ status, code: 'P0001', message: 'x' })).toBe('transient');
  });

  it('proc RAISE, permission, check violation and validation are permanent', () => {
    expect(classifyRecordFailure({ status: 400, code: 'P0001', message: 'not a member' })).toBe(
      'permanent',
    );
    expect(
      classifyRecordFailure({ status: 403, code: '42501', message: 'permission denied' }),
    ).toBe('permanent');
    expect(
      classifyRecordFailure({ status: 400, code: '23514', message: 'violates check constraint' }),
    ).toBe('permanent');
    expect(classifyRecordFailure({ status: 400, code: '22P02', message: 'invalid uuid' })).toBe(
      'permanent',
    );
    expect(classifyRecordFailure({ status: 404, code: 'PGRST202', message: 'no function' })).toBe(
      'permanent',
    );
  });

  it('"forward source not accessible" is permanent, with or without a code', () => {
    expect(
      classifyRecordFailure({
        status: 400,
        code: 'P0001',
        message: 'forward source not accessible',
      }),
    ).toBe('permanent');
    expect(classifyRecordFailure({ message: 'Forward source not accessible' })).toBe('permanent');
  });

  it('server-condition SQLSTATE classes and an expired JWT are transient', () => {
    expect(classifyRecordFailure({ status: 400, code: '40001', message: 'serialization' })).toBe(
      'transient',
    );
    expect(
      classifyRecordFailure({ status: 400, code: '57014', message: 'statement timeout' }),
    ).toBe('transient');
    expect(classifyRecordFailure({ status: 400, code: '08006', message: 'connection' })).toBe(
      'transient',
    );
    expect(classifyRecordFailure({ status: 401, code: 'PGRST303', message: 'JWT expired' })).toBe(
      'transient',
    );
  });

  it('unknown is transient', () => {
    expect(classifyRecordFailure({ message: 'something odd' })).toBe('transient');
    expect(classifyRecordFailure({ status: 400, message: '<html>bad gateway</html>' })).toBe(
      'transient',
    );
    expect(classifyRecordFailure({ status: 418, code: 'weird', message: '' })).toBe('transient');
  });
});

describe('classifyUploadFailure', () => {
  it('an XHR error, abort, stall or 5xx (the network copy) is transient', () => {
    expect(classifyUploadFailure(uploadErrorMessage('network'))).toBe('transient');
    expect(classifyUploadFailure(uploadErrorMessage('internal'))).toBe('transient');
    expect(classifyUploadFailure('Your session expired. Sign in again.')).toBe('transient');
    expect(classifyUploadFailure('Error: boom')).toBe('transient');
  });

  it("the Worker's refusals of the file itself are permanent", () => {
    for (const code of ['file_too_large', 'unsupported_mime', 'mime_mismatch', 'virus_detected']) {
      expect(classifyUploadFailure(uploadErrorMessage(code))).toBe('permanent');
    }
  });
});

describe('sendMessageRecord failure detail', () => {
  function client(result: { error: unknown; status: number } | 'throw'): Client {
    const builder = {
      abortSignal: () => builder,
      then: (resolve: (value: unknown) => void, reject: (error: unknown) => void) =>
        result === 'throw'
          ? reject(new Error('Failed to fetch'))
          : resolve({ data: null, error: result.error, status: result.status }),
    };
    return { rpc: () => builder } as unknown as Client;
  }
  const base = {
    id: 'm1',
    channelId: 'c1',
    traceId: 't1',
    body: 'hi',
    attachmentAssetIds: [],
  };

  it('carries the PostgREST code and HTTP status of a refusal', async () => {
    const result = await sendMessageRecord({
      ...base,
      client: client({ error: { message: 'not a member', code: 'P0001' }, status: 400 }),
    });
    expect(result).toEqual({
      ok: false,
      reason: 'error',
      message: 'not a member',
      code: 'P0001',
      status: 400,
    });
    if (!result.ok) expect(classifyRecordFailure(result)).toBe('permanent');
  });

  it('a network failure has status 0 and no code, and classifies transient', async () => {
    const result = await sendMessageRecord({
      ...base,
      client: client({ error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 }),
    });
    expect(result).toEqual({
      ok: false,
      reason: 'error',
      message: 'TypeError: Failed to fetch',
      status: 0,
    });
    if (!result.ok) expect(classifyRecordFailure(result)).toBe('transient');
  });

  it('a thrown transport error classifies transient', async () => {
    const result = await sendMessageRecord({ ...base, client: client('throw') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(classifyRecordFailure(result)).toBe('transient');
  });
});
