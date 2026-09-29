import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  canEditGroupInfo,
  GROUP_INFO_ADMIN_ONLY,
  groupActionMessage,
} from '@/components/chat/GroupInfoSheet';

describe('group info permission (mirrors group_rename)', () => {
  const me = 'user-1';

  it('the creator may edit', () => {
    expect(canEditGroupInfo({ currentUserId: me, creatorId: me, role: 'agency' })).toBe(true);
  });

  it('a workspace owner or admin may edit', () => {
    expect(canEditGroupInfo({ currentUserId: me, creatorId: 'u2', role: 'owner' })).toBe(true);
    expect(canEditGroupInfo({ currentUserId: me, creatorId: null, role: 'admin' })).toBe(true);
  });

  it('anyone else may not', () => {
    expect(canEditGroupInfo({ currentUserId: me, creatorId: 'u2', role: 'agency' })).toBe(false);
    expect(canEditGroupInfo({ currentUserId: me, creatorId: 'u2', role: 'client' })).toBe(false);
    expect(canEditGroupInfo({ currentUserId: me, creatorId: null, role: null })).toBe(false);
  });

  it("maps 'group_manage_denied' to the WhatsApp line; never the raw code", () => {
    expect(GROUP_INFO_ADMIN_ONLY).toBe("Only admins can edit this group's info");
    expect(groupActionMessage({ code: 'unknown', message: 'group_manage_denied' })).toBe(
      GROUP_INFO_ADMIN_ONLY,
    );
    expect(groupActionMessage({ code: 'group_manage_denied', message: 'x' })).toBe(
      GROUP_INFO_ADMIN_ONLY,
    );
    expect(groupActionMessage({ code: 'unknown', message: 'Network down' })).toBe('Network down');
  });
});
