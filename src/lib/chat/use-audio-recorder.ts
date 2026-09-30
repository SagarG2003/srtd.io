// Microphone capture for the chat composer. The recorder, stream, and chunk
// buffer live in refs (never re-render on each chunk); a useEffect cleanup
// guarantees the stream's tracks and the seconds interval are torn down on
// unmount, so no microphone light or timer is ever left running. The three
// helpers below are pure and form the unit-tested surface; the hook wires them
// to the MediaRecorder lifecycle.
//
// The waveform: while recording, an AudioContext + AnalyserNode on the same
// MediaStream samples the RMS level every PEAK_SAMPLE_MS; on stop the samples
// become 48 peaks (waveform-peaks.ts) sent with the note. The context is
// closed and its nodes disconnected on stop, cancel and unmount. Where the
// AudioContext is missing or throws (older iOS Safari included), the note
// records and sends exactly as before, with no peaks: peaks never block or
// delay a send.

import { useCallback, useEffect, useRef, useState } from 'react';
import { downsamplePeaks, PEAK_SAMPLE_MS } from '@/lib/chat/waveform-peaks';

/** Strip codecs/params off a MIME type: 'audio/webm;codecs=opus' -> 'audio/webm'. */
export function baseMime(mime: string): string {
  const head = mime.split(';')[0] ?? '';
  return head.trim().toLowerCase();
}

/**
 * The best container MediaRecorder supports here, '' when none is usable (or the
 * API is absent). Prefer webm, then mp4; passing '' lets the recorder pick its
 * own default.
 */
export function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const candidate of ['audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

/** Map a recording's MIME to a friendly file name; unknowns fall back to .webm. */
export function recordingFileName(mime: string): string {
  switch (baseMime(mime)) {
    case 'audio/webm':
      return 'voice-note.webm';
    case 'audio/mp4':
      return 'voice-note.m4a';
    case 'audio/mpeg':
      return 'voice-note.mp3';
    default:
      return 'voice-note.webm';
  }
}

/** The slice of AnalyserNode the capture reads. */
export interface AnalyserLike {
  fftSize: number;
  getFloatTimeDomainData?: (array: Float32Array) => void;
  getByteTimeDomainData?: (array: Uint8Array) => void;
  disconnect: () => void;
}

/** The slice of AudioContext the capture uses; a fake satisfies it in tests. */
export interface AudioContextLike {
  createMediaStreamSource: (stream: MediaStream) => {
    connect: (node: AnalyserLike) => unknown;
    disconnect: () => void;
  };
  createAnalyser: () => AnalyserLike;
  resume?: () => Promise<void>;
  close: () => Promise<void>;
}

/** The browser's AudioContext (webkit-prefixed on older Safari); null when absent or it throws. */
function browserAudioContext(): AudioContextLike | null {
  const scope = globalThis as unknown as {
    AudioContext?: new () => AudioContextLike;
    webkitAudioContext?: new () => AudioContextLike;
  };
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (Ctor === undefined) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

/** A running level capture: stop() tears it down and returns the peaks (undefined: none). */
export interface PeakCapture {
  stop: () => number[] | undefined;
  /** Tear down without a result (cancel, unmount). Idempotent. */
  dispose: () => void;
}

/** The RMS level of one time-domain frame; 0 for an empty one. Pure. */
export function rmsLevel(frame: ArrayLike<number>, offset = 0, scale = 1): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const value = ((frame[i] ?? 0) - offset) / scale;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / frame.length);
  return Number.isFinite(rms) ? rms : 0;
}

/**
 * Sample the stream's level every PEAK_SAMPLE_MS on its own AudioContext.
 * Null (record without peaks) when there is no AudioContext or wiring it up
 * throws; a sample that throws ends the capture with no peaks. Never throws.
 */
export function startPeakCapture(
  stream: MediaStream,
  deps: {
    createContext?: () => AudioContextLike | null;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  } = {},
): PeakCapture | null {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle: unknown): void => clearInterval(handle as number));
  let context: AudioContextLike | null = null;
  try {
    context = (deps.createContext ?? browserAudioContext)();
  } catch {
    context = null;
  }
  if (context === null) return null;
  const ctx = context;
  let source: ReturnType<AudioContextLike['createMediaStreamSource']> | null = null;
  let analyser: AnalyserLike | null = null;
  let timer: unknown = null;
  let closed = false;
  let broken = false;
  const samples: number[] = [];

  const dispose = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    try {
      source?.disconnect();
    } catch {
      // Already disconnected.
    }
    try {
      analyser?.disconnect();
    } catch {
      // Already disconnected.
    }
    try {
      void ctx.close().catch(() => {});
    } catch {
      // Already closed.
    }
  };

  try {
    source = ctx.createMediaStreamSource(stream);
    const node = ctx.createAnalyser();
    analyser = node;
    node.fftSize = 1024;
    source.connect(node);
    // iOS Safari may start the context suspended; a refusal only means silence.
    void ctx.resume?.().catch(() => {});
    const floats = new Float32Array(node.fftSize);
    const bytes = new Uint8Array(node.fftSize);
    timer = setTimer(() => {
      if (closed || broken) return;
      try {
        if (node.getFloatTimeDomainData !== undefined) {
          node.getFloatTimeDomainData(floats);
          samples.push(rmsLevel(floats));
        } else if (node.getByteTimeDomainData !== undefined) {
          node.getByteTimeDomainData(bytes);
          samples.push(rmsLevel(bytes, 128, 128));
        } else {
          broken = true;
        }
      } catch {
        broken = true;
      }
    }, PEAK_SAMPLE_MS);
  } catch {
    dispose();
    return null;
  }

  return {
    stop: () => {
      dispose();
      if (broken || samples.length === 0) return undefined;
      const peaks = downsamplePeaks(samples);
      // All silent (a context that never ran): no waveform rather than a flat one.
      return peaks.some((p) => p > 0) ? peaks : undefined;
    },
    dispose,
  };
}

/** A finished recording: its bytes and mime, plus the waveform when one was captured. */
export interface Recording {
  blob: Blob;
  mime: string;
  peaks?: number[];
}

/**
 * The recording a stop resolves to: null with no audio; otherwise the blob,
 * with peaks only when the capture produced them. Tears the capture down.
 * Never throws.
 */
export function finishRecording(
  chunks: readonly Blob[],
  mime: string,
  capture: PeakCapture | null,
): Recording | null {
  let peaks: number[] | undefined;
  try {
    peaks = capture?.stop();
  } catch {
    peaks = undefined;
  }
  if (chunks.length === 0) return null;
  return {
    blob: new Blob([...chunks], { type: mime }),
    mime,
    ...(peaks !== undefined ? { peaks } : {}),
  };
}

export interface AudioRecorder {
  recording: boolean;
  seconds: number;
  start: () => Promise<boolean>;
  stop: () => Promise<Recording | null>;
  cancel: () => void;
}

export function useAudioRecorder(): AudioRecorder {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const captureRef = useRef<PeakCapture | null>(null);

  const disposeCapture = useCallback((): void => {
    captureRef.current?.dispose();
    captureRef.current = null;
  }, []);

  const clearTimer = useCallback((): void => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const stopTracks = useCallback((): void => {
    if (streamRef.current !== null) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return false;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    const mimeType = pickRecorderMimeType();
    const recorder =
      mimeType !== '' ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recorder.addEventListener('dataavailable', (event: BlobEvent) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    });
    recorderRef.current = recorder;
    recorder.start();
    disposeCapture();
    captureRef.current = startPeakCapture(stream);
    setRecording(true);
    setSeconds(0);
    clearTimer();
    intervalRef.current = setInterval(() => setSeconds((value) => value + 1), 1000);
    return true;
  }, [clearTimer, disposeCapture]);

  const stop = useCallback((): Promise<Recording | null> => {
    const recorder = recorderRef.current;
    if (!recording || recorder === null) return Promise.resolve(null);
    return new Promise((resolve) => {
      recorder.addEventListener(
        'stop',
        () => {
          const mime = baseMime(recorder.mimeType) || 'audio/webm';
          const chunks = chunksRef.current;
          const capture = captureRef.current;
          captureRef.current = null;
          stopTracks();
          clearTimer();
          setRecording(false);
          recorderRef.current = null;
          resolve(finishRecording(chunks, mime, capture));
        },
        { once: true },
      );
      recorder.stop();
    });
  }, [recording, stopTracks, clearTimer]);

  const cancel = useCallback((): void => {
    if (!recording) return;
    const recorder = recorderRef.current;
    if (recorder !== null && recorder.state !== 'inactive') recorder.stop();
    chunksRef.current = [];
    recorderRef.current = null;
    disposeCapture();
    stopTracks();
    clearTimer();
    setRecording(false);
  }, [recording, stopTracks, clearTimer, disposeCapture]);

  useEffect(() => {
    return () => {
      disposeCapture();
      stopTracks();
      clearTimer();
    };
  }, [stopTracks, clearTimer, disposeCapture]);

  return { recording, seconds, start, stop, cancel };
}
