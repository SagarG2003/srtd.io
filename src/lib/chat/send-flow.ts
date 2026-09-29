// The send orchestration, Postgres first: record the message through
// chat_message_send, and only once the row exists publish it over Agora for
// live delivery. Pure of React and of the SDK (both steps are injected) so the
// contract is unit-tested directly: the record write always precedes the live
// publish, the rendered message carries the RETURNED row's server created_at,
// a live publish failure or a publish slower than LIVE_PUBLISH_TIMEOUT_MS never
// fails the send (the row exists; receivers catch up from Postgres), and a
// record failure or timeout reports 'failed'.
//
// createOutboxSender runs those sends in the background, one channel queue at a
// time (FIFO per channel: a later message never records before an earlier one).
// A failed record retries with backoff (2s, 4s, 8s, 16s, then every 30s) using
// the SAME message id and a fresh trace id per attempt; the bubble stays
// 'sending' and only turns 'failed' once the head has failed continuously for
// FAILED_AFTER_MS. kick() (reconnect, tab visible, online) retries at once.
//
// Instant attachment sends: an entry may carry picked files (attachment.local)
// whose asset id is still ''. Each attempt first uploads those, in order and one
// at a time, reporting progress as 'progress' events, and stores every returned
// version id on the entry; only then does it record once with all the ids. An
// upload failure is a failed attempt (same backoff and FAILED_AFTER_MS), and a
// retry uploads only the files that still have no version id. An entry restored
// with its files lost (filesMissing) never runs and does not hold up the queue.
//
// Mentions ride in the body as @[uuid] tokens; every attempt derives p_mentions
// from the body, so a retry (or a send restored from storage) resends them.
// When the server refuses a mention ('mentioned people must be in this chat')
// the attempt re-reads the chat's members once and records again without the
// ones who left (without any mention when that re-read fails): never a failed
// bubble for it.

import type { SendRecordResult } from '@/lib/chat/record';
import {
  outboxDropChannel,
  outboxPut,
  outboxRemove,
  outboxSetAttachments,
  outboxSetState,
  selectOutbox,
  type Outbox,
  type OutboxEntry,
  type OutboxEvent,
} from '@/lib/chat/chat-store';
import {
  awaitsUpload,
  buildAttachmentMeta,
  type AttachmentMetaMap,
  type ChatAttachmentUpload,
  type MessageAttachment,
} from '@/lib/chat/attachments';
import { isMentionRefusal, mentionTargets, mentionsAfterRefusal } from '@/lib/chat/mentions';
import type { Result } from '@srtdio/rpc';
import {
  rowToThreadMessage,
  type LocalMessageContent,
  type ThreadMessage,
} from '@/lib/chat/thread';

/** The Agora publish is abandoned (the bubble stays sent) after this long. */
export const LIVE_PUBLISH_TIMEOUT_MS = 5_000;

/** What one send carries; a retry passes the same `id` and `pending` again. */
export interface SendInput {
  id: string;
  channelId: string;
  currentUserId: string;
  traceId: string;
  text: string;
  local: LocalMessageContent;
  /** The chat's type; a DM never sends "all" in p_mentions. */
  channelType?: 'dm' | 'group';
}

export interface SendFlowDeps {
  /** chat_message_send; never throws (record.ts contract). */
  recordMessage: (input: {
    id: string;
    channelId: string;
    traceId: string;
    body: string;
    /** The body's mentioned user ids (and "all"), from its tokens; empty when none. */
    mentions: string[];
    attachmentAssetIds: string[];
    sharedPostIds: string[];
    sharedBriefIds: string[];
    replyToMessageId: string | null;
    attachmentMeta: AttachmentMetaMap;
  }) => Promise<SendRecordResult>;
  /**
   * Agora publish for live delivery, or undefined while there is no live
   * connection (the message is still sent: it is in the record).
   */
  publishLive:
    | ((input: {
        id: string;
        channelId: string;
        text: string;
        local: LocalMessageContent;
      }) => Promise<unknown>)
    | undefined;
  /**
   * Re-read who this chat's mentions may name, after the server refused one.
   * Absent (or failed): the retry carries no mentions.
   */
  recheckMentions?: (channelId: string) => Promise<Result<string[]>>;
  /** Live publish problems are reported here, never surfaced to the user. */
  onLiveWarning: (context: Record<string, unknown>) => void;
  /** Called as soon as the row exists, before the live publish settles. */
  onRecorded?: (message: ThreadMessage) => void;
  /** Override for tests; defaults to LIVE_PUBLISH_TIMEOUT_MS. */
  publishTimeoutMs?: number;
}

export type SendOutcome =
  | { ok: true; message: ThreadMessage; livePublished: boolean }
  | { ok: false; reason: 'timeout' | 'error'; error: string };

/** Race the publish against a timer; the timer is always cleared. */
export async function publishWithTimeout(
  publish: Promise<unknown>,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: 'live publish timed out' }), timeoutMs);
  });
  try {
    return await Promise.race([
      publish.then(
        () => ({ ok: true }) as const,
        (error: unknown) => ({ ok: false, error: String(error) }) as const,
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One member re-read for a refused mention; a missing reader or a throw is a failed read. */
export async function recheck(
  read: ((channelId: string) => Promise<Result<string[]>>) | undefined,
  channelId: string,
): Promise<Result<string[]>> {
  const failed: Result<string[]> = {
    ok: false,
    error: { code: 'unknown', message: 'mention re-check unavailable' },
  };
  if (read === undefined) return failed;
  try {
    return await read(channelId);
  } catch {
    return failed;
  }
}

/** Record, then publish. Resolves to the rendered message or a failure. */
export async function runSend(deps: SendFlowDeps, input: SendInput): Promise<SendOutcome> {
  const record = (mentions: string[]): Promise<SendRecordResult> =>
    deps.recordMessage({
      id: input.id,
      channelId: input.channelId,
      traceId: input.traceId,
      body: input.text,
      mentions,
      attachmentAssetIds: input.local.attachments.map((a) => a.assetId),
      sharedPostIds: [...input.local.sharedPostIds],
      sharedBriefIds: [...(input.local.sharedBriefIds ?? [])],
      replyToMessageId: input.local.reply?.id ?? null,
      attachmentMeta: buildAttachmentMeta(input.local.attachments),
    });
  const mentions = mentionTargets(input.text, input.channelType);
  let recorded = await record(mentions);
  if (!recorded.ok && mentions.length > 0 && isMentionRefusal(recorded.message)) {
    const fresh = await recheck(deps.recheckMentions, input.channelId);
    const retry = mentionsAfterRefusal(mentions, fresh);
    recorded = await record(retry);
    // Refused again: the last step sends without mentions, never a failed send.
    if (!recorded.ok && retry.length > 0 && isMentionRefusal(recorded.message)) {
      recorded = await record([]);
    }
  }
  if (!recorded.ok) {
    return { ok: false, reason: recorded.reason, error: recorded.message };
  }
  const message = rowToThreadMessage(recorded.row, input.currentUserId, input.local);
  deps.onRecorded?.(message);

  if (deps.publishLive === undefined) {
    deps.onLiveWarning({ trace_id: input.traceId, message_id: input.id, skipped: 'no connection' });
    return { ok: true, message, livePublished: false };
  }
  let publish: Promise<unknown>;
  try {
    publish = deps.publishLive({
      id: input.id,
      channelId: input.channelId,
      text: input.text,
      local: input.local,
    });
  } catch (error) {
    deps.onLiveWarning({ trace_id: input.traceId, message_id: input.id, error: String(error) });
    return { ok: true, message, livePublished: false };
  }
  const published = await publishWithTimeout(
    publish,
    deps.publishTimeoutMs ?? LIVE_PUBLISH_TIMEOUT_MS,
  );
  if (!published.ok) {
    deps.onLiveWarning({ trace_id: input.traceId, message_id: input.id, error: published.error });
    return { ok: true, message, livePublished: false };
  }
  return { ok: true, message, livePublished: true };
}

/** The longest wait between two record attempts. */
export const RETRY_CAP_MS = 30_000;
/** Waits between record attempts; the last one repeats until FAILED_AFTER_MS. */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, RETRY_CAP_MS];
/** Continuous failure after which the queue stops and the bubble reads "Not sent". */
export const FAILED_AFTER_MS = 120_000;

/** The wait before the next attempt after `failures` consecutive failures (>= 1). */
export function retryDelayMs(failures: number): number {
  const index = Math.min(Math.max(failures, 1), RETRY_DELAYS_MS.length) - 1;
  return RETRY_DELAYS_MS[index] ?? RETRY_CAP_MS;
}

export interface OutboxSenderDeps {
  /**
   * One attempt: record, then publish (runSend). onRecorded fires the moment
   * the row exists, so the queue moves on without waiting for the publish.
   */
  deliver: (
    channelId: string,
    entry: OutboxEntry,
    traceId: string,
    onRecorded: (message: ThreadMessage) => void,
  ) => Promise<SendOutcome>;
  newTraceId: () => string;
  /** Bubble updates for the open thread. */
  onEvent: (event: OutboxEvent) => void;
  /** The whole outbox after every change (persistence). */
  onChange: (outbox: Outbox) => void;
  /** One failed attempt, for the log. */
  onAttemptFailed: (context: Record<string, unknown>) => void;
  now?: () => number;
  setTimer?: (fn: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface OutboxSender {
  entries: (channelId: string) => readonly OutboxEntry[];
  enqueue: (channelId: string, entry: OutboxEntry) => void;
  retry: (channelId: string, id: string) => void;
  settle: (channelId: string, id: string) => void;
  dropChannel: (channelId: string) => void;
  /** Attempt every waiting queue now (reconnect, tab visible, online). */
  kick: () => void;
  /** Stop: clear every timer and ignore every answer still in flight. */
  dispose: () => void;
}

/** The entry a channel's queue runs next: the oldest one that can still be sent. */
function headOf(entries: readonly OutboxEntry[]): OutboxEntry | undefined {
  return entries.find((e) => e.filesMissing !== true);
}

/** Copy of `attachments` with one item replaced. */
function replaceAt(
  attachments: readonly MessageAttachment[],
  index: number,
  next: MessageAttachment,
): MessageAttachment[] {
  return attachments.map((a, i) => (i === index ? next : a));
}

/** One channel's queue runner. */
interface Lane {
  busy: boolean;
  timer: unknown;
  failures: number;
  failingSince: number | null;
}

/**
 * The background sender over an outbox (restored entries resume at once).
 * Nothing here throws; a deliver that rejects counts as a failed attempt.
 */
export function createOutboxSender(deps: OutboxSenderDeps, initial: Outbox = {}): OutboxSender {
  const now = deps.now ?? ((): number => Date.now());
  const setTimer =
    deps.setTimer ?? ((fn: () => void, delayMs: number): unknown => setTimeout(fn, delayMs));
  const clearTimer = deps.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as number));
  let outbox: Outbox = initial;
  let disposed = false;
  const lanes = new Map<string, Lane>();

  const commit = (next: Outbox): void => {
    if (next === outbox) return;
    outbox = next;
    deps.onChange(outbox);
  };

  const laneFor = (channelId: string): Lane => {
    const existing = lanes.get(channelId);
    if (existing !== undefined) return existing;
    const lane: Lane = { busy: false, timer: null, failures: 0, failingSince: null };
    lanes.set(channelId, lane);
    return lane;
  };

  const stopTimer = (lane: Lane): void => {
    if (lane.timer !== null) {
      clearTimer(lane.timer);
      lane.timer = null;
    }
  };

  const setState = (channelId: string, id: string, state: OutboxEntry['state']): void => {
    commit(outboxSetState(outbox, channelId, id, state));
    deps.onEvent({ type: 'state', channelId, id, state });
  };

  /** Failed entries go back to 'sending' with a fresh failure window (lost files stay failed). */
  const resume = (channelId: string): void => {
    const lane = laneFor(channelId);
    lane.failures = 0;
    lane.failingSince = null;
    for (const entry of selectOutbox(outbox, channelId)) {
      if (entry.state === 'failed' && entry.filesMissing !== true) {
        setState(channelId, entry.id, 'sending');
      }
    }
    pump(channelId);
  };

  /** The entry as the outbox holds it now; undefined once settled or dropped. */
  const current = (channelId: string, id: string): OutboxEntry | undefined =>
    selectOutbox(outbox, channelId).find((e) => e.id === id);

  /**
   * Upload the entry's files that have no version id yet, in order. Progress
   * ticks update memory only (no persistence write per tick); each finished
   * upload is committed, so a retry or a reload keeps its version id. Resolves
   * to the entry ready to record, null when it left the outbox (or the sender
   * stopped) mid-way, or the first failure.
   */
  const uploadPending = async (
    channelId: string,
    lane: Lane,
    id: string,
  ): Promise<{ ok: true; entry: OutboxEntry | null } | { ok: false; error: string }> => {
    for (;;) {
      if (!isLive(channelId, lane)) return { ok: true, entry: null };
      const entry = current(channelId, id);
      if (entry === undefined) return { ok: true, entry: null };
      const attachments = entry.local.attachments;
      const index = attachments.findIndex(awaitsUpload);
      if (index === -1) return { ok: true, entry };
      const target = attachments[index];
      const local = target?.local;
      if (target === undefined || local === undefined) return { ok: true, entry };
      if (local.file === null || local.upload === undefined) {
        return { ok: false, error: 'attachment file unavailable' };
      }
      const publish = (next: MessageAttachment, persist: boolean): void => {
        const latest = current(channelId, id);
        if (latest === undefined || !isLive(channelId, lane)) return;
        const list = replaceAt(latest.local.attachments, index, next);
        const updated = outboxSetAttachments(outbox, channelId, id, list);
        if (persist) commit(updated);
        else outbox = updated;
        deps.onEvent({ type: 'progress', channelId, id, attachments: list });
      };
      let result: ChatAttachmentUpload;
      try {
        result = await local.upload(local.file, (fraction) =>
          publish({ ...target, local: { ...local, progress: fraction } }, false),
        );
      } catch (error) {
        return { ok: false, error: String(error) };
      }
      if (!result.ok) return { ok: false, error: result.message };
      publish({ ...target, assetId: result.versionId, local: { ...local, progress: 1 } }, true);
    }
  };

  const isLive = (channelId: string, lane: Lane): boolean =>
    !disposed && lanes.get(channelId) === lane;

  const onRecorded = (channelId: string, lane: Lane, message: ThreadMessage): void => {
    lane.busy = false;
    lane.failures = 0;
    lane.failingSince = null;
    if (!isLive(channelId, lane)) return;
    const held = selectOutbox(outbox, channelId).some((e) => e.id === message.id);
    commit(outboxRemove(outbox, channelId, message.id));
    if (held) deps.onEvent({ type: 'recorded', channelId, message });
    pump(channelId);
  };

  const onFailed = (
    channelId: string,
    lane: Lane,
    head: OutboxEntry,
    traceId: string,
    reason: string,
    error: string,
  ): void => {
    lane.busy = false;
    if (!isLive(channelId, lane)) return;
    deps.onAttemptFailed({
      trace_id: traceId,
      message_id: head.id,
      channel_id: channelId,
      reason,
      error,
      failures: lane.failures + 1,
    });
    // Settled by a catch-up (or dropped) while this attempt was in flight.
    if (headOf(selectOutbox(outbox, channelId))?.id !== head.id) {
      lane.failures = 0;
      lane.failingSince = null;
      pump(channelId);
      return;
    }
    lane.failures += 1;
    const at = now();
    lane.failingSince ??= at;
    if (at - lane.failingSince >= FAILED_AFTER_MS) {
      lane.failures = 0;
      lane.failingSince = null;
      // FIFO: everything queued behind the head stops with it.
      for (const entry of selectOutbox(outbox, channelId)) {
        if (entry.state === 'sending') setState(channelId, entry.id, 'failed');
      }
      return;
    }
    lane.timer = setTimer(() => {
      lane.timer = null;
      pump(channelId);
    }, retryDelayMs(lane.failures));
  };

  function pump(channelId: string): void {
    if (disposed) return;
    const lane = laneFor(channelId);
    if (lane.busy || lane.timer !== null) return;
    const head = headOf(selectOutbox(outbox, channelId));
    if (head === undefined || head.state !== 'sending') return;
    lane.busy = true;
    const traceId = deps.newTraceId();
    let settled = false;
    const recorded = (message: ThreadMessage): void => {
      if (settled) return;
      settled = true;
      onRecorded(channelId, lane, message);
    };
    const failed = (reason: string, error: string): void => {
      if (settled) return;
      settled = true;
      onFailed(channelId, lane, head, traceId, reason, error);
    };
    const deliver = (entry: OutboxEntry): void => {
      void deps.deliver(channelId, entry, traceId, recorded).then(
        (outcome) => {
          if (outcome.ok) recorded(outcome.message);
          else failed(outcome.reason, outcome.error);
        },
        (error: unknown) => failed('error', String(error)),
      );
    };
    // A text-only (or fully uploaded) entry records in this same tick.
    if (!head.local.attachments.some(awaitsUpload)) {
      deliver(head);
      return;
    }
    void uploadPending(channelId, lane, head.id).then((uploaded) => {
      if (!uploaded.ok) {
        failed('upload', uploaded.error);
        return;
      }
      if (uploaded.entry !== null) {
        deliver(uploaded.entry);
        return;
      }
      // Settled, dropped or stopped while uploading: release the lane.
      settled = true;
      lane.busy = false;
      if (isLive(channelId, lane)) pump(channelId);
    });
  }

  for (const channelId of Object.keys(outbox)) pump(channelId);

  return {
    entries: (channelId) => selectOutbox(outbox, channelId),
    enqueue: (channelId, entry) => {
      if (disposed) return;
      commit(outboxPut(outbox, channelId, entry));
      // A new message also resumes a stopped queue, so it never waits behind a
      // failed one it cannot overtake.
      resume(channelId);
    },
    retry: (channelId, id) => {
      if (disposed) return;
      const entry = selectOutbox(outbox, channelId).find((e) => e.id === id);
      if (entry === undefined || entry.state !== 'failed') return;
      resume(channelId);
    },
    settle: (channelId, id) => {
      if (disposed) return;
      const wasHead = headOf(selectOutbox(outbox, channelId))?.id === id;
      commit(outboxRemove(outbox, channelId, id));
      const lane = lanes.get(channelId);
      if (!wasHead || lane === undefined) return;
      stopTimer(lane);
      lane.failures = 0;
      lane.failingSince = null;
      pump(channelId);
    },
    dropChannel: (channelId) => {
      const lane = lanes.get(channelId);
      if (lane !== undefined) stopTimer(lane);
      lanes.delete(channelId);
      commit(outboxDropChannel(outbox, channelId));
    },
    kick: () => {
      if (disposed) return;
      for (const channelId of Object.keys(outbox)) {
        const lane = laneFor(channelId);
        stopTimer(lane);
        pump(channelId);
      }
    },
    dispose: () => {
      disposed = true;
      for (const lane of lanes.values()) stopTimer(lane);
      lanes.clear();
    },
  };
}
