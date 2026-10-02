import { describe, expect, it, vi } from 'vitest';
import {
  playNotifyTone,
  shouldPlayTone,
  tabTitle,
  TONE_THROTTLE_MS,
  type ToneContext,
  type ToneInput,
} from '@/lib/chat/notify-sound';

const NOW = 1_000_000;
const base: ToneInput = {
  own: false,
  channelId: 'other',
  messageAtMs: NOW - 500,
  readyAtMs: NOW - 60_000,
  activeChannelId: 'open',
  tabHidden: false,
  lastToneAtMs: null,
  nowMs: NOW,
};

describe('T6 tab title', () => {
  it('adds "(N) " and removes it at 0', () => {
    expect(tabTitle('Sorted', 3)).toBe('(3) Sorted');
    expect(tabTitle('(3) Sorted', 5)).toBe('(5) Sorted');
    expect(tabTitle('(5) Sorted', 0)).toBe('Sorted');
  });
});

describe('T6 sound', () => {
  it('plays for another chat, or for the open chat while the tab is hidden', () => {
    expect(shouldPlayTone(base)).toBe(true);
    expect(shouldPlayTone({ ...base, channelId: 'open', tabHidden: true })).toBe(true);
  });

  it('never for the open chat with the tab visible', () => {
    expect(shouldPlayTone({ ...base, channelId: 'open' })).toBe(false);
  });

  it('never for own messages', () => {
    expect(shouldPlayTone({ ...base, own: true })).toBe(false);
  });

  it('never during initial load or for a replayed message', () => {
    expect(shouldPlayTone({ ...base, readyAtMs: null })).toBe(false);
    expect(shouldPlayTone({ ...base, messageAtMs: base.readyAtMs! - 1 })).toBe(false);
    expect(shouldPlayTone({ ...base, messageAtMs: NOW - 30_000 })).toBe(false);
  });

  it('at most one tone per 2s', () => {
    expect(shouldPlayTone({ ...base, lastToneAtMs: NOW - TONE_THROTTLE_MS + 1 })).toBe(false);
    expect(shouldPlayTone({ ...base, lastToneAtMs: NOW - TONE_THROTTLE_MS })).toBe(true);
  });

  it('synthesises the tone with Web Audio and never throws', () => {
    const osc = () => ({
      type: '',
      frequency: { setValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    });
    const gain = () => ({
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    });
    const ctx: ToneContext = {
      currentTime: 0,
      destination: {},
      createOscillator: vi.fn(osc),
      createGain: vi.fn(gain),
    };
    expect(playNotifyTone(ctx)).toBe(true);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
    expect(playNotifyTone(null)).toBe(false);
    const broken = {
      ...ctx,
      createOscillator: () => {
        throw new Error('no audio');
      },
    };
    expect(playNotifyTone(broken)).toBe(false);
  });
});
