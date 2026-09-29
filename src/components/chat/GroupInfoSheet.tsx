import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { IconButton } from '@/components/ui/IconButton';
import { Avatar } from '@/components/ui/Avatar';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { IconSignOut, IconX } from '@/components/ui/icons';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { listGroupMemberIds, readProfiles } from '@/lib/chat-reads';
import {
  addGroupMember,
  leaveGroupChannel,
  removeGroupMember,
  renameGroupChannel,
} from '@/components/chat/chat-actions';
import { MemberPicker } from '@/components/chat/MemberPicker';
import {
  excludeMembers,
  toMemberOptions,
  type MemberOption,
} from '@/components/chat/member-picker';
import { useWorkspaceMembers } from '@/components/chat/use-workspace-members';
import { isOwnerOrAdmin } from '@/components/pages/pcs/roles';
import { fetchMemberRole } from '@/lib/assets';
import { SHEET_NOTICE_TYPE } from '@/components/chat/chat-type';

/** The inline line a member who cannot rename the group sees (WhatsApp's wording). */
export const GROUP_INFO_ADMIN_ONLY = "Only admins can edit this group's info";

/** Any failure without a sentence of its own. */
export const GROUP_ACTION_FALLBACK = 'Something went wrong. Try again.';

/** Every group proc refusal the sheet can meet, as the sentence shown. */
export const GROUP_ACTION_MESSAGES: Readonly<Record<string, string>> = {
  group_name_taken: 'A group with this name already exists',
  group_name_invalid: 'Enter a valid group name',
  group_not_found: 'This group no longer exists',
  member_not_in_workspace: "This person isn't in the workspace",
  group_manage_denied: GROUP_INFO_ADMIN_ONLY,
  workspace_member_only: 'Only workspace members can do this',
};

/** A group action that threw (network, a bug): no code, so it reads the fallback. */
const THROWN_FAILURE = { code: '', message: '' };

/**
 * Run a group action with the sheet busy: busy always resets (try / finally),
 * and a thrown error resolves to `onThrow` instead of escaping, so the sheet
 * never sticks busy and never shows raw error text.
 */
export async function withGroupBusy<T>(input: {
  setBusy: (busy: boolean) => void;
  run: () => Promise<T>;
  onThrow: T;
}): Promise<T> {
  input.setBusy(true);
  try {
    return await input.run();
  } catch {
    return input.onThrow;
  } finally {
    input.setBusy(false);
  }
}

/**
 * Whether the viewer may edit the group's info, mirroring group_rename: the
 * group's creator, or a workspace owner or admin. Pure.
 */
export function canEditGroupInfo(input: {
  currentUserId: string;
  creatorId: string | null;
  role: string | null;
}): boolean {
  return (
    (input.creatorId !== null && input.creatorId === input.currentUserId) ||
    isOwnerOrAdmin(input.role)
  );
}

/**
 * Whether the viewer may edit, from the role and creator reads: null (unknown)
 * when either read failed (no role row, or the creator read erred), so a
 * failed read never blocks. Pure.
 */
export function canEditFromReads(input: {
  currentUserId: string;
  role: string | null;
  creator: { data: unknown; error: unknown };
}): boolean | null {
  if (input.role === null || input.creator.error !== null) return null;
  const creatorId =
    (input.creator.data as { created_by: string | null } | null)?.created_by ?? null;
  return canEditGroupInfo({ currentUserId: input.currentUserId, creatorId, role: input.role });
}

/** What a rename came to: refused before the call, done, or a failure sentence. */
export type RenameOutcome =
  | { kind: 'blocked' }
  | { kind: 'done' }
  | { kind: 'failed'; message: string };

/**
 * Run a rename. It is refused client-side only when both reads succeeded and
 * the viewer is neither the creator nor an owner / admin (canEditInfo false);
 * a pending or failed read (null) calls the proc and lets the server decide,
 * its denial mapped like any other refusal.
 */
export async function requestRename(input: {
  canEditInfo: boolean | null;
  rename: () => Promise<{ code: string; message: string } | null>;
}): Promise<RenameOutcome> {
  if (input.canEditInfo === false) return { kind: 'blocked' };
  const failure = await input.rename();
  return failure === null
    ? { kind: 'done' }
    : { kind: 'failed', message: groupActionMessage(failure) };
}

/**
 * A group action's failure as shown: a readable sentence for every known code
 * (matched on the code, or a message that is a bare code), the fallback for
 * anything else. Never the raw code or error message.
 */
export function groupActionMessage(error: { code: string; message: string }): string {
  return (
    GROUP_ACTION_MESSAGES[error.code] ??
    GROUP_ACTION_MESSAGES[error.message] ??
    GROUP_ACTION_FALLBACK
  );
}

/** The inline notice under the group name (a member who cannot rename). */
export function GroupInfoNotice(): ReactElement {
  return (
    <p id="group-rename-note" role="status" className={`mt-1.5 text-fg-2 ${SHEET_NOTICE_TYPE}`}>
      {GROUP_INFO_ADMIN_ONLY}
    </p>
  );
}

interface GroupInfoSheetProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  groupId: string;
  groupName: string;
  currentUserId: string;
  /** Called after rename / add / remove so the parent refreshes the channel list. */
  onChanged: () => void;
  /** Called after the current user leaves the group. */
  onLeft: () => void;
}

interface MembersState {
  options: MemberOption[];
  loading: boolean;
  error: string | null;
}

/**
 * Group management panel reached from a group channel header: rename the group,
 * add and remove members (removal and leaving are confirmed), and leave the
 * group. Management controls are gated on the actor being a current group member
 * (the app has no finer-grained capability key); a non-member sees a read-only
 * member list. All mutations go through the procs and refresh the affected reads;
 * domain failures surface inline and never throw.
 */
export function GroupInfoSheet(props: GroupInfoSheetProps): ReactElement {
  const newTrace = useNewTrace();
  const workspaceMembers = useWorkspaceMembers(props.workspaceId);

  const [members, setMembers] = useState<MembersState>({
    options: [],
    loading: true,
    error: null,
  });
  const [name, setName] = useState(props.groupName);
  const [addId, setAddId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<MemberOption | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether the viewer may rename: null until the creator and role reads land
  // (the proc stays the authority either way).
  const [canEditInfo, setCanEditInfo] = useState<boolean | null>(null);
  const [infoNotice, setInfoNotice] = useState(false);

  const loadMembers = useCallback(async (): Promise<MembersState> => {
    const ids = await listGroupMemberIds(supabase, { groupId: props.groupId });
    if (!ids.ok) return { options: [], loading: false, error: groupActionMessage(ids.error) };
    const profiles = await readProfiles(supabase, ids.data);
    if (!profiles.ok) {
      return { options: [], loading: false, error: groupActionMessage(profiles.error) };
    }
    return { options: toMemberOptions(profiles.data), loading: false, error: null };
  }, [props.groupId]);

  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setCanEditInfo(null);
    setInfoNotice(false);
    void Promise.all([
      fetchMemberRole(supabase, props.workspaceId, props.currentUserId),
      supabase.from('groups').select('created_by').eq('id', props.groupId).maybeSingle(),
    ])
      .then(([role, creator]) => {
        if (cancelled) return;
        setCanEditInfo(canEditFromReads({ currentUserId: props.currentUserId, role, creator }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [props.open, props.groupId, props.workspaceId, props.currentUserId]);

  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setName(props.groupName);
    setAddId(null);
    setError(null);
    setMembers({ options: [], loading: true, error: null });
    void loadMembers().then((next) => {
      if (!cancelled) setMembers(next);
    });
    return () => {
      cancelled = true;
    };
  }, [props.open, props.groupName, loadMembers]);

  const memberIds = members.options.map((m) => m.userId);
  const canManage = memberIds.includes(props.currentUserId);
  const addOptions = excludeMembers(workspaceMembers.options, memberIds);
  const nameChanged = name.trim().length > 0 && name.trim() !== props.groupName;

  async function refreshMembers(): Promise<void> {
    const next = await loadMembers();
    setMembers(next);
  }

  const infoLocked = canEditInfo === false;
  const showAdminOnly = (): void => setInfoNotice(true);

  async function submitRename(): Promise<void> {
    if (!infoLocked && (!nameChanged || busy)) return;
    setError(null);
    const outcome = await withGroupBusy<RenameOutcome>({
      setBusy,
      run: () =>
        requestRename({
          canEditInfo,
          rename: () =>
            renameGroupChannel(
              supabase,
              { groupId: props.groupId, name: name.trim(), traceId: newTrace() },
              props.onChanged,
            ),
        }),
      onThrow: { kind: 'failed', message: groupActionMessage(THROWN_FAILURE) },
    });
    if (outcome.kind === 'blocked') showAdminOnly();
    else if (outcome.kind === 'failed') {
      if (outcome.message === GROUP_INFO_ADMIN_ONLY) setInfoNotice(true);
      else setError(outcome.message);
    }
  }

  async function submitAdd(): Promise<void> {
    if (addId === null || busy) return;
    const userId = addId;
    setError(null);
    const failure = await withGroupBusy({
      setBusy,
      run: () =>
        addGroupMember(
          supabase,
          { groupId: props.groupId, userId, traceId: newTrace() },
          props.onChanged,
        ),
      onThrow: THROWN_FAILURE,
    });
    if (failure !== null) {
      setError(groupActionMessage(failure));
      return;
    }
    setAddId(null);
    await refreshMembers();
  }

  async function confirmRemove(): Promise<void> {
    if (removeTarget === null) return;
    const userId = removeTarget.userId;
    setError(null);
    const failure = await withGroupBusy({
      setBusy,
      run: () =>
        removeGroupMember(
          supabase,
          { groupId: props.groupId, userId, traceId: newTrace() },
          props.onChanged,
        ),
      onThrow: THROWN_FAILURE,
    });
    setRemoveTarget(null);
    if (failure !== null) {
      setError(groupActionMessage(failure));
      return;
    }
    await refreshMembers();
  }

  async function confirmLeave(): Promise<void> {
    setError(null);
    const failure = await withGroupBusy({
      setBusy,
      run: () =>
        leaveGroupChannel(supabase, { groupId: props.groupId, traceId: newTrace() }, props.onLeft),
      onThrow: THROWN_FAILURE,
    });
    setLeaving(false);
    if (failure !== null) setError(groupActionMessage(failure));
  }

  return (
    <>
      <Sheet open={props.open} onClose={props.onClose} title="Group info">
        {error !== null ? (
          <div
            role="alert"
            className="mb-3 rounded-xl border border-bad bg-bad-soft px-4 py-3 text-sm text-bad"
          >
            {error}
          </div>
        ) : null}

        <div className="flex flex-col gap-5">
          {canManage ? (
            <Field label="Group name" htmlFor="group-rename" required>
              <div className="flex items-center gap-2">
                <Input
                  id="group-rename"
                  value={name}
                  readOnly={infoLocked}
                  aria-readonly={infoLocked || undefined}
                  onChange={(event) => setName(event.target.value)}
                  onClick={infoLocked ? showAdminOnly : undefined}
                  onFocus={infoLocked ? showAdminOnly : undefined}
                  aria-label="Group name"
                  aria-describedby={infoNotice ? 'group-rename-note' : undefined}
                />
                <Button
                  size="lg"
                  variant="primary"
                  disabled={infoLocked ? false : !nameChanged || busy}
                  onClick={() => void submitRename()}
                >
                  Save
                </Button>
              </div>
              {infoNotice ? <GroupInfoNotice /> : null}
            </Field>
          ) : (
            <div>
              <p className="text-sm font-medium">{props.groupName}</p>
            </div>
          )}

          <section>
            <p className="mb-1.5 text-sm font-medium">Members</p>
            {members.loading ? (
              <p className="px-1 py-2 text-sm text-fg-3">Loading members</p>
            ) : members.error !== null ? (
              <div
                role="alert"
                className="rounded-xl border border-bad bg-bad-soft px-4 py-3 text-sm text-bad"
              >
                {members.error}
              </div>
            ) : (
              <ul className="flex flex-col">
                {members.options.map((member) => (
                  <li key={member.userId} className="flex items-center gap-3 px-1 min-h-[44px]">
                    <Avatar
                      name={member.displayName}
                      {...(member.avatarUrl !== null ? { src: member.avatarUrl } : {})}
                      size="md"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">
                      {member.displayName}
                      {member.userId === props.currentUserId ? (
                        <span className="ml-1 text-fg-3">(you)</span>
                      ) : null}
                    </span>
                    {canManage && member.userId !== props.currentUserId ? (
                      <IconButton
                        label={`Remove ${member.displayName}`}
                        disabled={busy}
                        onClick={() => setRemoveTarget(member)}
                      >
                        <IconX size={18} />
                      </IconButton>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {canManage ? (
            <section>
              <p className="mb-1.5 text-sm font-medium">Add members</p>
              <MemberPicker
                options={addOptions}
                selectedIds={addId !== null ? [addId] : []}
                onToggle={(id) => setAddId((prev) => (prev === id ? null : id))}
                loading={workspaceMembers.loading}
                error={
                  workspaceMembers.error !== null
                    ? groupActionMessage({ code: '', message: workspaceMembers.error })
                    : null
                }
                emptyLabel="Everyone in this workspace is already a member."
              />
              <Button
                size="lg"
                variant="primary"
                className="mt-2"
                disabled={addId === null || busy}
                onClick={() => void submitAdd()}
              >
                {busy ? 'Adding' : 'Add to group'}
              </Button>
            </section>
          ) : null}

          {canManage ? (
            <section>
              <Button size="lg" variant="danger" disabled={busy} onClick={() => setLeaving(true)}>
                <IconSignOut size={18} />
                Leave group
              </Button>
            </section>
          ) : null}
        </div>
      </Sheet>

      {removeTarget !== null ? (
        <ConfirmDialog
          title="Remove member"
          message={`Remove ${removeTarget.displayName} from this group?`}
          confirmLabel="Remove"
          destructive
          busy={busy}
          busyLabel="Removing"
          onConfirm={() => void confirmRemove()}
          onCancel={() => setRemoveTarget(null)}
        />
      ) : null}

      {leaving ? (
        <ConfirmDialog
          title="Leave group"
          message="You will stop receiving messages in this group. Leave it?"
          confirmLabel="Leave"
          destructive
          busy={busy}
          busyLabel="Leaving"
          onConfirm={() => void confirmLeave()}
          onCancel={() => setLeaving(false)}
        />
      ) : null}
    </>
  );
}
