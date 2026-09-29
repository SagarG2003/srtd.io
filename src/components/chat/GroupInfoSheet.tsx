import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ReactElement, ReactNode } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { IconButton } from '@/components/ui/IconButton';
import { Avatar } from '@/components/ui/Avatar';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  IconCamera,
  IconImage,
  IconPlus,
  IconSignOut,
  IconTrash,
  IconX,
} from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { supabase } from '@/lib/supabase';
import { uploadAvatarFile } from '@/lib/avatar-upload';
import { groupAvatarPng } from '@/lib/chat/group-avatar';
import { useNewTrace } from '@/lib/trace-context';
import { listGroupMemberIds, readProfiles } from '@/lib/chat-reads';
import {
  addGroupMember,
  leaveGroupChannel,
  removeGroupMember,
  renameGroupChannel,
  setGroupAvatar,
} from '@/components/chat/chat-actions';
import { MemberPicker } from '@/components/chat/MemberPicker';
import {
  excludeMembers,
  toMemberOptions,
  type MemberOption,
} from '@/components/chat/member-picker';
import { useWorkspaceMembers } from '@/components/chat/use-workspace-members';
import { isOwnerOrAdmin } from '@/components/pages/pcs/roles';
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
  group_avatar_invalid: "That photo can't be used. Try another",
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

/** Under the kept member list when its re-read failed: the line is the retry. */
export function MembersRefreshNotice(props: { onRetry: () => void }): ReactElement {
  return (
    <button
      type="button"
      role="status"
      data-members-refresh=""
      onClick={props.onRetry}
      className={`mt-1 flex min-h-[44px] w-full items-center px-1 text-left text-fg-2 underline-offset-2 hover:underline ${SHEET_NOTICE_TYPE}`}
    >
      {MEMBERS_REFRESH_FAILED}
    </button>
  );
}

interface GroupInfoSheetProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  /** The workspace's name for the "Group · n members · <workspace>" line. */
  workspaceName: string | undefined;
  groupId: string;
  groupName: string;
  /** groups.avatar_url from the channel list read; null shows the initials fallback. */
  avatarUrl: string | null;
  /** groups.created_by from the channel list read. */
  createdBy: string | null;
  /** The viewer's workspace role from the already-loaded chat members; null while unknown. */
  viewerRole: string | null;
  currentUserId: string;
  /** Called after rename / photo / add / remove so the parent refreshes the channel list. */
  onChanged: () => void;
  /** Called after the current user leaves the group. */
  onLeft: () => void;
}

/** "Group · <n> members · <workspace>"; the count only once the member list is in. Pure. */
export function groupInfoSubtitle(memberCount: number | null, workspaceName?: string): string {
  const parts = ['Group'];
  if (memberCount !== null)
    parts.push(`${memberCount} ${memberCount === 1 ? 'member' : 'members'}`);
  if (workspaceName !== undefined && workspaceName !== '') parts.push(workspaceName);
  return parts.join(' · ');
}

/**
 * The sections the sheet shows, top to bottom. PHOTO and NAME exist only for a
 * viewer who may edit the group's info (creator or workspace owner/admin); a
 * plain member never sees them (hidden, not greyed). Pure.
 */
export function groupInfoSections(canEdit: boolean): ReadonlyArray<'photo' | 'name' | 'members'> {
  return canEdit ? ['photo', 'name', 'members'] : ['members'];
}

/** The photo option rows: which appear, in order. Remove only when a photo is set. Pure. */
export function groupPhotoOptions(
  hasPhoto: boolean,
): ReadonlyArray<'camera' | 'library' | 'remove'> {
  return hasPhoto ? ['camera', 'library', 'remove'] : ['camera', 'library'];
}

/** A 48px sheet row: a real button, icon then label; `danger` uses the destructive token. */
function SheetRow(props: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  data?: string;
}): ReactElement {
  return (
    <button
      type="button"
      data-row={props.data}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        'flex h-12 w-full select-none items-center gap-3 rounded-lg px-3 text-left text-sm font-medium [-webkit-touch-callout:none]',
        'hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50',
        props.danger === true ? 'text-bad' : 'text-fg',
      )}
    >
      <span
        className={cn(
          'flex w-5 shrink-0 justify-center',
          props.danger === true ? 'text-bad' : 'text-fg-2',
        )}
      >
        {props.icon}
      </span>
      {props.label}
    </button>
  );
}

/** A section heading: small caps label over its rows. */
function SectionLabel(props: { children: string }): ReactElement {
  return (
    <p className="mb-1 px-1 text-xs font-medium uppercase tracking-wide text-fg-3">
      {props.children}
    </p>
  );
}

export interface MembersState {
  options: MemberOption[];
  loading: boolean;
  error: string | null;
}

/** The line when the member list could not be re-read after an add or remove. */
export const MEMBERS_REFRESH_FAILED = "Couldn't refresh members, try again";

/**
 * The member list after a refresh (following an add or remove). A failed
 * re-read keeps the list already shown and flags the failure (the sheet says
 * so, with a retry); a successful one replaces it. Pure.
 */
export function membersAfterRefresh(
  current: MembersState,
  next: MembersState,
): { members: MembersState; refreshFailed: boolean } {
  if (next.error === null) return { members: next, refreshFailed: false };
  return { members: current, refreshFailed: true };
}

/**
 * Group info, reached by tapping the group thread header (same gesture as the
 * DM Contact sheet). Top to bottom: the 112px group photo with its camera badge,
 * the name and "Group · n members · workspace" line, then PHOTO (take, choose,
 * remove), NAME (rename on blur / Done) and MEMBERS (list, add, remove, leave).
 * PHOTO and NAME are hidden unless the viewer is the group's creator or a
 * workspace owner/admin, derived from data the chat already loaded; the procs
 * (group_avatar_set, group_rename) enforce the same rule server-side. Member
 * management stays gated on the viewer being a current group member. Domain
 * failures surface inline and never throw.
 */
export function GroupInfoSheet(props: GroupInfoSheetProps): ReactElement {
  const newTrace = useNewTrace();
  const workspaceMembers = useWorkspaceMembers(props.workspaceId);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);

  const [members, setMembers] = useState<MembersState>({
    options: [],
    loading: true,
    error: null,
  });
  const [name, setName] = useState(props.groupName);
  // The photo shown: the list read's URL, then whatever this sheet last set.
  const [photoUrl, setPhotoUrl] = useState<string | null>(props.avatarUrl);
  const [photoOptionsOpen, setPhotoOptionsOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addId, setAddId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<MemberOption | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The last member re-read (after an add or remove) failed; the list shown is the previous one.
  const [refreshFailed, setRefreshFailed] = useState(false);

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
    setName(props.groupName);
    setAddId(null);
    setAdding(false);
    setError(null);
    setRefreshFailed(false);
    setMembers({ options: [], loading: true, error: null });
    void loadMembers().then((next) => {
      if (!cancelled) setMembers(next);
    });
    return () => {
      cancelled = true;
    };
  }, [props.open, props.groupName, loadMembers]);

  useEffect(() => {
    if (props.open) setPhotoUrl(props.avatarUrl);
  }, [props.open, props.avatarUrl]);

  const canEditInfo = canEditGroupInfo({
    currentUserId: props.currentUserId,
    creatorId: props.createdBy,
    role: props.viewerRole,
  });
  const sections = groupInfoSections(canEditInfo);
  const memberIds = members.options.map((m) => m.userId);
  const canManage = memberIds.includes(props.currentUserId);
  const addOptions = excludeMembers(workspaceMembers.options, memberIds);
  const nameChanged = name.trim().length > 0 && name.trim() !== props.groupName;
  const memberCount = members.loading || members.error !== null ? null : members.options.length;

  async function refreshMembers(): Promise<void> {
    const next = await loadMembers();
    const outcome = membersAfterRefresh(members, next);
    setMembers(outcome.members);
    setRefreshFailed(outcome.refreshFailed);
  }

  async function submitRename(): Promise<void> {
    if (!nameChanged || busy) return;
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
    if (outcome.kind === 'blocked') setError(GROUP_INFO_ADMIN_ONLY);
    else if (outcome.kind === 'failed') setError(outcome.message);
  }

  /** Crop, upload through the avatar-upload worker, then group_avatar_set; one trace id. */
  async function uploadPhoto(file: File): Promise<void> {
    if (busy) return;
    const traceId = newTrace();
    setError(null);
    const failure = await withGroupBusy<string | null>({
      setBusy,
      run: async () => {
        const endpoint = env.VITE_AVATAR_UPLOAD_URL;
        if (endpoint === undefined) return 'Photo upload is not configured';
        const png = await groupAvatarPng(file);
        if (png === null) return 'Could not read the photo. Choose it again';
        const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
        const up = await uploadAvatarFile(png, {
          endpoint,
          token,
          fetcher: (input, init) => fetchWithTrace(input, init, traceId),
          target: { kind: 'group', id: props.groupId, apiKey: env.VITE_SUPABASE_PUBLISHABLE_KEY },
        });
        if (!up.ok) return up.error.message;
        const set = await setGroupAvatar(
          supabase,
          { groupId: props.groupId, avatarUrl: up.data.avatarUrl, traceId },
          props.onChanged,
        );
        if (set !== null) return groupActionMessage(set);
        setPhotoUrl(up.data.avatarUrl);
        return null;
      },
      onThrow: GROUP_ACTION_FALLBACK,
    });
    if (failure !== null) setError(failure);
  }

  async function removePhoto(): Promise<void> {
    if (busy) return;
    setError(null);
    const failure = await withGroupBusy({
      setBusy,
      run: () =>
        setGroupAvatar(
          supabase,
          { groupId: props.groupId, avatarUrl: null, traceId: newTrace() },
          props.onChanged,
        ),
      onThrow: THROWN_FAILURE,
    });
    if (failure !== null) setError(groupActionMessage(failure));
    else setPhotoUrl(null);
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

  function onFilePicked(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    // Reset so picking the same file again still fires a change event.
    event.target.value = '';
    if (file !== undefined) void uploadPhoto(file);
  }

  function runPhotoOption(option: 'camera' | 'library' | 'remove'): void {
    setPhotoOptionsOpen(false);
    if (option === 'camera') cameraInputRef.current?.click();
    else if (option === 'library') libraryInputRef.current?.click();
    else void removePhoto();
  }

  function photoRows(): ReactElement {
    return (
      <div className="flex flex-col">
        {groupPhotoOptions(photoUrl !== null).map((option) =>
          option === 'camera' ? (
            <SheetRow
              key={option}
              data="photo-camera"
              icon={<IconCamera size={20} />}
              label="Take photo"
              disabled={busy}
              onClick={() => runPhotoOption(option)}
            />
          ) : option === 'library' ? (
            <SheetRow
              key={option}
              data="photo-library"
              icon={<IconImage size={20} />}
              label="Choose from library"
              disabled={busy}
              onClick={() => runPhotoOption(option)}
            />
          ) : (
            <SheetRow
              key={option}
              data="photo-remove"
              icon={<IconTrash size={20} />}
              label="Remove photo"
              danger
              disabled={busy}
              onClick={() => runPhotoOption(option)}
            />
          ),
        )}
      </div>
    );
  }

  const photo = (
    <Avatar
      key={photoUrl ?? 'none'}
      name={props.groupName}
      size="hero"
      shape="rounded"
      {...(photoUrl !== null ? { src: photoUrl } : {})}
    />
  );

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
          <div className="flex flex-col items-center gap-1 text-center">
            {canEditInfo ? (
              <button
                type="button"
                data-group-photo=""
                aria-label="Change group photo"
                disabled={busy}
                onClick={() => setPhotoOptionsOpen(true)}
                className="relative h-[112px] w-[112px] select-none rounded-[24px] [-webkit-touch-callout:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {photo}
                <span
                  data-camera-badge=""
                  aria-hidden="true"
                  className="absolute -bottom-1 -right-1 flex h-10 w-10 items-center justify-center rounded-full bg-accent text-accent-fg ring-4 ring-panel"
                >
                  <IconCamera size={20} />
                </span>
              </button>
            ) : (
              photo
            )}
            <span className="mt-2 max-w-full truncate text-lg font-semibold text-fg">
              {props.groupName}
            </span>
            <span data-group-subtitle="" className="max-w-full truncate text-sm text-fg-2">
              {groupInfoSubtitle(memberCount, props.workspaceName)}
            </span>
            {busy ? (
              <span role="status" className="text-xs text-fg-3">
                Saving
              </span>
            ) : null}
          </div>

          {sections.includes('photo') ? (
            <section data-section="photo">
              <SectionLabel>Photo</SectionLabel>
              {photoRows()}
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={onFilePicked}
              />
              <input
                ref={libraryInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={onFilePicked}
              />
            </section>
          ) : null}

          {sections.includes('name') ? (
            <section data-section="name">
              <SectionLabel>Name</SectionLabel>
              <Input
                id="group-rename"
                value={name}
                enterKeyHint="done"
                onChange={(event) => setName(event.target.value)}
                onBlur={() => void submitRename()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
                aria-label="Group name"
              />
            </section>
          ) : null}

          <section data-section="members">
            <SectionLabel>Members</SectionLabel>
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
            {refreshFailed && !members.loading && members.error === null ? (
              <MembersRefreshNotice onRetry={() => void refreshMembers()} />
            ) : null}
            {canManage ? (
              <SheetRow
                data="member-add"
                icon={<IconPlus size={20} />}
                label="Add member"
                onClick={() => setAdding((prev) => !prev)}
              />
            ) : null}
            {canManage && adding ? (
              <div className="mt-1">
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
              </div>
            ) : null}
          </section>

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

      {canEditInfo ? (
        <Sheet
          open={photoOptionsOpen}
          onClose={() => setPhotoOptionsOpen(false)}
          title="Group photo"
        >
          {photoRows()}
        </Sheet>
      ) : null}

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
