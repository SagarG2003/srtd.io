import { describe, expect, it } from 'vitest';
import {
  applyKeyboardViewport,
  initKeyboardViewport,
  KEYBOARD_MIN_PX,
  keyboardViewport,
} from '@/lib/keyboard-viewport';

/** A minimal <html> stand-in: dataset plus a style map (the test env is node). */
function fakeRoot(): HTMLElement & { vars: Map<string, string> } {
  const vars = new Map<string, string>();
  return {
    vars,
    dataset: {} as DOMStringMap,
    style: {
      setProperty: (k: string, v: string) => void vars.set(k, v),
      removeProperty: (k: string) => {
        vars.delete(k);
        return '';
      },
    },
  } as unknown as HTMLElement & { vars: Map<string, string> };
}

describe('keyboardViewport', () => {
  it('reads an iPhone keyboard (visible area well below the layout height) as open', () => {
    expect(keyboardViewport({ height: 412.4, offsetTop: 120.6 }, 844)).toEqual({
      open: true,
      height: 412,
      top: 121,
    });
  });

  it('treats a small shrink (toolbar, URL bar) as closed', () => {
    expect(keyboardViewport({ height: 844 - (KEYBOARD_MIN_PX - 1), offsetTop: 0 }, 844).open).toBe(
      false,
    );
    expect(keyboardViewport({ height: 844, offsetTop: 0 }, 844).open).toBe(false);
  });

  it('never reports a negative top (iOS rubber-band overscroll)', () => {
    expect(keyboardViewport({ height: 400, offsetTop: -12 }, 844).top).toBe(0);
  });
});

describe('applyKeyboardViewport', () => {
  it('sets data-keyboard and the size variables while open, and clears them on close', () => {
    const root = fakeRoot();
    applyKeyboardViewport(root, { open: true, height: 412, top: 121 });
    expect(root.dataset.keyboard).toBe('open');
    expect(root.vars.get('--keyboard-vvh')).toBe('412px');
    expect(root.vars.get('--keyboard-vv-top')).toBe('121px');

    applyKeyboardViewport(root, { open: false, height: 844, top: 0 });
    expect(root.dataset.keyboard).toBeUndefined();
    expect(root.vars.size).toBe(0);
  });
});

describe('initKeyboardViewport', () => {
  it('follows visualViewport resize and scroll, one write per frame', () => {
    const root = fakeRoot();
    const listeners = new Map<string, () => void>();
    const frames: (() => void)[] = [];
    const scrolled: ScrollIntoViewOptions[] = [];
    const active = { scrollIntoView: (o: ScrollIntoViewOptions) => void scrolled.push(o) };
    const vv = {
      height: 844,
      offsetTop: 0,
      addEventListener: (type: string, cb: () => void) => void listeners.set(type, cb),
    };
    initKeyboardViewport({
      innerHeight: 844,
      visualViewport: vv as never,
      requestAnimationFrame: (cb) => frames.push(cb),
      document: { documentElement: root, activeElement: active as unknown as Element },
    });
    expect(root.dataset.keyboard).toBeUndefined();
    expect(scrolled).toHaveLength(0);

    vv.height = 400;
    vv.offsetTop = 90;
    listeners.get('resize')?.();
    listeners.get('scroll')?.();
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    expect(root.dataset.keyboard).toBe('open');
    expect(root.vars.get('--keyboard-vv-top')).toBe('90px');
    // The focused field is brought into view once, on open only.
    expect(scrolled).toEqual([{ block: 'nearest' }]);
    vv.offsetTop = 40;
    listeners.get('scroll')?.();
    frames.shift()?.();
    expect(scrolled).toHaveLength(1);

    vv.height = 844;
    vv.offsetTop = 0;
    listeners.get('resize')?.();
    frames.shift()?.();
    expect(root.dataset.keyboard).toBeUndefined();
  });

  it('does nothing without visualViewport', () => {
    const root = fakeRoot();
    expect(() =>
      initKeyboardViewport({
        innerHeight: 844,
        visualViewport: null,
        requestAnimationFrame: () => 0,
        document: { documentElement: root, activeElement: null },
      }),
    ).not.toThrow();
    expect(root.dataset.keyboard).toBeUndefined();
  });
});
