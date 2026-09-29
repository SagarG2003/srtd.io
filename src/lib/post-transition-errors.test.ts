import { describe, expect, it } from 'vitest';
import { friendlyTransitionError } from '@/lib/post-transition-errors';

describe('friendlyTransitionError', () => {
  it('maps each known proc code to its inline copy', () => {
    expect(friendlyTransitionError({ code: 'forbidden_role', message: 'forbidden_role' })).toBe(
      'You do not have permission to make this change.',
    );
    expect(
      friendlyTransitionError({
        code: 'invalid_stage_transition',
        message: 'invalid_stage_transition',
      }),
    ).toBe('That move is not allowed from the current stage.');
    expect(
      friendlyTransitionError({ code: 'workspace_member_only', message: 'workspace_member_only' }),
    ).toBe('You must be a member of this workspace to make this change.');
  });

  it('falls back to a generic retry line for anything else', () => {
    expect(friendlyTransitionError({ code: 'unknown', message: 'boom' })).toBe(
      'Something went wrong. Please try again.',
    );
  });
});
