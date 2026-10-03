import { describe, expect, it, vi } from 'vitest';
import {
  CHIME_GAP_MS,
  CHIME_REPEATS,
  createChime,
  type ChimeAudioContext,
  type GestureTarget,
} from '@/lib/chat/chime';

function fakeAudio() {
  const oscillators: { stopped: number; started: number }[] = [];
  let closed = false;
  const ctx: ChimeAudioContext = {
    currentTime: 0,
    state: 'running',
    destination: {},
    resume: () => Promise.resolve(),
    close: () => {
      closed = true;
      return Promise.resolve();
    },
    createOscillator() {
      const o = { stopped: 0, started: 0 };
      oscillators.push(o);
      return {
        type: 'sine',
        frequency: { setValueAtTime: () => undefined },
        connect: () => undefined,
        start: () => {
          o.started += 1;
        },
        stop: () => {
          o.stopped += 1;
        },
        disconnect: () => undefined,
      };
    },
    createGain() {
      return {
        gain: {
          setValueAtTime: () => undefined,
          linearRampToValueAtTime: () => undefined,
          exponentialRampToValueAtTime: () => undefined,
        },
        connect: () => undefined,
        disconnect: () => undefined,
      };
    },
  };
  return { ctx, oscillators, isClosed: () => closed };
}

function fakeTarget() {
  const listeners = new Map<string, Set<() => void>>();
  const target: GestureTarget = {
    addEventListener: (type, fn) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener: (type, fn) => {
      listeners.get(type)?.delete(fn);
    },
  };
  return {
    target,
    fire: (type: 'pointerdown' | 'keydown') => {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

function timers() {
  const queue: { fn: () => void; ms: number; id: number; live: boolean }[] = [];
  let seq = 0;
  return {
    setTimer: (fn: () => void, ms: number) => {
      seq += 1;
      queue.push({ fn, ms, id: seq, live: true });
      return seq;
    },
    clearTimer: (h: unknown) => {
      const t = queue.find((q) => q.id === h);
      if (t) t.live = false;
    },
    runUntil: (ms: number) => {
      for (const t of queue) {
        if (t.live && t.ms <= ms) {
          t.live = false;
          t.fn();
        }
      }
    },
    live: () => queue.filter((q) => q.live).length,
  };
}

describe('the reminder chime', () => {
  it('creates no AudioContext before a gesture', () => {
    const createContext = vi.fn(() => fakeAudio().ctx);
    const g = fakeTarget();
    const chime = createChime({ createContext, target: g.target });
    chime.play();
    expect(createContext).not.toHaveBeenCalled();
    expect(chime.active()).toBe(true);
    chime.dispose();
  });

  it('a chime asked before the gesture plays on the first tap', () => {
    const audio = fakeAudio();
    const g = fakeTarget();
    const t = timers();
    const chime = createChime({ createContext: () => audio.ctx, target: g.target, ...t });
    chime.play();
    g.fire('pointerdown');
    t.runUntil(0);
    expect(audio.oscillators.length).toBe(2);
    // The unlock listeners are gone after the first gesture.
    expect(g.count()).toBe(0);
    chime.dispose();
  });

  it('plays three tones over about 5 s', () => {
    const audio = fakeAudio();
    const g = fakeTarget();
    const t = timers();
    const chime = createChime({ createContext: () => audio.ctx, target: g.target, ...t });
    g.fire('keydown');
    chime.play();
    t.runUntil((CHIME_REPEATS - 1) * CHIME_GAP_MS);
    expect(audio.oscillators.length).toBe(CHIME_REPEATS * 2);
    expect((CHIME_REPEATS - 1) * CHIME_GAP_MS).toBeLessThanOrEqual(5_000);
    chime.dispose();
  });

  it('stops on dismiss: the current tone is cut and the repeats cancelled', () => {
    const audio = fakeAudio();
    const g = fakeTarget();
    const t = timers();
    const chime = createChime({ createContext: () => audio.ctx, target: g.target, ...t });
    g.fire('pointerdown');
    const stop = chime.play();
    t.runUntil(0);
    expect(audio.oscillators.length).toBe(2);
    stop();
    expect(audio.oscillators.every((o) => o.stopped >= 2)).toBe(true);
    expect(t.live()).toBe(0);
    expect(chime.active()).toBe(false);
    t.runUntil(10_000);
    expect(audio.oscillators.length).toBe(2);
    chime.dispose();
  });

  it('a stopped pending chime does not play on the later gesture', () => {
    const audio = fakeAudio();
    const g = fakeTarget();
    const t = timers();
    const chime = createChime({ createContext: () => audio.ctx, target: g.target, ...t });
    chime.play();
    chime.stop();
    g.fire('pointerdown');
    t.runUntil(10_000);
    expect(audio.oscillators.length).toBe(0);
    chime.dispose();
  });

  it('play(1) is a single tone (missed on open)', () => {
    const audio = fakeAudio();
    const g = fakeTarget();
    const t = timers();
    const chime = createChime({ createContext: () => audio.ctx, target: g.target, ...t });
    g.fire('pointerdown');
    chime.play(1);
    t.runUntil(10_000);
    expect(audio.oscillators.length).toBe(2);
    chime.dispose();
  });

  it('dispose closes the context and removes the listeners', () => {
    const audio = fakeAudio();
    const g = fakeTarget();
    const chime = createChime({ createContext: () => audio.ctx, target: g.target });
    expect(g.count()).toBe(2);
    g.fire('pointerdown');
    chime.dispose();
    expect(audio.isClosed()).toBe(true);
    const g2 = fakeTarget();
    createChime({ createContext: () => audio.ctx, target: g2.target }).dispose();
    expect(g2.count()).toBe(0);
  });
});
