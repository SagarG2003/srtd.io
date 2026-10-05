import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadErrorMessage } from '@/lib/asset-upload';
import {
  classifyUploadFailure,
  uploadFailureCode,
  uploadRefusalContext,
} from '@/lib/chat/send-errors';
import { rememberRecorderMime } from '@/lib/chat/audio-sniff';
import { logUploadRefusal } from '@/lib/chat/send-flow';
import { logger } from '@/lib/logger';

// T4: a permanent upload refusal is logged once with why and what was sent,
// and nothing else.

const MP4 = new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
const AUDIO_TAIL = new Uint8Array(4_000).fill(0x5a);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('T4: upload refusal log', () => {
  it('maps the Worker refusal copy back to its code', () => {
    expect(uploadFailureCode(uploadErrorMessage('unsupported_mime'))).toBe('unsupported_mime');
    expect(uploadFailureCode(uploadErrorMessage('mime_mismatch'))).toBe('mime_mismatch');
    expect(uploadFailureCode('something else')).toBe('unknown');
  });

  it('names every file-safety refusal code instead of logging unknown', () => {
    for (const code of [
      'blocked_type',
      'encrypted_file',
      'embedded_content',
      'archive_limits',
      'external_content',
    ]) {
      expect(uploadFailureCode(uploadErrorMessage(code))).toBe(code);
    }
  });

  it('leaves the send classification unchanged for the new codes', () => {
    // Still permanent through the HTTP status, as before; nothing else moved.
    expect(classifyUploadFailure(uploadErrorMessage('blocked_type'), 415)).toBe('permanent');
    expect(classifyUploadFailure(uploadErrorMessage('external_content'), 422)).toBe('permanent');
    expect(classifyUploadFailure(uploadErrorMessage('encrypted_file'), null)).toBe('transient');
  });

  it('the context carries exactly the allowed keys', () => {
    const context = uploadRefusalContext({
      message: uploadErrorMessage('unsupported_mime'),
      status: 415,
      mime: 'audio/mp4',
      size: 12,
      recorderMime: undefined,
      headerHex: '00',
      userAgent: 'UA',
    });
    expect(Object.keys(context).sort()).toEqual(
      ['code', 'header_hex', 'mime', 'recorder_mime', 'size', 'status', 'user_agent'].sort(),
    );
    expect(context.recorder_mime).toBeNull();
  });

  it('logs status, code, mime, size, recorder mime, header hex and UA; no name, no audio', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const file = new File([MP4, AUDIO_TAIL], 'secret-name.m4a', { type: 'audio/mp4' });
    rememberRecorderMime(file, '');
    await logUploadRefusal(file, uploadErrorMessage('unsupported_mime'), 415);
    expect(warn).toHaveBeenCalledTimes(1);
    const [msg, context] = warn.mock.calls[0] ?? [];
    expect(msg).toBe('chat: upload refused');
    expect(context).toEqual({
      status: 415,
      code: 'unsupported_mime',
      mime: 'audio/mp4',
      size: 12 + AUDIO_TAIL.length,
      recorder_mime: '',
      header_hex: '0000001c667479704d344120',
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    });
    const text = JSON.stringify(context);
    expect(text).not.toContain('secret-name');
    expect(text).not.toContain('5a5a');
  });

  it('never throws, even when the logger does', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(logUploadRefusal(new Blob(['x']), 'x', 400)).resolves.toBeUndefined();
  });
});
