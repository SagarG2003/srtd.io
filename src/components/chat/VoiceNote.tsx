// The voice-note body that sits inside the normal message bubble shell (same
// radius, border and own/peer tint as a text bubble, owned by MessageBubble),
// WhatsApp style: a hidden <audio> element driven by a ref, a square accent
// play/pause control (44x44 hit area), a 20-bar decorative waveform the reader
// drags along X to seek (a 12px dot rides the progress edge), the mono m:ss
// time under it, and a 44px slot at the end: the sender photo with a mic badge
// (fg-3 until the note has played to the end once on this device, then
// accent), or while playing a speed pill cycling 1x / 1.5x / 2x (remembered for
// the session across notes). When a note ends and the message right below is
// an unplayed voice note from the same sender, that one starts 350ms later.
// The length shows before play from the stored durationMs (the recorder's
// value); a finite media duration (loadedmetadata or durationchange) refines
// it, and a non-finite one (MediaRecorder webm reports Infinity) never replaces
// it. One note plays at a time across the app. No recording, no presign logic
// (the url is handed in, null while the presign is still in flight).
//
// Under the wave row sits the tap-to-transcribe block, read synchronously from
// the per-device transcript store so first paint is final: "Transcribing..."
// while in flight, "Transcript not available" after a failure, else the text
// (selectable) with a collapse chevron, or the folded one-line "Transcript" row.

import { useEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
} from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { IconChevronDown, IconMic, IconPause, IconPlay } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { logger } from '@/lib/logger';
import {
  transcriptView,
  useVoiceRecord,
  voiceStore,
  type TranscriptView,
} from '@/lib/chat/transcript-store';

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

/** Whether a waveform bar sits inside the played-so-far share (progress 0-100). */
export function barPlayed(index: number, progress: number): boolean {
  return progress > 0 && ((index + 0.5) / WAVEFORM_BARS.length) * 100 <= progress;
}

/** Playback speeds the pill cycles through, in order. */
export const VOICE_SPEEDS = [1, 1.5, 2] as const;

/** The speed after `rate` in the cycle (an unknown rate restarts at 1x). */
export function nextSpeed(rate: number): number {
  const index = VOICE_SPEEDS.findIndex((speed) => speed === rate);
  return VOICE_SPEEDS[(index + 1) % VOICE_SPEEDS.length] ?? 1;
}

/** The pill label for a rate: "1×", "1.5×", "2×". */
export function speedLabel(rate: number): string {
  return `${rate}×`;
}

/** The chosen speed, shared by every note for the rest of the session. */
let sessionRate = 1;

/** Where along the wave (0..1) a pointer at clientX sits; X only, clamped. */
export function seekFraction(clientX: number, rect: { left: number; width: number }): number {
  if (!(rect.width > 0)) return 0;
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}

/** Gap between one note ending and the next one in the chain starting. */
export const AUTO_NEXT_DELAY_MS = 350;

/** Mounted notes by message id, so an ending note can start the next one. */
const voiceChain = new Map<string, () => void>();
/** The armed chain step; any user play or pause cancels it. */
let pendingNext: ReturnType<typeof setTimeout> | null = null;

function cancelPendingNext(): void {
  if (pendingNext !== null) clearTimeout(pendingNext);
  pendingNext = null;
}

/**
 * Whether an ended note hands on to `nextId`: there is one (the message right
 * below, a voice note from the same sender) and it has not played yet. Pure.
 */
export function shouldAutoPlayNext(
  nextId: string | null | undefined,
  nextPlayedAt: number | undefined,
): nextId is string {
  return typeof nextId === 'string' && nextId !== '' && nextPlayedAt === undefined;
}

/** A play() rejection worth reporting: an abort from a quick pause is not. */
function logPlayFailure(error: unknown): void {
  if (error instanceof DOMException && error.name === 'AbortError') return;
  logger.error('chat: voice note play failed', {
    name: error instanceof Error ? error.name : 'unknown',
  });
}

/** Chevron-up glyph, drawn like the icon set (24 box, stroke 1.7). */
function ChevronUpGlyph(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 15l6-6 6 6" />
    </svg>
  );
}

/** The transcript block under the wave row; nothing when there is no transcript state. */
function TranscriptBlock(props: {
  view: TranscriptView;
  onCollapse: (collapsed: boolean) => void;
}): ReactElement | null {
  const { view } = props;
  const rule = 'mt-1 border-t border-border';
  switch (view.kind) {
    case 'none':
      return null;
    case 'pending':
      return (
        <div
          data-voice-transcript="pending"
          role="status"
          className={cn(rule, 'flex h-11 items-center gap-2 text-[13px] text-fg-2')}
        >
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          Transcribing…
        </div>
      );
    case 'failed':
      return (
        <p
          data-voice-transcript="failed"
          className={cn(rule, 'flex h-11 items-center text-[13px] text-fg-3')}
        >
          Transcript not available
        </p>
      );
    case 'shown':
      return view.collapsed ? (
        <button
          type="button"
          data-voice-transcript="collapsed"
          aria-expanded={false}
          onClick={() => props.onCollapse(false)}
          className={cn(
            rule,
            'flex h-11 w-full items-center justify-between text-[15px] leading-5 text-fg-2',
          )}
        >
          Transcript
          <IconChevronDown size={18} />
        </button>
      ) : (
        <div data-voice-transcript="shown" className={cn(rule, 'flex flex-col pt-2')}>
          <p
            dir="auto"
            className="select-text whitespace-pre-wrap [overflow-wrap:anywhere] text-[15px] leading-5 text-fg"
          >
            {view.text}
          </p>
          <button
            type="button"
            aria-label="Collapse transcript"
            aria-expanded
            onClick={() => props.onCollapse(true)}
            className="mx-auto flex h-7 w-11 items-center justify-center text-fg-2"
          >
            <ChevronUpGlyph />
          </button>
        </div>
      );
  }
}

export function VoiceNote({
  url,
  name,
  durationMs,
  spacer,
  messageId,
  mine = false,
  sender,
  nextVoiceId,
}: {
  url: string | null;
  name: string;
  /** The stored length from the attachment meta; absent on older notes. */
  durationMs: number | undefined;
  /** The bubble's inline time spacer, placed at the end of the last line. */
  spacer?: ReactNode;
  /** The recorded message's id: keys the played state and the transcript. */
  messageId?: string | undefined;
  /** Own bubble: the dot and badge draw on the bubble-own fill. */
  mine?: boolean | undefined;
  /** Whose photo fills the end slot while the note is not playing. */
  sender?: { name: string; src?: string | undefined } | undefined;
  /** The message right below, when it is a voice note from the same sender. */
  nextVoiceId?: string | null | undefined;
}): ReactElement {
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [mediaSeconds, setMediaSeconds] = useState(Number.NaN);
  const [rate, setRate] = useState(sessionRate);
  // The drag position (0..1) while the wave is held; null when not dragging.
  const [drag, setDrag] = useState<number | null>(null);
  const touchPointer = useRef(false);
  const { record, pending } = useVoiceRecord(messageId);
  const played = record?.playedAt !== undefined;
  const latest = useRef({ messageId, nextVoiceId });
  latest.current = { messageId, nextVoiceId };

  const start = (audio: HTMLAudioElement): void => {
    voicePlayback.claim(audio);
    audio.defaultPlaybackRate = sessionRate;
    audio.playbackRate = sessionRate;
    setRate(sessionRate);
    void audio.play().catch((error: unknown) => {
      setPlaying(false);
      logPlayFailure(error);
    });
  };

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
        const { messageId: id, nextVoiceId: nextId } = latest.current;
        if (id === undefined) return;
        if (voiceStore.get(id)?.playedAt === undefined) {
          voiceStore.update(id, { playedAt: Date.now() });
        }
        cancelPendingNext();
        if (!shouldAutoPlayNext(nextId, voiceStore.get(nextId ?? '')?.playedAt)) return;
        pendingNext = setTimeout(() => {
          pendingNext = null;
          if (voiceStore.get(nextId)?.playedAt === undefined) voiceChain.get(nextId)?.();
        }, AUTO_NEXT_DELAY_MS);
      },
    });
    return () => {
      unbind();
      audio.pause();
      voicePlayback.release(audio);
    };
  }, []);

  // Register this note so the one above it can hand on to it.
  useEffect(() => {
    if (messageId === undefined) return;
    const play = (): void => {
      const audio = audioRef.current;
      if (audio !== null && audio.src !== '') start(audio);
    };
    voiceChain.set(messageId, play);
    return () => {
      if (voiceChain.get(messageId) === play) voiceChain.delete(messageId);
    };
  }, [messageId]);

  const toggle = (): void => {
    const audio = audioRef.current;
    if (audio === null) return;
    cancelPendingNext();
    if (playing) {
      audio.pause();
      return;
    }
    start(audio);
  };

  const cycleSpeed = (): void => {
    const next = nextSpeed(rate);
    sessionRate = next;
    setRate(next);
    const audio = audioRef.current;
    if (audio !== null) {
      audio.defaultPlaybackRate = next;
      audio.playbackRate = next;
    }
  };

  const disabled = url === null;
  const total = voiceTotalSeconds(durationMs, mediaSeconds);
  const shownSeconds = drag !== null && total !== null ? drag * total : current;
  const progress = voiceProgress(durationMs, mediaSeconds, shownSeconds);
  const label = voiceLabel({
    storedMs: durationMs,
    mediaSeconds,
    currentSeconds: shownSeconds,
    playing: playing || drag !== null,
  });

  const fractionAt = (clientX: number): number =>
    seekFraction(clientX, waveRef.current?.getBoundingClientRect() ?? { left: 0, width: 0 });
  const seekTo = (fraction: number): void => {
    const audio = audioRef.current;
    if (audio === null || total === null) return;
    const seconds = fraction * total;
    audio.currentTime = seconds;
    setCurrent(seconds);
  };
  // The wave owns its pointer: a drag never reaches the bubble's swipe-to-reply
  // or long-press, and never starts a native selection or callout.
  const wave = {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      touchPointer.current = e.pointerType !== 'mouse';
      if (disabled || total === null || e.button !== 0) return;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // The pointer is already gone; the drag ends on its own.
      }
      setDrag(fractionAt(e.clientX));
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (drag !== null) setDrag(fractionAt(e.clientX));
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (drag === null) return;
      seekTo(fractionAt(e.clientX));
      setDrag(null);
    },
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      setDrag(null);
    },
    onContextMenu: (e: ReactMouseEvent<HTMLDivElement>) => {
      // A touch hold on the wave is a drag, never the menu or a callout.
      if (touchPointer.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (total === null || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      e.stopPropagation();
      const step = e.key === 'ArrowRight' ? 5 : -5;
      seekTo(Math.min(1, Math.max(0, (current + step) / total)));
    },
  };

  const view = transcriptView(record, pending);

  return (
    <div data-voice-note="" className="flex w-full flex-col">
      <audio ref={audioRef} src={url ?? undefined} preload="metadata" className="hidden" />
      <div className="flex items-center gap-2">
        {/* 44x44 hit area around the 36px square play control (primary button look). */}
        <button
          type="button"
          onClick={toggle}
          disabled={disabled}
          aria-label={playing ? 'Pause voice note' : 'Play voice note'}
          className="group/play -ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-accent text-accent-fg group-hover/play:bg-accent-hover">
            {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
          </span>
        </button>
        <div className="flex min-w-[120px] flex-1 flex-col">
          <div
            ref={waveRef}
            data-voice-wave=""
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label="Seek voice note"
            aria-valuemin={0}
            aria-valuemax={Math.round(total ?? 0)}
            aria-valuenow={Math.round(shownSeconds)}
            aria-valuetext={label}
            {...wave}
            className="relative flex h-11 cursor-pointer touch-none select-none items-center [-webkit-touch-callout:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <div className="flex h-6 w-full items-center gap-0.5" aria-hidden="true">
              {WAVEFORM_BARS.map((height, index) => (
                <span
                  key={index}
                  data-played={barPlayed(index, progress) ? '' : undefined}
                  className={cn(
                    'flex-1 rounded-sm',
                    barPlayed(index, progress) ? 'bg-accent' : 'bg-fg-3',
                  )}
                  style={{ height: `${height}%` }}
                />
              ))}
            </div>
            <span
              aria-hidden="true"
              data-voice-dot=""
              className={cn(
                'pointer-events-none absolute top-1/2 -ml-1.5 -mt-1.5 h-3 w-3 rounded-full',
                mine ? 'bg-accent-fg' : 'bg-accent',
              )}
              style={{ left: `${progress}%` }}
            />
          </div>
          <span
            data-voice-duration=""
            className="-mt-1 font-mono text-xs leading-4 tabular-nums text-fg-2"
            title={name}
          >
            {label}
          </span>
        </div>
        <div className="flex h-11 w-11 shrink-0 items-center justify-center">
          {playing ? (
            <button
              type="button"
              data-voice-speed=""
              onClick={cycleSpeed}
              aria-label={`Playback speed ${speedLabel(rate)}`}
              className="flex h-11 w-11 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="rounded-full bg-accent px-2 py-0.5 font-mono text-xs text-accent-fg">
                {speedLabel(rate)}
              </span>
            </button>
          ) : sender !== undefined ? (
            <span className="relative flex" data-voice-played={played ? '' : undefined}>
              <Avatar
                name={sender.name}
                {...(sender.src !== undefined ? { src: sender.src } : {})}
                size="header"
              />
              <span
                aria-hidden="true"
                className={cn(
                  'absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full',
                  mine ? 'bg-bubble-own' : 'bg-panel-2',
                  mine
                    ? played
                      ? 'text-accent-fg'
                      : 'text-accent-fg opacity-60'
                    : played
                      ? 'text-accent'
                      : 'text-fg-3',
                )}
              >
                <IconMic size={12} />
              </span>
            </span>
          ) : null}
        </div>
      </div>
      {messageId !== undefined ? (
        <TranscriptBlock
          view={view}
          onCollapse={(collapsed) => voiceStore.update(messageId, { collapsed })}
        />
      ) : null}
      {spacer !== undefined ? (
        <p className="h-3 text-xs leading-3" aria-hidden="true">
          {spacer}
        </p>
      ) : null}
    </div>
  );
}
