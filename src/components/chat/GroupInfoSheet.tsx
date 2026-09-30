// Group info, full screen over the app like the DM Contact page: the group
// photo (camera badge opens the shared photo sheet), name and subtitle, the
// shared chat info tabs in preview mode, then NAME, MEMBERS and Leave group.
// The page opens and closes without motion; colours are tokens only, so light
// and dark match.

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { IconButton } from '@/components/ui/IconButton';
import { Avatar } from '@/components/ui/Avatar';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PhotoOptionsSheet, type PhotoOptionsSheetProps } from '@/components/ui/PhotoOptionsSheet';
import { IconCamera, IconChevronLeft, IconPlus, IconSignOut, IconX } from '@/components/ui/icons';
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
import { ChatInfoTabs, type ChatInfoTabsProps } from '@/components/chat/ChatInfoTabs';
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

/**
 * The chat info tabs wiring the thread already holds (the same values the DM
 * Contact page receives): the group page adds mode, open, frame and Escape.
 */
export type GroupInfoTabsWiring = Omit<ChatInfoTabsProps, 'mode' | 'open' | 'frame' | 'onEscape'>;

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
  /** The thread's chat info tabs wiring (profiles, presign cache, marks, jump). */
  tabs: GroupInfoTabsWiring;
}

/** "Group · <n> members · <workspace>"; the count only once the member list is in. Pure. */
export function groupInfoSubtitle(memberCount: number | null, workspaceName?: string): string {
  const parts = ['Group'];
  if (memberCount !== null)
    parts.push(`${memberCount} ${memberCount === 1 ? 'member' : 'members'}`);
  if (workspaceName !== undefined && workspaceName !== '') parts.push(workspaceName);
  return parts.join(' · ');
}

export type GroupInfoSection = 'hero' | 'tabs' | 'name' | 'members' | 'leave';

/**
 * The page's sections, top to bottom. NAME exists only for a viewer who may
 * edit the group's info (creator or workspace owner/admin); Leave only for a
 * current member. Hidden, never greyed. Pure.
 */
export function groupInfoSections(
  canEdit: boolean,
  canLeave: boolean,
): ReadonlyArray<GroupInfoSection> {
  return [
    'hero',
    'tabs',
    ...(canEdit ? (['name'] as const) : []),
    'members',
    ...(canLeave ? (['leave'] as const) : []),
  ];
}

/** The page title, and the back button's label. */
export const GROUP_INFO_HEADING = 'Group info';
export const GROUP_PHOTO_TITLE = 'Group photo';

/** The shared photo sheet's props: onFile is the upload path, onRemove the remove path. Pure. */
export function groupPhotoSheetProps(input: {
  open: boolean;
  onClose: () => void;
  hasPhoto: boolean;
  upload: (file: File) => void;
  remove: () => void;
}): PhotoOptionsSheetProps {
  return {
    open: input.open,
    onClose: input.onClose,
    title: GROUP_PHOTO_TITLE,
    hasPhoto: input.hasPhoto,
    onFile: input.upload,
    onRemove: input.remove,
  };
}

/**
 * The preview tabs, keyed by channel, wired like the DM page: a jump closes
 * the page first; Escape closes it unless the lightbox (or `escape` null,
 * another overlay) owns the key.
 */
export function groupInfoTabs(input: {
  tabs: GroupInfoTabsWiring;
  open: boolean;
  onClose: () => void;
  escape: (() => void) | null;
  frame: (tabs: ReactElement) => ReactElement;
}): ReactElement {
  const { tabs, onClose } = input;
  return (
    <ChatInfoTabs
      key={tabs.channelId}
      {...tabs}
      mode="preview"
      open={input.open}
      onJump={(messageId) => {
        onClose();
        tabs.onJump(messageId);
      }}
      {...(input.escape !== null ? { onEscape: input.escape } : {})}
      frame={input.frame}
    />
  );
}

/** A 48px row: a real button, icon then label. */
function SheetRow(props: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  data?: string;
}): ReactElement {
  return (
    <button
      type="button"
      data-row={props.data}
      onClick={props.onClick}
      className="flex h-12 w-full select-none items-center gap-3 rounded-lg px-3 text-left text-sm font-medium text-fg [-webkit-touch-callout:none] hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
    >
      <span className="flex w-5 shrink-0 justify-center text-fg-2">{props.icon}</span>
      {props.label}
    </button>
  );
}

/** Leave group: a 56px full-width outlined row, destructive text, no filled red. */
export function LeaveGroupRow(props: { disabled: boolean; onClick: () => void }): ReactElement {
  return (
    <button
      type="button"
      data-row="leave-group"
      disabled={props.disabled}
      onClick={props.onClick}
      className="flex min-h-[56px] w-full select-none items-center gap-3 rounded-lg border border-border px-4 text-left text-sm font-medium text-bad [-webkit-touch-callout:none] hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
    >
      <span className="flex w-5 shrink-0 justify-center text-bad">
        <IconSignOut size={18} />
      </span>
      Leave group
    </button>
  );
}

/**
 * The 112px group photo, name and subtitle. An editor gets the camera badge
 * (its ring is the page background it sits on); a plain member gets none. The
 * photo paints from the list read's URL on the first frame. Hook-free.
 */
export function GroupHero(props: {
  name: string;
  photoUrl: string | null;
  subtitle: string;
  canEdit: boolean;
  busy: boolean;
  onPhoto: () => void;
}): ReactElement {
  const photo = (
    <Avatar
      key={props.photoUrl ?? 'none'}
      name={props.name}
      size="hero"
      shape="rounded"
      {...(props.photoUrl !== null ? { src: props.photoUrl } : {})}
    />
  );
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      {props.canEdit ? (
        <button
          type="button"
          data-group-photo=""
          aria-label="Change group photo"
          disabled={props.busy}
          onClick={props.onPhoto}
          className="relative h-[112px] w-[112px] select-none rounded-[24px] [-webkit-touch-callout:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {photo}
          <span
            data-camera-badge=""
            aria-hidden="true"
            className="absolute -bottom-1 -right-1 flex h-10 w-10 items-center justify-center rounded-full bg-accent text-accent-fg ring-4 ring-bg"
          >
            <IconCamera size={20} />
          </span>
        </button>
      ) : (
        photo
      )}
      <span className="mt-2 max-w-full truncate text-lg font-semibold text-fg">{props.name}</span>
      <span data-group-subtitle="" className="max-w-full truncate text-sm text-fg-2">
        {props.subtitle}
      </span>
      {props.busy ? (
        <span role="status" className="text-xs text-fg-3">
          Saving
        </span>
      ) : null}
    </div>
  );
}

/**
 * The page chrome: back bar, then the scrolling body with the sections in
 * `groupInfoSections` order, bottom padding clear of the home indicator.
 * Hook-free; `nodes` holds each section's content.
 */
export function groupInfoPage(props: {
  onClose: () => void;
  error: string | null;
  sections: ReadonlyArray<GroupInfoSection>;
  nodes: Readonly<Record<GroupInfoSection, ReactNode>>;
}): ReactElement {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={GROUP_INFO_HEADING}
      data-group-page=""
      className="fixed inset-0 z-50 flex flex-col bg-bg"
    >
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border bg-panel px-2 md:px-4">
        <IconButton label="Close group info" onClick={props.onClose}>
          <IconChevronLeft size={20} />
        </IconButton>
        <h2 className="truncate text-[15px] font-semibold text-fg">{GROUP_INFO_HEADING}</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-6">
          {props.error !== null ? (
            <div
              role="alert"
              className="rounded-xl border border-bad bg-bad-soft px-4 py-3 text-sm text-bad"
            >
              {props.error}
            </div>
          ) : null}
          {props.sections.map((section) => (
            <section
              key={section}
              data-section={section}
              {...(section === 'tabs' ? { className: 'flex flex-col gap-4' } : {})}
            >
              {props.nodes[section]}
            </section>
          ))}
        </div>
      </div>
    </div>
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
 * DM Contact page). The camera badge and NAME are hidden unless the viewer is
 * the group's creator or a workspace owner/admin, derived from data the chat
 * already loaded; the procs (group_avatar_set, group_rename) enforce the same
 * rule server-side. Member management stays gated on the viewer being a
 * current group member. Domain failures surface inline and never throw.
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
  // The photo shown: the list read's URL, then whatever this page last set.
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
  const memberIds = members.options.map((m) => m.userId);
  const canManage = memberIds.includes(props.currentUserId);
  const sections = groupInfoSections(canEditInfo, canManage);
  const addOptions = excludeMembers(workspaceMembers.options, memberIds);
  const nameChanged = name.trim().length > 0 && name.trim() !== props.groupName;
  const memberCount = members.loading || members.error !== null ? null : members.options.length;
  // Another overlay (photo sheet, confirm) owns Escape while it is up.
  const overlayOpen = photoOptionsOpen || leaving || removeTarget !== null;

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

  const nodes: Record<GroupInfoSection, ReactNode> = {
    hero: (
      <GroupHero
        name={props.groupName}
        photoUrl={photoUrl}
        subtitle={groupInfoSubtitle(memberCount, props.workspaceName)}
        canEdit={canEditInfo}
        busy={busy}
        onPhoto={() => setPhotoOptionsOpen(true)}
      />
    ),
    tabs: null,
    name: (
      <>
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
      </>
    ),
    members: (
      <>
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
      </>
    ),
    leave: <LeaveGroupRow disabled={busy} onClick={() => setLeaving(true)} />,
  };

  return (
    <>
      {createPortal(
        groupInfoTabs({
          tabs: props.tabs,
          open: props.open,
          onClose: props.onClose,
          escape: overlayOpen ? null : props.onClose,
          frame: (tabs) =>
            groupInfoPage({
              onClose: props.onClose,
              error,
              sections,
              nodes: { ...nodes, tabs },
            }),
        }),
        document.body,
      )}

      {canEditInfo ? (
        <PhotoOptionsSheet
          {...groupPhotoSheetProps({
            open: photoOptionsOpen,
            onClose: () => setPhotoOptionsOpen(false),
            hasPhoto: photoUrl !== null,
            upload: (file) => void uploadPhoto(file),
            remove: () => void removePhoto(),
          })}
        />
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
