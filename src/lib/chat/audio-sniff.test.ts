import { describe, expect, it } from 'vitest';
import {
  headerHex,
  readHeader,
  recorderMimeOf,
  rememberRecorderMime,
  sniffAudioMime,
  voiceFileType,
} from '@/lib/chat/audio-sniff';

// T3: the recording's type and name come from its bytes.

const WEBM = new Uint8Array([
  0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81,
]);
// ....ftypM4A
const MP4 = new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
const UNKNOWN = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0]);

describe('T3: audio-sniff', () => {
  it('an EBML header is audio/webm whatever the recorder says', () => {
    expect(sniffAudioMime(WEBM, 'audio/mp4')).toBe('audio/webm');
    expect(sniffAudioMime(WEBM, '')).toBe('audio/webm');
  });

  it("'ftyp' at offset 4 is audio/mp4 whatever the recorder says", () => {
    expect(sniffAudioMime(MP4, 'audio/webm;codecs=opus')).toBe('audio/mp4');
    expect(sniffAudioMime(MP4, '')).toBe('audio/mp4');
  });

  it("unknown bytes keep the recorder's type (base mime)", () => {
    expect(sniffAudioMime(UNKNOWN, 'audio/ogg;codecs=opus')).toBe('audio/ogg');
    expect(sniffAudioMime(new Uint8Array(0), 'audio/mp4')).toBe('audio/mp4');
    expect(sniffAudioMime(UNKNOWN, '')).toBe('');
  });

  it('the file name matches the sniffed type, never the webm fallback on its own', () => {
    // WebKit: recorder reports '' and the hook falls back to audio/webm; the bytes say mp4.
    expect(voiceFileType(MP4, '', 'audio/webm')).toEqual({
      type: 'audio/mp4',
      name: 'voice-note.m4a',
    });
    expect(voiceFileType(WEBM, 'audio/mp4', 'audio/mp4')).toEqual({
      type: 'audio/webm',
      name: 'voice-note.webm',
    });
    expect(voiceFileType(UNKNOWN, 'audio/mp4', 'audio/mp4')).toEqual({
      type: 'audio/mp4',
      name: 'voice-note.m4a',
    });
  });

  it('reads the first 12 bytes of a blob and prints them as hex', async () => {
    const header = await readHeader(new Blob([MP4, new Uint8Array(64)]));
    expect(header).toHaveLength(12);
    expect(headerHex(header)).toBe('0000001c667479704d344120');
    expect(await readHeader(new Blob([]))).toHaveLength(0);
  });

  it('remembers the recorder mime per file only', () => {
    const file = new Blob(['a']);
    expect(recorderMimeOf(file)).toBeUndefined();
    rememberRecorderMime(file, 'audio/mp4');
    expect(recorderMimeOf(file)).toBe('audio/mp4');
    expect(recorderMimeOf(new Blob(['a']))).toBeUndefined();
  });
});
