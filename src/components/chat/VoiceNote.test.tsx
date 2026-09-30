import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AUTO_NEXT_DELAY_MS,
  bindVoiceAudio,
  nextSpeed,
  seekFraction,
  shouldAutoPlayNext,
  speedLabel,
  VoiceNote,
  VOICE_SPEEDS,
  createPlaybackRegistry,
  formatDuration,
  UNKNOWN_DURATION,
  voiceLabel,
  voiceProgress,
  voiceTotalSeconds,
  type VoiceAudio,
} from '@/components/chat/VoiceNote';
import { voiceStore } from '@/lib/chat/transcript-store';

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

describe('seek, speed and the auto-play chain', () => {
  it('maps a pointer X within the wave to 0..1, clamped; Y plays no part', () => {
    const rect = { left: 100, width: 200 };
    expect(seekFraction(100, rect)).toBe(0);
    expect(seekFraction(200, rect)).toBe(0.5);
    expect(seekFraction(300, rect)).toBe(1);
    expect(seekFraction(50, rect)).toBe(0);
    expect(seekFraction(900, rect)).toBe(1);
    expect(seekFraction(150, { left: 0, width: 0 })).toBe(0);
  });

  it('cycles 1x -> 1.5x -> 2x -> 1x', () => {
    expect(VOICE_SPEEDS).toEqual([1, 1.5, 2]);
    expect(nextSpeed(1)).toBe(1.5);
    expect(nextSpeed(1.5)).toBe(2);
    expect(nextSpeed(2)).toBe(1);
    expect(nextSpeed(3)).toBe(1);
    expect([1, 1.5, 2].map(speedLabel)).toEqual(['1×', '1.5×', '2×']);
  });

  it('hands on 350ms later only to an unplayed next note', () => {
    expect(AUTO_NEXT_DELAY_MS).toBe(350);
    expect(shouldAutoPlayNext('m2', undefined)).toBe(true);
    expect(shouldAutoPlayNext('m2', 123)).toBe(false);
    expect(shouldAutoPlayNext(null, undefined)).toBe(false);
    expect(shouldAutoPlayNext(undefined, undefined)).toBe(false);
  });
});

describe('first paint', () => {
  const base = {
    url: 'https://signed/a',
    name: 'n.webm',
    durationMs: 18_000,
    sender: { name: 'Asha Rao' },
    nextVoiceId: null,
  };
  const ids: string[] = [];
  const render = (id: string, mine = false): string => {
    ids.push(id);
    return renderToStaticMarkup(<VoiceNote {...base} messageId={id} mine={mine} />);
  };
  afterEach(() => {
    for (const id of ids.splice(0))
      voiceStore.update(id, {
        transcript: undefined,
        failedAt: undefined,
        collapsed: undefined,
        playedAt: undefined,
      });
  });

  it('renders the total length, the 44px wave with the drag guards, and the dot', () => {
    const html = render('fp-idle');
    expect(html).toContain('0:18');
    expect(html).toMatch(
      /data-voice-wave="[^"]*"[^>]*class="[^"]*h-11[^"]*touch-none[^"]*select-none/,
    );
    expect(html).toContain('[-webkit-touch-callout:none]');
    expect(html).toMatch(/data-voice-dot=""[^>]*class="[^"]*h-3 w-3[^"]*bg-accent\b/);
    expect(html).toContain('font-mono text-xs');
    expect(html).not.toContain('data-voice-transcript');
  });

  it('draws the dot white on an own bubble', () => {
    expect(render('fp-own', true)).toMatch(/data-voice-dot=""[^>]*class="[^"]*bg-accent-fg/);
  });

  it('shows the mic badge fg-3 until played, then accent', () => {
    expect(render('fp-unplayed')).toContain('text-fg-3');
    voiceStore.update('fp-played', { playedAt: 1 });
    const html = render('fp-played');
    expect(html).toContain('data-voice-played=""');
    expect(html).toMatch(/rounded-full bg-panel-2 text-accent/);
  });

  it('renders a stored transcript expanded, selectable, with a collapse chevron', () => {
    voiceStore.update('fp-shown', { transcript: 'नमस्ते, see you at 5' });
    const html = render('fp-shown');
    expect(html).toContain('data-voice-transcript="shown"');
    expect(html).toContain('नमस्ते, see you at 5');
    expect(html).toMatch(/select-text[^"]*text-\[15px\] leading-5 text-fg/);
    expect(html).toContain('aria-label="Collapse transcript"');
    expect(html).toContain('h-7 w-11');
  });

  it('renders a collapsed transcript as its 44px "Transcript" row on first paint', () => {
    voiceStore.update('fp-collapsed', { transcript: 'hidden text', collapsed: true });
    const html = render('fp-collapsed');
    expect(html).toContain('data-voice-transcript="collapsed"');
    expect(html).toMatch(/h-11 w-full/);
    expect(html).not.toContain('hidden text');
  });

  it('renders "Transcript not available" after a failure and "Transcribing…" while pending', () => {
    voiceStore.update('fp-failed', { failedAt: 1 });
    expect(render('fp-failed')).toMatch(/text-\[13px\] text-fg-3">Transcript not available/);
    voiceStore.setPending('fp-pending', true);
    const html = render('fp-pending');
    expect(html).toContain('Transcribing…');
    expect(html).toContain('text-[13px] text-fg-2');
    voiceStore.setPending('fp-pending', false);
  });
});
