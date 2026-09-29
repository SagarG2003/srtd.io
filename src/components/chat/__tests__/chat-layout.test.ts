import { afterEach, describe, expect, it, vi } from 'vitest';
import * as chatType from '@/components/chat/chat-type';
import {
  chatLayout,
  HOVER_POINTER_QUERY,
  LAPTOP_LAYOUT_QUERY,
  readChatLayout,
  type ChatSize,
} from '@/components/chat/chat-type';

describe('F12: the size table follows the input, not the width', () => {
  it('coarse 1024 -> touch; coarse 390 -> touch; fine 1280 -> laptop; fine 700 -> touch', () => {
    expect(chatLayout({ finePointer: false, widthPx: 1024 })).toBe('touch');
    expect(chatLayout({ finePointer: false, widthPx: 390 })).toBe('touch');
    expect(chatLayout({ finePointer: true, widthPx: 1280 })).toBe('laptop');
    expect(chatLayout({ finePointer: true, widthPx: 700 })).toBe('touch');
  });

  it('the laptop query is the hover-pointer query AND 768px', () => {
    expect(HOVER_POINTER_QUERY).toBe('(hover: hover) and (pointer: fine)');
    expect(LAPTOP_LAYOUT_QUERY).toBe(`${HOVER_POINTER_QUERY} and (min-width: 768px)`);
  });

  it('every paired chat size has a touch and a laptop value and no width breakpoint', () => {
    const pairs = Object.values(chatType).filter(
      (value): value is ChatSize =>
        typeof value === 'object' && value !== null && 'touch' in value && 'laptop' in value,
    );
    expect(pairs.length).toBeGreaterThanOrEqual(12);
    for (const pair of pairs) {
      expect(pair.touch).not.toContain('md:');
      expect(pair.laptop).not.toContain('md:');
    }
  });
});

describe('F12: first paint resolves synchronously', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubMatchMedia(matches: (query: string) => boolean): void {
    vi.stubGlobal('window', {
      matchMedia: (query: string) => ({ matches: matches(query) }),
    });
  }

  it('reads matchMedia on the call, so the initializer already has the final table', () => {
    stubMatchMedia((query) => query === LAPTOP_LAYOUT_QUERY);
    expect(readChatLayout()).toBe('laptop');
    stubMatchMedia(() => false);
    expect(readChatLayout()).toBe('touch');
  });

  it('with no matchMedia (server, tests) it is touch', () => {
    vi.stubGlobal('window', {});
    expect(readChatLayout()).toBe('touch');
  });
});
