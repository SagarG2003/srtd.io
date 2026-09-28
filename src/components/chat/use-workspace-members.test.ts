import { describe, expect, it } from 'vitest';
import { activeMemberIds } from '@/components/chat/use-workspace-members';

describe('activeMemberIds', () => {
  it('keeps only active members', () => {
    expect(
      activeMemberIds([
        { user_id: 'u1', active: true },
        { user_id: 'removed', active: false },
        { user_id: 'u2', active: true },
      ]),
    ).toEqual(['u1', 'u2']);
  });

  it('de-duplicates by user_id (an owner with an inactive and an active row lists once)', () => {
    expect(
      activeMemberIds([
        { user_id: 'owner', active: false },
        { user_id: 'owner', active: true },
        { user_id: 'u1', active: true },
        { user_id: 'u1', active: true },
      ]),
    ).toEqual(['owner', 'u1']);
  });
});
