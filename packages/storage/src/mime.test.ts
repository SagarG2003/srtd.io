import { describe, expect, it } from 'vitest';
import {
  ALLOWED_MIME_TYPES,
  EXTENSIONS_BY_MIME,
  isAllowedMime,
  isBlockedMime,
  normalizeMime,
} from './mime';

describe('ALLOWED_MIME_TYPES', () => {
  it('accepts recorded voice-note audio types', () => {
    expect(isAllowedMime('audio/mp4')).toBe(true);
    expect(isAllowedMime('audio/webm')).toBe(true);
    expect(isAllowedMime('audio/mpeg')).toBe(true);
  });

  it('accepts audio types with parameters via normalization', () => {
    expect(isAllowedMime('audio/webm; codecs=opus')).toBe(true);
    expect(normalizeMime('audio/mpeg; charset=binary')).toBe('audio/mpeg');
  });

  it('still rejects unrelated audio types', () => {
    expect(isAllowedMime('audio/ogg')).toBe(false);
    expect(isAllowedMime('audio/wav')).toBe(false);
  });

  it('keeps the existing entries and contains no duplicates', () => {
    expect(ALLOWED_MIME_TYPES).toContain('image/jpeg');
    expect(ALLOWED_MIME_TYPES).toContain('video/mp4');
    expect(ALLOWED_MIME_TYPES).toContain('application/pdf');
    expect(new Set(ALLOWED_MIME_TYPES).size).toBe(ALLOWED_MIME_TYPES.length);
  });
});

describe('blocked and Office types', () => {
  it('no longer allows SVG or legacy OLE Office, and marks them blocked', () => {
    for (const mime of [
      'image/svg+xml',
      'application/msword',
      'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
    ]) {
      expect(isAllowedMime(mime)).toBe(false);
      expect(isBlockedMime(mime)).toBe(true);
    }
  });

  it('keeps docx, xlsx and pptx allowed with their extensions', () => {
    for (const [mime, ext] of [
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
      ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
    ] as const) {
      expect(isAllowedMime(mime)).toBe(true);
      expect(EXTENSIONS_BY_MIME[mime]).toContain(ext);
    }
  });

  it('maps an extension list for every allowed type', () => {
    for (const mime of ALLOWED_MIME_TYPES) {
      expect(EXTENSIONS_BY_MIME[mime].length).toBeGreaterThan(0);
    }
  });
});
