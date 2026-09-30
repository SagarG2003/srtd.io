import { describe, expect, it, vi } from 'vitest';
import {
  PEAK_TIMEOUT_MS,
  peaksFromAudio,
  rmsWindow,
  voicePeaks,
  type DecodeContext,
  type DecodedAudio,
} from '@/lib/chat/voice-peaks';
import { PEAK_COUNT } from '@/lib/chat/waveform-peaks';

// T2: peaks come only from the finished blob, bounded, never block a send.

function audio(samples: Float32Array, sampleRate = 8_000): DecodedAudio {
  return { sampleRate, numberOfChannels: 1, getChannelData: () => samples };
}

/** A ramp: louder towards the end, so the peaks are not flat. */
function ramp(length: number): Float32Array {
  return Float32Array.from({ length }, (_, i) => (i % 2 === 0 ? 1 : -1) * (i / length));
}

const blob = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'audio/webm' });

describe('T2: voicePeaks from the finished recording', () => {
  it('a good decode gives 48 peaks (promise form)', async () => {
    const ctx: DecodeContext = { decodeAudioData: vi.fn(async () => audio(ramp(16_000))) };
    const peaks = await voicePeaks(blob, { createContext: () => ctx });
    expect(peaks).toHaveLength(PEAK_COUNT);
    expect(Math.max(...(peaks ?? []))).toBe(100);
  });

  it('a good decode gives 48 peaks (older callback form)', async () => {
    const ctx: DecodeContext = {
      decodeAudioData: (_data, success) => {
        success?.(audio(ramp(16_000)));
      },
    };
    expect(await voicePeaks(blob, { createContext: () => ctx })).toHaveLength(PEAK_COUNT);
  });

  it('a decode that throws or rejects gives none', async () => {
    const throws: DecodeContext = {
      decodeAudioData: () => {
        throw new Error('EncodingError');
      },
    };
    const rejects: DecodeContext = {
      decodeAudioData: () => Promise.reject(new Error('EncodingError')),
    };
    expect(await voicePeaks(blob, { createContext: () => throws })).toBeUndefined();
    expect(await voicePeaks(blob, { createContext: () => rejects })).toBeUndefined();
  });

  it('a decode past the 1000ms cap gives none, and resolves at the cap', async () => {
    vi.useFakeTimers();
    try {
      const ctx: DecodeContext = { decodeAudioData: () => new Promise<DecodedAudio>(() => {}) };
      const pending = voicePeaks(blob, { createContext: () => ctx });
      let done = false;
      void pending.then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(PEAK_TIMEOUT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      expect(await pending).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(PEAK_TIMEOUT_MS).toBe(1000);
  });

  it('no OfflineAudioContext gives none at once', async () => {
    expect(await voicePeaks(blob, { createContext: () => null })).toBeUndefined();
    const scope = globalThis as Record<string, unknown>;
    expect(scope.OfflineAudioContext).toBeUndefined();
    expect(await voicePeaks(blob)).toBeUndefined();
  });

  it('silence gives none rather than a flat wave', () => {
    expect(peaksFromAudio(audio(new Float32Array(8_000)))).toBeUndefined();
    expect(peaksFromAudio(audio(new Float32Array(0)))).toBeUndefined();
  });

  it('rmsWindow reads a slice and clamps to the buffer', () => {
    expect(rmsWindow([0.5, -0.5, 0, 0], 0, 2)).toBeCloseTo(0.5);
    expect(rmsWindow([1], 0, 10)).toBe(1);
    expect(rmsWindow([], 0, 4)).toBe(0);
  });
});
