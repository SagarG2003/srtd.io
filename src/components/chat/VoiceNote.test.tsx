import { describe, expect, it, vi } from 'vitest';
import {
  bindVoiceAudio,
  createPlaybackRegistry,
  formatDuration,
  UNKNOWN_DURATION,
  voiceLabel,
  voiceProgress,
  voiceTotalSeconds,
  type VoiceAudio,
} from '@/components/chat/VoiceNote';

/** A fake audio element: set duration/currentTime, then fire an event. */
function fakeAudio(): VoiceAudio & { fire: (type: string) => void } {
  const listeners = new Map<string, Set<() => void>>();
  const audio = {
    duration: Number.NaN,
    currentTime: 0,
    pause: vi.fn(),
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
    fire: (type: string) => listeners.get(type)?.forEach((fn) => fn()),
  };
  return audio;
}

describe('voice note length', () => {
  it('shows "0:18" from durationMs before any media event', () => {
    expect(
      voiceLabel({ storedMs: 18_000, mediaSeconds: Number.NaN, currentSeconds: 0, playing: false }),
    ).toBe('0:18');
    expect(formatDuration(65)).toBe('1:05');
  });

  it('never renders 00:00 for a note with a stored duration', () => {
    for (const media of [Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      const label = voiceLabel({
        storedMs: 18_000,
        mediaSeconds: media,
        currentSeconds: 0,
        playing: false,
      });
      expect(label).toBe('0:18');
      expect(label).not.toBe('00:00');
    }
  });

  it('shows --:-- when neither a stored nor a finite media length is known', () => {
    expect(
      voiceLabel({
        storedMs: undefined,
        mediaSeconds: Number.POSITIVE_INFINITY,
        currentSeconds: 0,
        playing: false,
      }),
    ).toBe(UNKNOWN_DURATION);
  });

  it('Infinity from the element does not overwrite a finite stored value', () => {
    const audio = fakeAudio();
    let media = Number.NaN;
    const unbind = bindVoiceAudio(audio, {
      duration: (s) => (media = s),
      time: () => {},
      playing: () => {},
      ended: () => {},
    });
    audio.duration = Number.POSITIVE_INFINITY;
    audio.fire('loadedmetadata');
    audio.fire('durationchange');
    expect(Number.isNaN(media)).toBe(true);
    expect(voiceTotalSeconds(18_000, media)).toBe(18);
    // Progress measures against the stored length while the media says Infinity.
    expect(voiceProgress(18_000, media, 9)).toBe(50);
    unbind();
  });

  it('durationchange with a finite value updates the length when nothing is stored', () => {
    const audio = fakeAudio();
    let media = Number.NaN;
    const unbind = bindVoiceAudio(audio, {
      duration: (s) => (media = s),
      time: () => {},
      playing: () => {},
      ended: () => {},
    });
    audio.duration = Number.POSITIVE_INFINITY;
    audio.fire('loadedmetadata');
    expect(voiceTotalSeconds(undefined, media)).toBeNull();
    audio.duration = 7.4;
    audio.fire('durationchange');
    expect(voiceTotalSeconds(undefined, media)).toBe(7.4);
    expect(
      voiceLabel({ storedMs: undefined, mediaSeconds: media, currentSeconds: 0, playing: false }),
    ).toBe('0:07');
    unbind();
  });
});

describe('one voice note at a time', () => {
  it('starting a second note pauses the first', () => {
    const registry = createPlaybackRegistry();
    const first = { pause: vi.fn() };
    const second = { pause: vi.fn() };
    registry.claim(first);
    registry.claim(first);
    expect(first.pause).not.toHaveBeenCalled();
    registry.claim(second);
    expect(first.pause).toHaveBeenCalledOnce();
    expect(second.pause).not.toHaveBeenCalled();
    registry.release(second);
    registry.claim(first);
    expect(second.pause).not.toHaveBeenCalled();
  });

  it('a play event on one bound element pauses the other', () => {
    const a = fakeAudio();
    const b = fakeAudio();
    const on = { duration: () => {}, time: () => {}, playing: () => {}, ended: () => {} };
    const offA = bindVoiceAudio(a, on);
    const offB = bindVoiceAudio(b, on);
    a.fire('play');
    b.fire('play');
    expect(a.pause).toHaveBeenCalledOnce();
    expect(b.pause).not.toHaveBeenCalled();
    b.fire('ended');
    offA();
    offB();
  });
});
