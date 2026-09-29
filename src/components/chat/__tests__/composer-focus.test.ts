import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { shouldFocusComposer } from '@/components/chat/Composer';
import { COMPOSER_INPUT_TYPE } from '@/components/chat/chat-type';

describe('composer focus on open', () => {
  const idle = { finePointer: true, editing: false, hashOpen: false, overlayOpen: false };

  it('focuses on a fine pointer (laptop) only', () => {
    expect(shouldFocusComposer(idle)).toBe(true);
    expect(shouldFocusComposer({ ...idle, finePointer: false })).toBe(false);
  });

  it('never steals focus from edit mode, the hash picker, or an open menu / sheet / lightbox', () => {
    expect(shouldFocusComposer({ ...idle, editing: true })).toBe(false);
    expect(shouldFocusComposer({ ...idle, hashOpen: true })).toBe(false);
    expect(shouldFocusComposer({ ...idle, overlayOpen: true })).toBe(false);
  });

  it('the input size comes from chat-type (17/22 mobile, 15/20 laptop)', () => {
    expect(COMPOSER_INPUT_TYPE).toContain('!text-[17px] !leading-[22px]');
    expect(COMPOSER_INPUT_TYPE).toContain('md:!text-[15px] md:!leading-[20px]');
  });
});
