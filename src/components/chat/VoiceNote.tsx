// The voice-note body that sits inside the normal message bubble shell (same
// radius, border and own/peer tint as a text bubble, owned by MessageBubble): a
// hidden <audio> element driven by a ref, a 44x44 round accent play/pause
// control, a 20-bar decorative waveform with an accent progress fill, and a
// 12px mono m:ss duration on the right, then the Whisper transcript beneath.
// The length shows before play from the stored durationMs (the recorder's
// value); a finite media duration (loadedmetadata or durationchange) refines
// it, and a non-finite one (MediaRecorder webm reports Infinity) never replaces
// it. One note plays at a time across the app. No recording, no presign logic
// (the url is handed in, null while the presign is still in flight).

import { useEffect, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { IconPause, IconPlay } from '@/components/ui/icons';

/** Fixed decorative bar heights (percent of the track) for the waveform. */
const WAVEFORM_BARS = [
  35, 60, 45, 80, 55, 70, 40, 90, 50, 65, 30, 75, 48, 85, 42, 68, 38, 72, 52, 58,
];

/** The label when no length is known yet. */
export const UNKNOWN_DURATION = '--:--';

/** Format a second count as m:ss ("0:18", "12:05"); negatives clamp to 0. */
export function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

function usable(seconds: number): boolean {
  return Number.isFinite(seconds) && seconds > 0;
}

/**
 * The note's length in seconds: a finite media duration when the element has
 * reported one, else the stored durationMs, else null (unknown).
 */
export function voiceTotalSeconds(
  storedMs: number | undefined,
  mediaSeconds: number,
): number | null {
  if (usable(mediaSeconds)) return mediaSeconds;
  if (storedMs !== undefined && usable(storedMs)) return storedMs / 1000;
  return null;
}

/** The label: elapsed time while playing or paused mid-way, else the length. */
export function voiceLabel(params: {
  storedMs: number | undefined;
  mediaSeconds: number;
  currentSeconds: number;
  playing: boolean;
}): string {
  if (params.playing || params.currentSeconds > 0) return formatDuration(params.currentSeconds);
  const total = voiceTotalSeconds(params.storedMs, params.mediaSeconds);
  return total === null ? UNKNOWN_DURATION : formatDuration(total);
}

/** Played share in percent, against the known length; 0 when unknown. */
export function voiceProgress(
  storedMs: number | undefined,
  mediaSeconds: number,
  currentSeconds: number,
): number {
  const total = voiceTotalSeconds(storedMs, mediaSeconds);
  if (total === null) return 0;
  return Math.min(100, Math.max(0, (currentSeconds / total) * 100));
}

/** The slice of HTMLAudioElement the note binds to; a fake satisfies it in tests. */
export interface VoiceAudio {
  duration: number;
  currentTime: number;
  pause: () => void;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

/**
 * Wire an audio element's events to the note's state. A duration event only
 * reports a usable (finite, positive) value, so Infinity or NaN never
 * overwrites what the note already shows. Returns the teardown.
 */
export function bindVoiceAudio(
  audio: VoiceAudio,
  on: {
    duration: (seconds: number) => void;
    time: (seconds: number) => void;
    playing: (playing: boolean) => void;
    ended: () => void;
  },
): () => void {
  const onDuration = (): void => {
    if (usable(audio.duration)) on.duration(audio.duration);
  };
  const onTime = (): void => on.time(audio.currentTime);
  const onPlay = (): void => {
    voicePlayback.claim(audio);
    on.playing(true);
  };
  const onPause = (): void => on.playing(false);
  const onEnded = (): void => {
    voicePlayback.release(audio);
    on.ended();
  };
  const events: Array<[string, () => void]> = [
    ['loadedmetadata', onDuration],
    ['durationchange', onDuration],
    ['timeupdate', onTime],
    ['play', onPlay],
    ['pause', onPause],
    ['ended', onEnded],
  ];
  for (const [type, fn] of events) audio.addEventListener(type, fn);
  return () => {
    for (const [type, fn] of events) audio.removeEventListener(type, fn);
  };
}

/** Anything that can be paused. */
interface Pausable {
  pause: () => void;
}

/** Tracks the one playing note; claiming a new one pauses the previous. */
export function createPlaybackRegistry(): {
  claim: (audio: Pausable) => void;
  release: (audio: Pausable) => void;
} {
  let active: Pausable | null = null;
  return {
    claim(audio) {
      if (active !== null && active !== audio) active.pause();
      active = audio;
    },
    release(audio) {
      if (active === audio) active = null;
    },
  };
}

/** The app-wide registry: one voice note plays at a time. */
export const voicePlayback = createPlaybackRegistry();

export function VoiceNote({
  url,
  name,
  transcript,
  durationMs,
  spacer,
}: {
  url: string | null;
  name: string;
  transcript: string | undefined;
  /** The stored length from the attachment meta; absent on older notes. */
  durationMs: number | undefined;
  /** The bubble's inline time spacer, placed at the end of the last line. */
  spacer?: ReactNode;
}): ReactElement {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [mediaSeconds, setMediaSeconds] = useState(Number.NaN);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null) return;
    const unbind = bindVoiceAudio(audio, {
      duration: setMediaSeconds,
      time: setCurrent,
      playing: setPlaying,
      ended: () => {
        setPlaying(false);
        setCurrent(0);
      },
    });
    return () => {
      unbind();
      audio.pause();
      voicePlayback.release(audio);
    };
  }, []);

  const toggle = (): void => {
    const audio = audioRef.current;
    if (audio === null) return;
    if (playing) {
      audio.pause();
      return;
    }
    voicePlayback.claim(audio);
    void audio.play().catch(() => setPlaying(false));
  };

  const disabled = url === null;
  const progress = voiceProgress(durationMs, mediaSeconds, current);
  const label = voiceLabel({
    storedMs: durationMs,
    mediaSeconds,
    currentSeconds: current,
    playing,
  });
  const hasTranscript = transcript !== undefined && transcript.trim() !== '';

  return (
    <div data-voice-note="" className="flex w-full flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <audio ref={audioRef} src={url ?? undefined} preload="metadata" className="hidden" />
        <button
          type="button"
          onClick={toggle}
          disabled={disabled}
          aria-label={playing ? 'Pause voice note' : 'Play voice note'}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:opacity-40"
        >
          {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
        </button>
        <div className="relative h-6 min-w-[120px] flex-1" aria-hidden="true">
          <div className="flex h-full w-full items-center gap-0.5">
            {WAVEFORM_BARS.map((height, index) => (
              <span
                key={index}
                className="flex-1 rounded-sm bg-fg-3/40"
                style={{ height: `${height}%` }}
              />
            ))}
          </div>
          {/* Played-so-far fill: a translucent accent overlay whose width tracks
              progress, so the bars beneath stay aligned. Width-only, no transition. */}
          <div
            className="absolute inset-y-0 left-0 rounded-sm bg-accent/30"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span
          data-voice-duration=""
          className="shrink-0 text-right font-mono text-[12px] tabular-nums text-fg-3"
          title={name}
        >
          {label}
        </span>
      </div>
      {hasTranscript ? (
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere] text-xs text-fg-2">
          {transcript}
          {spacer}
        </p>
      ) : spacer !== undefined ? (
        <p className="h-3 text-xs leading-3" aria-hidden="true">
          {spacer}
        </p>
      ) : null}
    </div>
  );
}
