import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import {
  canEditFromReads,
  canEditGroupInfo,
  GROUP_ACTION_FALLBACK,
  GROUP_INFO_ADMIN_ONLY,
  GroupInfoNotice,
  groupActionMessage,
  requestRename,
  withGroupBusy,
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
  });
});

describe('F1: every group failure is a readable sentence', () => {
  const known: Array<[string, string]> = [
    ['group_name_taken', 'A group with this name already exists'],
    ['group_name_invalid', 'Enter a valid group name'],
    ['group_not_found', 'This group no longer exists'],
    ['member_not_in_workspace', "This person isn't in the workspace"],
    ['group_manage_denied', "Only admins can edit this group's info"],
  ];

  it.each(known)('%s reads "%s", by code or as a bare message', (code, sentence) => {
    expect(groupActionMessage({ code, message: 'raw detail' })).toBe(sentence);
    expect(groupActionMessage({ code: 'unknown', message: code })).toBe(sentence);
  });

  it('an unknown code (and any raw message) reads the fallback, never the raw text', () => {
    expect(GROUP_ACTION_FALLBACK).toBe('Something went wrong. Try again.');
    for (const error of [
      { code: 'weird_code', message: 'weird_code' },
      { code: 'unknown', message: 'Network down' },
      { code: '', message: 'permission denied for table groups' },
    ]) {
      const shown = groupActionMessage(error);
      expect(shown).toBe(GROUP_ACTION_FALLBACK);
      expect(shown).not.toContain(error.code || 'x');
      expect(shown).not.toContain(error.message);
    }
  });
});

describe('F2: a failed or pending role read never blocks the rename', () => {
  const me = 'user-1';
  const creator = (id: string | null) => ({ data: { created_by: id }, error: null });

  it('a failed role read or a failed creator read is unknown (null)', () => {
    expect(canEditFromReads({ currentUserId: me, role: null, creator: creator('u2') })).toBeNull();
    expect(
      canEditFromReads({ currentUserId: me, role: 'agency', creator: { data: null, error: {} } }),
    ).toBeNull();
    expect(canEditFromReads({ currentUserId: me, role: 'agency', creator: creator('u2') })).toBe(
      false,
    );
    expect(canEditFromReads({ currentUserId: me, role: 'agency', creator: creator(me) })).toBe(
      true,
    );
  });

  it('failed or pending read: the RPC is called and its denial maps to the sentence', async () => {
    const rename = vi.fn(() => Promise.resolve({ code: 'group_manage_denied', message: 'x' }));
    const outcome = await requestRename({ canEditInfo: null, rename });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'failed', message: GROUP_INFO_ADMIN_ONLY });
  });

  it('both reads succeeded and the viewer is a known non-admin: not called', async () => {
    const rename = vi.fn(() => Promise.resolve(null));
    expect(await requestRename({ canEditInfo: false, rename })).toEqual({ kind: 'blocked' });
    expect(rename).not.toHaveBeenCalled();
  });

  it('an allowed viewer renames', async () => {
    const rename = vi.fn(() => Promise.resolve(null));
    expect(await requestRename({ canEditInfo: true, rename })).toEqual({ kind: 'done' });
    expect(rename).toHaveBeenCalledTimes(1);
  });
});

describe('F10: the admin-only notice', () => {
  it('uses the chat sheet notice size (13/18/400), not text-sm', () => {
    const notice = GroupInfoNotice();
    const props = notice.props as { className: string; children: string };
    expect({ className: props.className, text: props.children }).toMatchSnapshot();
    expect(renderToStaticMarkup(notice)).not.toContain('text-sm');
  });
});

describe('R6: the group sheet never sticks busy and never shows raw text', () => {
  it('a thrown error resets busy and reads the fallback', async () => {
    const busy: boolean[] = [];
    const failure = await withGroupBusy({
      setBusy: (value) => busy.push(value),
      run: () => Promise.reject(new Error('fetch failed: raw detail')),
      onThrow: { code: '', message: '' },
    });
    expect(busy).toEqual([true, false]);
    const shown = groupActionMessage(failure);
    expect(shown).toBe(GROUP_ACTION_FALLBACK);
    expect(shown).not.toContain('raw detail');
  });

  it('a resolved action resets busy and passes its result through', async () => {
    const busy: boolean[] = [];
    const result = await withGroupBusy({
      setBusy: (value) => busy.push(value),
      run: () => Promise.resolve(null),
      onThrow: { code: '', message: '' },
    });
    expect(result).toBeNull();
    expect(busy).toEqual([true, false]);
  });

  it("maps 'workspace_member_only' to its sentence", () => {
    expect(groupActionMessage({ code: 'workspace_member_only', message: 'x' })).toBe(
      'Only workspace members can do this',
    );
    expect(groupActionMessage({ code: 'unknown', message: 'workspace_member_only' })).toBe(
      'Only workspace members can do this',
    );
  });
});
