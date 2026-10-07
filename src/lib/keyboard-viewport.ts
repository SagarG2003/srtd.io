// Keeps the app inside the part of the screen the on-screen keyboard leaves
// visible, so the chat composer sits directly on the browser's bar above the
// keyboard with no gap.
//
// iOS Safari, Chrome and Firefox (all WebKit) never shrink the layout viewport
// when the keyboard opens: the page stays full height under the keyboard and
// the browser pans to reveal the focused field, which leaves a band between
// the composer and the keyboard. `interactive-widget=resizes-content` would
// fix this on Android Chrome only; iOS ignores it. The visual viewport is the
// one signal every engine reports, so while the keyboard is open the root is
// pinned to it (index.css: :root[data-keyboard='open']).
//
// The bar above the keyboard itself (Safari's arrows and Done, Chrome's
// key / card / pin buttons) is browser chrome a page cannot remove; it sits
// outside the visual viewport, so pinning to it lands the composer on top.

/** Below this, the visual viewport shrank for a toolbar, not a keyboard. */
export const KEYBOARD_MIN_PX = 150;

export interface ViewportBox {
  height: number;
  offsetTop: number;
}

export interface KeyboardViewport {
  open: boolean;
  /** Visible height in CSS px (rounded). */
  height: number;
  /** Visible top in layout px (the browser's pan), rounded. */
  top: number;
}

/** The keyboard state for one visual-viewport reading against the layout viewport. */
export function keyboardViewport(vv: ViewportBox, layoutHeight: number): KeyboardViewport {
  const height = Math.round(vv.height);
  return {
    open: layoutHeight - height >= KEYBOARD_MIN_PX,
    height,
    top: Math.max(0, Math.round(vv.offsetTop)),
  };
}

interface KeyboardWindow {
  innerHeight: number;
  visualViewport?: (ViewportBox & Pick<EventTarget, 'addEventListener'>) | null;
  requestAnimationFrame: (cb: () => void) => number;
  document: { documentElement: HTMLElement; activeElement: Element | null };
}

/** Write one reading onto <html>: data-keyboard plus the two size variables. */
export function applyKeyboardViewport(root: HTMLElement, state: KeyboardViewport): void {
  if (state.open) {
    root.style.setProperty('--keyboard-vvh', `${state.height}px`);
    root.style.setProperty('--keyboard-vv-top', `${state.top}px`);
    root.dataset.keyboard = 'open';
  } else if (root.dataset.keyboard !== undefined) {
    delete root.dataset.keyboard;
    root.style.removeProperty('--keyboard-vvh');
    root.style.removeProperty('--keyboard-vv-top');
  }
}

// App-lifetime listeners set once (mirroring initViewportLock), so there is no
// teardown. One write per frame: iOS fires scroll and resize in bursts while
// the keyboard animates.
export function initKeyboardViewport(win: KeyboardWindow = window): void {
  const vv = win.visualViewport;
  if (vv == null) return;
  const root = win.document.documentElement;
  let queued = false;
  const update = (): void => {
    queued = false;
    const wasOpen = root.dataset.keyboard === 'open';
    const state = keyboardViewport(vv, win.innerHeight);
    applyKeyboardViewport(root, state);
    // The app just shrank to the visible area: a field low on a long page
    // (settings, briefs) may now sit under the fold of its scroll container.
    // 'nearest' is a no-op for the chat composer, already at the bottom.
    if (state.open && !wasOpen) {
      win.document.activeElement?.scrollIntoView?.({ block: 'nearest' });
    }
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    win.requestAnimationFrame(update);
  };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  update();
}
