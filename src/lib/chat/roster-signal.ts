// Live roster updates. Chat lists and groups change for other people within
// seconds: after a successful group RPC the actor sends a 'roster' command
// (fire-and-forget, never delaying the RPC result), and a receiver that sees
// one, or a message for a channel it does not know, re-reads its roster under
// RLS. The command payload is only a nudge: names, photos and membership always
// come from the re-read, never from the payload.
//
// Also holds the unsynced-group live path: until the chat-agora-sync Worker
// has created a group's Agora group, live traffic fans out once per member as
// singleChat, from the group's member ids (a small per-scope cache: the loaded
// list, else one read with the 5s timeout).
//
// Framework-free: the connection, the message factory, the reads and the
// clock are injected, so every branch is unit-tested under the node test job.

import type { Result } from '@srtdio/rpc';
import type { ChannelSummary } from '@/lib/chat-reads';
import { READ_TIMEOUT_MS, withReadTimeout } from '@/lib/chat-reads';
import { toAgoraUsername } from '@/lib/chat/agora-identity';
import {
  LIVE_CHANNEL_ID_KEY,
  MAX_FANOUT,
  fanoutTarget,
  sendRouted,
  targetFromSummary,
  type ChannelTarget,
  type LiveSendConnection,
} from '@/lib/chat/thread';
import type { CreateCmdMessage } from '@/lib/chat/typing';
import { TYPING_CHANNEL_KEY } from '@/lib/chat/typing';

/** The `action` a roster command carries. */
export const ROSTER_ACTION = 'roster';

/** What changed; receivers only use it for logging, never for content. */
export type RosterKind = 'created' | 'renamed' | 'photo' | 'members';

const ROSTER_KINDS: readonly RosterKind[] = ['created', 'renamed', 'photo', 'members'];

/** A roster send (and a roster reload) that has not answered by now counts as failed. */
export const ROSTER_TIMEOUT_MS = 5_000;
/** Roster commands arriving this close together share one reload. */
export const ROSTER_DEBOUNCE_MS = 500;
/** A message for an unknown channel waits at most this long for the reload. */
export const UNKNOWN_HOLD_MS = 5_000;

/** The ext of a roster command. */
export function rosterExt(channelId: string, kind: RosterKind): Record<string, unknown> {
  return { [LIVE_CHANNEL_ID_KEY]: channelId, kind };
}

/** A roster command's channel and kind; null for any other command. */
export function parseRosterCmd(msg: {
  action?: string;
  ext?: unknown;
}): { channelId: string; kind: RosterKind } | null {
  if (msg.action !== ROSTER_ACTION) return null;
  const ext = msg.ext;
  if (typeof ext !== 'object' || ext === null) return null;
  const record = ext as Record<string, unknown>;
  const channelId = record[LIVE_CHANNEL_ID_KEY];
  const kind = record.kind;
  if (typeof channelId !== 'string' || channelId === '') return null;
  if (typeof kind !== 'string' || !(ROSTER_KINDS as readonly string[]).includes(kind)) return null;
  return { channelId, kind: kind as RosterKind };
}

/**
 * The Sorted channel id a live command names on its ext (roster, read, typing),
 * or null when it names none (reaction, edit, delete, mark carry message ids).
 */
export function cmdChannelId(ext: unknown): string | null {
  if (typeof ext !== 'object' || ext === null) return null;
  const record = ext as Record<string, unknown>;
  for (const key of [LIVE_CHANNEL_ID_KEY, 'channel_id', TYPING_CHANNEL_KEY]) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** Group member ids for the unsynced-group fan-out, per workspace and user. */
export interface GroupMemberCache {
  /** The loaded ids for a group, or undefined when not loaded. */
  peek: (groupId: string) => readonly string[] | undefined;
  /** Store a group's ids (the open group's member read). */
  set: (groupId: string, ids: readonly string[]) => void;
  /** The loaded ids, else one read (5s timeout, shared by concurrent callers); null on failure. */
  get: (groupId: string) => Promise<readonly string[] | null>;
  /** Forget every group (roster reload, workspace switch, sign-out). */
  clear: () => void;
}

export function createGroupMemberCache(
  read: (groupId: string, signal: AbortSignal) => Promise<Result<string[]>>,
  timeoutMs: number = READ_TIMEOUT_MS,
): GroupMemberCache {
  let loaded = new Map<string, readonly string[]>();
  let pending = new Map<string, Promise<readonly string[] | null>>();
  return {
    peek: (groupId) => loaded.get(groupId),
    set: (groupId, ids) => {
      loaded.set(groupId, [...ids]);
    },
    get: (groupId) => {
      const known = loaded.get(groupId);
      if (known !== undefined) return Promise.resolve(known);
      const inFlight = pending.get(groupId);
      if (inFlight !== undefined) return inFlight;
      const into = loaded;
      const flights = pending;
      const run = withReadTimeout((signal) => read(groupId, signal), timeoutMs).then((result) => {
        flights.delete(groupId);
        if (!result.ok) return null;
        into.set(groupId, result.data);
        return result.data;
      });
      flights.set(groupId, run);
      return run;
    },
    clear: () => {
      loaded = new Map();
      pending = new Map();
    },
  };
}

/**
 * A channel's live target: the synced group or the DM peer, or, for a group
 * not synced yet, the per-member fan-out from its member ids (loaded, else one
 * read). Null when there is none (read failed or timed out, more than
 * MAX_FANOUT recipients, bad row): the live publish is skipped and receivers
 * catch up from Postgres.
 */
export async function resolveLiveTarget(
  summary: ChannelSummary,
  currentUserId: string,
  members: Pick<GroupMemberCache, 'get'>,
): Promise<ChannelTarget | null> {
  try {
    const direct = targetFromSummary(summary);
    if (direct !== null) return direct;
  } catch {
    return null;
  }
  if (summary.channelType !== 'group' || summary.groupId === null) return null;
  const ids = await members.get(summary.groupId);
  if (ids === null) return null;
  return fanoutTarget(summary.channelId, ids, currentUserId);
}

/** A group change the actor tells others about after its RPC succeeded. */
export type RosterChange =
  | { kind: 'created'; memberUserIds: readonly string[] }
  | { kind: 'renamed' }
  | { kind: 'photo' }
  | { kind: 'members'; added?: readonly string[]; removed?: readonly string[] };

/**
 * Who a roster command goes to. created: each member (not self) as
 * singleChat. renamed / photo: the group (its live target). members: each
 * added or removed user (not self) as singleChat, plus the group; a fan-out
 * group target skips anyone already reached directly. A direct list above
 * MAX_FANOUT is skipped. Pure.
 */
export function rosterSignalTargets(
  change: RosterChange,
  groupTarget: ChannelTarget | null,
  currentUserId: string,
): ChannelTarget[] {
  const direct = (ids: readonly string[]): ChannelTarget[] => {
    const people = [...new Set(ids)].filter((id) => id !== currentUserId);
    if (people.length > MAX_FANOUT) return [];
    return people.map((id) => ({ targetId: toAgoraUsername(id), chatType: 'singleChat' }));
  };
  if (change.kind === 'created') return direct(change.memberUserIds);
  if (change.kind === 'renamed' || change.kind === 'photo') {
    return groupTarget !== null ? [groupTarget] : [];
  }
  const singles = direct([...(change.added ?? []), ...(change.removed ?? [])]);
  if (groupTarget === null) return singles;
  if (groupTarget.fanout === undefined) return [...singles, groupTarget];
  const reached = new Set(singles.map((t) => t.targetId));
  const rest = groupTarget.fanout.filter((to) => !reached.has(to));
  return rest.length > 0 ? [...singles, { ...groupTarget, fanout: rest }] : singles;
}

/**
 * Send one roster command to each target, each bounded by the timeout. Never
 * throws and never rejects: a failure or a timeout is only reported.
 */
export async function sendRosterSignal(params: {
  connection: LiveSendConnection;
  createCmd: CreateCmdMessage;
  targets: readonly ChannelTarget[];
  channelId: string;
  kind: RosterKind;
  onError: (context: Record<string, unknown>) => void;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? ROSTER_TIMEOUT_MS;
  const ext = rosterExt(params.channelId, params.kind);
  await Promise.all(
    params.targets.map(async (target) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() =>
            sendRouted(params.connection, target, (to, chatType) =>
              params.createCmd({ chatType, type: 'cmd', to, action: ROSTER_ACTION, ext }),
            ),
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('roster signal timed out')), timeoutMs);
          }),
        ]);
      } catch (error) {
        params.onError({ channel_id: params.channelId, kind: params.kind, error: String(error) });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }),
  );
}

/**
 * An action's success callback that also fires the roster command: `onDone`
 * runs first and as before; the command is started and never awaited, and
 * nothing it does (a throw, a rejection) reaches the caller or the RPC result.
 */
export function withRosterSignal(
  onDone: () => void,
  signal: () => Promise<void>,
  onError: (context: Record<string, unknown>) => void,
): () => void {
  return () => {
    onDone();
    try {
      void signal().catch((error: unknown) => onError({ error: String(error) }));
    } catch (error) {
      onError({ error: String(error) });
    }
  };
}

/** One debounced, single-flight roster reload plus the messages held for it. */
export interface RosterReloader {
  /** Ask for a reload (debounced; at most one in flight, a request during it runs once after). */
  request: () => void;
  /**
   * Hold work for a channel not in the roster: `process` runs once a reload
   * that started after this call has finished (it re-checks the roster itself).
   * Dropped (`onDrop`) when that has not happened within the hold time, or on dispose.
   */
  hold: (process: () => void, onDrop?: () => void) => void;
  /** Clear every timer and held message; an answer still in flight is ignored. */
  dispose: () => void;
}

export function createRosterReloader(params: {
  /** Re-read the roster under RLS and apply it; true when applied. Failure keeps the current roster. */
  reload: () => Promise<boolean>;
  debounceMs?: number;
  timeoutMs?: number;
  holdMs?: number;
  onError?: (context: Record<string, unknown>) => void;
}): RosterReloader {
  const debounceMs = params.debounceMs ?? ROSTER_DEBOUNCE_MS;
  const timeoutMs = params.timeoutMs ?? ROSTER_TIMEOUT_MS;
  const holdMs = params.holdMs ?? UNKNOWN_HOLD_MS;
  let disposed = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let again = false;
  let started = 0;
  // The in-flight reload's timeout; dispose clears it and settles the race.
  let stopWaiting: (() => void) | undefined;
  const holds = new Set<{
    after: number;
    process: () => void;
    onDrop: (() => void) | undefined;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const run = async (): Promise<void> => {
    if (disposed) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    started += 1;
    const runId = started;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ok = await Promise.race([
        Promise.resolve()
          .then(params.reload)
          .catch(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
          stopWaiting = () => {
            if (timer !== undefined) clearTimeout(timer);
            resolve(false);
          };
        }),
      ]);
      if (!ok) params.onError?.({ error: 'roster reload failed or timed out' });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      stopWaiting = undefined;
      inFlight = false;
    }
    if (disposed) return;
    for (const held of [...holds]) {
      if (held.after >= runId) continue;
      holds.delete(held);
      clearTimeout(held.timer);
      held.process();
    }
    if (again) {
      again = false;
      request();
    }
  };

  const request = (): void => {
    if (disposed) return;
    if (debounce !== undefined) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      void run();
    }, debounceMs);
  };

  return {
    request,
    hold: (process, onDrop) => {
      if (disposed) {
        onDrop?.();
        return;
      }
      const held = {
        after: started,
        process,
        onDrop,
        timer: setTimeout(() => {
          holds.delete(held);
          onDrop?.();
        }, holdMs),
      };
      holds.add(held);
    },
    dispose: () => {
      disposed = true;
      stopWaiting?.();
      if (debounce !== undefined) clearTimeout(debounce);
      debounce = undefined;
      const dropped = [...holds];
      holds.clear();
      for (const held of dropped) {
        clearTimeout(held.timer);
        held.onDrop?.();
      }
    },
  };
}

/** What the open chat does after a roster reload. */
export type OpenChannelStep =
  | { kind: 'keep' }
  | { kind: 'update'; channel: ChannelSummary }
  | { kind: 'close' };

/** Whether a roster row changed anything the open chat shows or routes by. Pure. */
export function summaryChanged(a: ChannelSummary, b: ChannelSummary): boolean {
  return (
    a.title !== b.title ||
    a.avatarUrl !== b.avatarUrl ||
    a.agoraGroupId !== b.agoraGroupId ||
    a.peerUserId !== b.peerUserId ||
    (a.role ?? null) !== (b.role ?? null) ||
    (a.createdBy ?? null) !== (b.createdBy ?? null)
  );
}

/**
 * The open chat against a roster: its row changed (name, photo, sync) =
 * update in place; gone after a reload (removed, left elsewhere) = close;
 * otherwise keep the same object so nothing re-renders. Pure.
 */
export function openChannelAfterRoster(
  open: ChannelSummary | null,
  roster: readonly ChannelSummary[],
  reloaded: boolean,
): OpenChannelStep {
  if (open === null) return { kind: 'keep' };
  const found = roster.find((c) => c.channelId === open.channelId);
  if (found === undefined) return reloaded ? { kind: 'close' } : { kind: 'keep' };
  return summaryChanged(open, found) ? { kind: 'update', channel: found } : { kind: 'keep' };
}
