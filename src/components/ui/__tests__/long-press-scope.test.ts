import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelPendingLongPressesWithin,
  createLongPressController,
  LONG_PRESS_MS,
} from '@/components/ui/useLongPress';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('cancelPendingLongPressesWithin', () => {
  it('cancels only the holds pressed inside the given element', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
    const inside = vi.fn();
    const outside = vi.fn();
    const cardEl = { id: 'card' };
    const listRowEl = { id: 'row' };
    const bubbleEl = { contains: (node: unknown) => node === cardEl };
    const card = createLongPressController({ onLongPress: inside });
    const row = createLongPressController({ onLongPress: outside });
    card.handlers.onPointerDown({
      clientX: 0,
      clientY: 0,
      pointerType: 'touch',
      currentTarget: cardEl,
    });
    row.handlers.onPointerDown({
      clientX: 0,
      clientY: 0,
      pointerType: 'touch',
      currentTarget: listRowEl,
    });
    cancelPendingLongPressesWithin(bubbleEl);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(inside).not.toHaveBeenCalled();
    expect(outside).toHaveBeenCalledTimes(1);
  });

  it('a press without a target (existing callers) is never cancelled by a scope', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
    const held = vi.fn();
    const c = createLongPressController({ onLongPress: held });
    c.handlers.onPointerDown({ clientX: 0, clientY: 0, pointerType: 'touch' });
    cancelPendingLongPressesWithin({ contains: () => true });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(held).toHaveBeenCalledTimes(1);
  });
});
