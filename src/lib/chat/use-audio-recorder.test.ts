import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  baseMime,
  finishRecording,
  pickRecorderMimeType,
  recordingFileName,
  rmsLevel,
  startPeakCapture,
  type AnalyserLike,
  type AudioContextLike,
} from '@/lib/chat/use-audio-recorder';
import { PEAK_COUNT } from '@/lib/chat/waveform-peaks';

// Only the exported pure helpers are exercised here: the repo's vitest runs in
// node with no MediaRecorder / getUserMedia, so the hook and any real recorder
// are out of scope. pickRecorderMimeType is tested by stubbing the global.

describe('baseMime', () => {
  it('strips codecs and params and lowercases', () => {
    expect(baseMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseMime('  AUDIO/MP4 ')).toBe('audio/mp4');
  });

  it('passes the empty string through', () => {
    expect(baseMime('')).toBe('');
  });
});

describe('recordingFileName', () => {
  it('maps each known audio mime to its file name', () => {
    expect(recordingFileName('audio/webm;codecs=opus')).toBe('voice-note.webm');
    expect(recordingFileName('audio/mp4')).toBe('voice-note.m4a');
    expect(recordingFileName('audio/mpeg')).toBe('voice-note.mp3');
  });

  it('falls back to .webm for anything else', () => {
    expect(recordingFileName('audio/ogg')).toBe('voice-note.webm');
    expect(recordingFileName('')).toBe('voice-note.webm');
  });
});

describe('pickRecorderMimeType', () => {
  const original = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    } else {
      (globalThis as { MediaRecorder?: unknown }).MediaRecorder = original;
    }
  });

  it("returns '' when MediaRecorder is undefined", () => {
    delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    expect(pickRecorderMimeType()).toBe('');
  });

  it('prefers a supported type', () => {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = {
      isTypeSupported: (t: string) => t === 'audio/webm',
    } as never;
    expect(pickRecorderMimeType()).toBe('audio/webm');
  });
});

describe('T2: waveform capture on the recording stream', () => {
  const stream = {} as MediaStream;

  /** A fake AudioContext whose analyser reports `level` as a constant signal. */
  function fakeContext(level: () => number) {
    const calls = { closed: 0, sourceOff: 0, analyserOff: 0 };
    const analyser: AnalyserLike = {
      fftSize: 0,
      getFloatTimeDomainData: (array: Float32Array) => array.fill(level()),
      disconnect: () => {
        calls.analyserOff += 1;
      },
    };
    const context: AudioContextLike = {
      createMediaStreamSource: () => ({
        connect: () => undefined,
        disconnect: () => {
          calls.sourceOff += 1;
        },
      }),
      createAnalyser: () => analyser,
      resume: async () => {},
      close: async () => {
        calls.closed += 1;
      },
    };
    return { context, calls };
  }

  /** Manual interval: tick() runs the sampler once. */
  function manualTimer() {
    let fn: (() => void) | null = null;
    return {
      setTimer: (f: () => void) => {
        fn = f;
        return 1;
      },
      clearTimer: vi.fn(() => {
        fn = null;
      }),
      tick: (times: number) => {
        for (let i = 0; i < times; i += 1) fn?.();
      },
    };
  }

  it('no AudioContext: no capture, no throw; the blob is still sent without peaks', () => {
    expect(startPeakCapture(stream, { createContext: () => null })).toBeNull();
    expect(
      startPeakCapture(stream, {
        createContext: () => {
          throw new Error('Safari says no');
        },
      }),
    ).toBeNull();
    const rec = finishRecording([new Blob(['abc'])], 'audio/mp4', null);
    expect(rec?.mime).toBe('audio/mp4');
    expect(rec?.blob.size).toBe(3);
    expect(rec).not.toHaveProperty('peaks');
  });

  it('wiring that throws (createMediaStreamSource) records without peaks and closes the context', () => {
    const { context, calls } = fakeContext(() => 0.5);
    context.createMediaStreamSource = () => {
      throw new Error('InvalidStateError');
    };
    expect(startPeakCapture(stream, { createContext: () => context })).toBeNull();
    expect(calls.closed).toBe(1);
  });

  it('stop returns 48 peaks from the sampled levels and closes the context', () => {
    let level = 0.1;
    const { context, calls } = fakeContext(() => level);
    const timer = manualTimer();
    const capture = startPeakCapture(stream, { createContext: () => context, ...timer });
    timer.tick(40);
    level = 0.4;
    timer.tick(40);
    const rec = finishRecording([new Blob(['abc'])], 'audio/webm', capture);
    expect(rec?.peaks).toHaveLength(PEAK_COUNT);
    expect(Math.max(...(rec?.peaks ?? []))).toBe(100);
    expect(rec?.peaks?.[0]).toBe(25);
    expect(calls).toEqual({ closed: 1, sourceOff: 1, analyserOff: 1 });
    expect(timer.clearTimer).toHaveBeenCalledTimes(1);
  });

  it('cancel and unmount (dispose) close the context and disconnect, once', () => {
    const { context, calls } = fakeContext(() => 0.2);
    const timer = manualTimer();
    const capture = startPeakCapture(stream, { createContext: () => context, ...timer });
    capture?.dispose();
    capture?.dispose();
    expect(calls).toEqual({ closed: 1, sourceOff: 1, analyserOff: 1 });
    expect(timer.clearTimer).toHaveBeenCalledTimes(1);
  });

  it('a silent (suspended) context gives no peaks rather than a flat wave', () => {
    const { context } = fakeContext(() => 0);
    const timer = manualTimer();
    const capture = startPeakCapture(stream, { createContext: () => context, ...timer });
    timer.tick(10);
    expect(capture?.stop()).toBeUndefined();
  });

  it('a sampler that throws never fails the recording', () => {
    const { context } = fakeContext(() => {
      throw new Error('boom');
    });
    const timer = manualTimer();
    const capture = startPeakCapture(stream, { createContext: () => context, ...timer });
    expect(() => timer.tick(3)).not.toThrow();
    const rec = finishRecording([new Blob(['a'])], 'audio/webm', capture);
    expect(rec?.blob.size).toBe(1);
    expect(rec).not.toHaveProperty('peaks');
  });

  it('no audio chunks still tears the capture down and resolves null', () => {
    const { context, calls } = fakeContext(() => 0.2);
    const capture = startPeakCapture(stream, { createContext: () => context, ...manualTimer() });
    expect(finishRecording([], 'audio/webm', capture)).toBeNull();
    expect(calls.closed).toBe(1);
  });

  it('rmsLevel reads float and byte frames', () => {
    expect(rmsLevel(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rmsLevel(new Uint8Array([128, 128]), 128, 128)).toBe(0);
    expect(rmsLevel([])).toBe(0);
  });
});
