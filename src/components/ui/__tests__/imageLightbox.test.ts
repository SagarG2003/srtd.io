import { describe, expect, it } from 'vitest';
import {
  canPage,
  clampPan,
  clampZoom,
  createScrollLock,
  DISMISS_DISTANCE,
  dismissOpacity,
  dominantAxisSwipe,
  doubleTapTarget,
  downloadLink,
  dragAxis,
  lightboxCounter,
  shouldDismiss,
  wrapIndex,
  zoomAt,
  ZOOM_RESET,
  type LockableBody,
} from '@/components/ui/ImageLightbox';

// Pure, DOM-free coverage for the shared viewer's navigation math, its swipe
// gate, and its ref-counted body scroll lock (exercised through an injected
// fake body so no DOM is needed under the node test environment).

describe('wrapIndex', () => {
  it('loops from the last index forward to the first', () => {
    expect(wrapIndex(2, 1, 3)).toBe(0);
  });

  it('loops from the first index backward to the last', () => {
    expect(wrapIndex(0, -1, 3)).toBe(2);
  });

  it('steps within range without wrapping', () => {
    expect(wrapIndex(0, 1, 3)).toBe(1);
    expect(wrapIndex(2, -1, 3)).toBe(1);
  });

  it('always returns 0 for a single image, either direction', () => {
    expect(wrapIndex(0, 1, 1)).toBe(0);
    expect(wrapIndex(0, -1, 1)).toBe(0);
  });

  it('returns 0 for zero images', () => {
    expect(wrapIndex(0, 1, 0)).toBe(0);
    expect(wrapIndex(0, -1, 0)).toBe(0);
  });
});

describe('lightboxCounter', () => {
  it('formats a 1-based n / N counter', () => {
    expect(lightboxCounter(0, 3)).toBe('1 / 3');
    expect(lightboxCounter(2, 3)).toBe('3 / 3');
  });
});

describe('dominantAxisSwipe', () => {
  it('accepts a long, dominantly-horizontal swipe', () => {
    expect(dominantAxisSwipe(80, 10)).toBe(true);
  });

  it('rejects a swipe that is not dominantly horizontal', () => {
    expect(dominantAxisSwipe(80, 70)).toBe(false);
  });

  it('rejects a swipe below the horizontal threshold', () => {
    expect(dominantAxisSwipe(30, 0)).toBe(false);
  });
});

describe('createScrollLock', () => {
  function fakeBody(): LockableBody {
    return {
      style: { overflow: 'visible', touchAction: 'auto', paddingRight: '3px' },
      clientWidth: 980,
    };
  }

  it('acquires on first lock and restores the exact prior styles on release', () => {
    const body = fakeBody();
    const lock = createScrollLock(
      () => body,
      () => 1000,
    );

    lock.acquire();
    expect(body.style.overflow).toBe('hidden');
    expect(body.style.touchAction).toBe('none');
    // Scrollbar gutter (1000 - 980) is compensated as padding-right.
    expect(body.style.paddingRight).toBe('20px');

    lock.release();
    expect(body.style.overflow).toBe('visible');
    expect(body.style.touchAction).toBe('auto');
    expect(body.style.paddingRight).toBe('3px');
  });

  it('does not release early while a nested acquire is still open', () => {
    const body = fakeBody();
    const lock = createScrollLock(
      () => body,
      () => 1000,
    );

    lock.acquire();
    lock.acquire();

    // Inner release: still locked.
    lock.release();
    expect(body.style.overflow).toBe('hidden');
    expect(body.style.touchAction).toBe('none');

    // Outer release: fully restored.
    lock.release();
    expect(body.style.overflow).toBe('visible');
    expect(body.style.touchAction).toBe('auto');
    expect(body.style.paddingRight).toBe('3px');
  });
});

describe('zoom helpers', () => {
  const rect = { left: 0, top: 0, width: 400, height: 800 };

  it('clamps pinch scale to 1..4', () => {
    expect(clampZoom(0.4)).toBe(1);
    expect(clampZoom(2.2)).toBe(2.2);
    expect(clampZoom(9)).toBe(4);
  });

  it('double-tap toggles 1x <-> 2.5x', () => {
    expect(doubleTapTarget(1)).toBe(2.5);
    expect(doubleTapTarget(2.5)).toBe(1);
    expect(doubleTapTarget(3.7)).toBe(1);
  });

  it('zooms at the focal point and resets fully at 1x', () => {
    // Centre tap: no pan needed.
    expect(zoomAt(ZOOM_RESET, 2.5, 200, 400, rect)).toEqual({ scale: 2.5, x: 0, y: 0 });
    // Zooming back to 1x drops the pan.
    expect(zoomAt({ scale: 2.5, x: 40, y: -30 }, 1, 10, 10, rect)).toEqual(ZOOM_RESET);
    // Never beyond 4x.
    expect(zoomAt(ZOOM_RESET, 12, 200, 400, rect).scale).toBe(4);
  });

  it('bounds the pan to the scaled pane', () => {
    expect(clampPan(2, 999, -999, rect)).toEqual({ scale: 2, x: 200, y: -400 });
    expect(clampPan(1, 50, 50, rect)).toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe('gesture axes', () => {
  it('paging is disabled while zoomed and for a single image', () => {
    expect(canPage(3, 1)).toBe(true);
    expect(canPage(3, 1.5)).toBe(false);
    expect(canPage(1, 1)).toBe(false);
  });

  it('a downward vertical drag is a dismiss (Y); a sideways one pages (X)', () => {
    expect(dragAxis(2, 3)).toBeNull();
    expect(dragAxis(4, 40)).toBe('y');
    expect(dragAxis(40, 4)).toBe('x');
    // Upward is never a dismiss.
    expect(dragAxis(4, -40)).toBe('x');
  });

  it('dismisses past 120px or on a fast flick, otherwise springs back', () => {
    expect(DISMISS_DISTANCE).toBe(120);
    expect(shouldDismiss(120, 0)).toBe(true);
    expect(shouldDismiss(119, 0.1)).toBe(false);
    expect(shouldDismiss(40, 0.9)).toBe(true);
    expect(shouldDismiss(0, 2)).toBe(false);
  });

  it('fades the backdrop as the drag grows', () => {
    expect(dismissOpacity(0)).toBe(1);
    expect(dismissOpacity(200)).toBeCloseTo(0.6);
    expect(dismissOpacity(10_000)).toBeCloseTo(0.2);
  });
});

describe('downloadLink', () => {
  it('links the presigned GET url with the file name', () => {
    expect(
      downloadLink({
        url: 'https://signed/a.png',
        name: 'a.png',
        presignEnabled: true,
        local: false,
      }),
    ).toEqual({ href: 'https://signed/a.png', download: 'a.png' });
  });

  it('is disabled (null) while the presign is pending or presign is disabled', () => {
    expect(
      downloadLink({ url: null, name: 'a.png', presignEnabled: true, local: false }),
    ).toBeNull();
    expect(
      downloadLink({
        url: 'https://signed/a.png',
        name: 'a.png',
        presignEnabled: false,
        local: false,
      }),
    ).toBeNull();
  });

  it('downloads a local preview without presigning, and names a blank file', () => {
    expect(downloadLink({ url: 'blob:x', name: ' ', presignEnabled: false, local: true })).toEqual({
      href: 'blob:x',
      download: 'image',
    });
  });
});
