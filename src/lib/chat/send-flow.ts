// The send orchestration, Postgres first: record the message through
// chat_message_send, and only once the row exists publish it over Agora for
// live delivery. Pure of React and of the SDK (both steps are injected) so the
// contract is unit-tested directly: the record write always precedes the live
// publish, the rendered message carries the RETURNED row's server created_at,
// a live publish failure or a publish slower than LIVE_PUBLISH_TIMEOUT_MS never
// fails the send (the row exists; receivers catch up from Postgres), and a
// record failure or timeout reports 'failed' with its class (send-errors.ts).
//
// createOutboxSender runs those sends in the background, one channel queue at a
// time (FIFO per channel: a later message never records before an earlier
// pending one). A transient failure (network, timeout, 408 / 429 / 5xx, an
// upload error or stall) never shows: the bubble keeps its clock and the
// attempt repeats with backoff (2s, 4s, 8s, 16s, then every 30s, with no end)
// using the SAME message id and a fresh trace id per attempt; kick()
// (reconnect, tab visible, online) retries at once. Only a permanent failure
// (the server refused this message) turns the bubble 'failed' ("Not sent" +
// Retry); the queue then moves on to the next message, and Retry puts the
// refused one back in line.
//
// Instant attachment sends: an entry may carry picked files or a recorded voice
// note (attachment.local) whose asset id is still ''. Each attempt first
// uploads those, in order and one at a time, reporting progress as 'progress'
// events, and stores every returned version id on the entry; only then does it
// record once with all the ids. A voice note is transcribed alongside its
// upload, best-effort (TRANSCRIBE_TIMEOUT_MS, then it sends without one). A
// retry uploads only the files that still have no version id. An entry
// restored while its files are read back (restoring) holds its place without
// running; one whose files are gone (filesMissing) never runs and does not
// hold up the queue.
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
  type AttachmentUploader,
  type ChatAttachmentUpload,
  type MessageAttachment,
} from '@/lib/chat/attachments';
import {
  ALL_MENTION,
  isEveryoneRefusal,
  isMentionRefusal,
  mentionTargets,
  mentionsAfterRefusal,
} from '@/lib/chat/mentions';
import type { Result } from '@srtdio/rpc';
import {
  classifyRecordFailure,
  classifyUploadFailure,
  type SendErrorClass,
} from '@/lib/chat/send-errors';
import { TRANSCRIBE_TIMEOUT_MS, type TranscribeResult } from '@/lib/chat/transcribe';
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
  | {
      ok: false;
      reason: 'timeout' | 'error';
      error: string;
      /** Absent is 'transient' (keep trying). */
      errorClass?: SendErrorClass;
    };

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
  let mentions = mentionTargets(input.text, input.channelType);
  let recorded = await record(mentions);
  // The chat's type was unknown and "all" went out in a DM: drop only "all"
  // and send the people first; a further refusal takes the ladder below.
  if (
    !recorded.ok &&
    input.channelType === undefined &&
    mentions.includes(ALL_MENTION) &&
    isEveryoneRefusal(recorded.message)
  ) {
    mentions = mentions.filter((id) => id !== ALL_MENTION);
    recorded = await record(mentions);
  }
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
    return {
      ok: false,
      reason: recorded.reason,
      error: recorded.message,
      errorClass: classifyRecordFailure(recorded),
    };
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

/** The longest wait between two attempts. */
export const RETRY_CAP_MS = 30_000;
/** Waits between attempts after a transient failure; the last one repeats with no end. */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, RETRY_CAP_MS];

/** The wait before the next attempt after `failures` consecutive failures (>= 1). */
export function retryDelayMs(failures: number): number {
  const index = Math.min(Math.max(failures, 1), RETRY_DELAYS_MS.length) - 1;
  return RETRY_DELAYS_MS[index] ?? RETRY_CAP_MS;
}

/** A chat upload with no progress event for this long is aborted (a transient failure). */
export const UPLOAD_STALL_MS = 30_000;

/** The slice of an XMLHttpRequest the stall watch needs. */
export interface StallWatchable {
  upload: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  abort: () => void;
}

export interface StallWatch {
  /** Stop watching: clears the timer and every listener (idempotent). */
  stop: () => void;
}

/**
 * Abort `request` when it goes UPLOAD_STALL_MS without any sign of life (an
 * upload progress or start event, a response progress or state change). The
 * abort surfaces as the XHR transport failure the upload already maps to a
 * transient error, so the outbox retries and the queue behind it moves on.
 * Stops by itself on loadend; the caller also stops it when the upload settles.
 */
export function watchUploadStall(
  request: StallWatchable,
  opts: {
    stallMs?: number;
    setTimer?: (fn: () => void, delayMs: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  } = {},
): StallWatch {
  const stallMs = opts.stallMs ?? UPLOAD_STALL_MS;
  const setTimer =
    opts.setTimer ?? ((fn: () => void, delayMs: number): unknown => setTimeout(fn, delayMs));
  const clearTimer = opts.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as number));
  let timer: unknown = null;
  let stopped = false;
  const disarm = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const arm = (): void => {
    if (stopped) return;
    disarm();
    timer = setTimer(() => {
      timer = null;
      stop();
      request.abort();
    }, stallMs);
  };
  const UPLOAD_EVENTS = ['loadstart', 'progress', 'load'] as const;
  const REQUEST_EVENTS = ['progress', 'readystatechange'] as const;
  function stop(): void {
    if (stopped) return;
    stopped = true;
    disarm();
    for (const type of UPLOAD_EVENTS) request.upload.removeEventListener(type, arm);
    for (const type of REQUEST_EVENTS) request.removeEventListener(type, arm);
    request.removeEventListener('loadend', stop);
  }
  for (const type of UPLOAD_EVENTS) request.upload.addEventListener(type, arm);
  for (const type of REQUEST_EVENTS) request.addEventListener(type, arm);
  request.addEventListener('loadend', stop);
  arm();
  return { stop };
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
  /** Uploads a file whose attachment carries no uploader (restored after a reload). */
  upload?: AttachmentUploader;
  /** Best-effort voice note transcription; absent sends voice notes without one. */
  transcribe?: (blob: Blob) => Promise<TranscribeResult>;
  /** Override for tests; defaults to TRANSCRIBE_TIMEOUT_MS. */
  transcribeTimeoutMs?: number;
  setTimer?: (fn: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface OutboxSender {
  entries: (channelId: string) => readonly OutboxEntry[];
  enqueue: (channelId: string, entry: OutboxEntry) => void;
  /** Retry on a refused ('failed') entry: back in line, same id. */
  retry: (channelId: string, id: string) => void;
  settle: (channelId: string, id: string) => void;
  dropChannel: (channelId: string) => void;
  /**
   * A restoring entry's files came back from IndexedDB (its attachments, with
   * the files attached) and it resumes; null: they are gone, so it turns
   * filesMissing ('failed', Remove only).
   */
  restoreFiles: (
    channelId: string,
    id: string,
    attachments: readonly MessageAttachment[] | null,
  ) => void;
  /** Attempt every waiting queue now (reconnect, tab visible, online). */
  kick: () => void;
  /** Stop: clear every timer and ignore every answer still in flight. */
  dispose: () => void;
}

/**
 * The entry a channel's queue runs next: the oldest one still pending. A
 * refused ('failed') entry waits on Retry and one whose files are gone waits
 * on Remove; neither holds up the messages behind it.
 */
function headOf(entries: readonly OutboxEntry[]): OutboxEntry | undefined {
  return entries.find((e) => e.filesMissing !== true && e.state === 'sending');
}

/** Copy of `attachments` with one item replaced. */
function replaceAt(
  attachments: readonly MessageAttachment[],
  index: number,
  next: MessageAttachment,
): MessageAttachment[] {
  return attachments.map((a, i) => (i === index ? next : a));
}

/** A recorded voice note that has not been transcribed yet. */
function wantsTranscript(attachment: MessageAttachment): boolean {
  return (
    attachment.durationMs !== undefined &&
    attachment.mime.startsWith('audio/') &&
    attachment.transcript === undefined
  );
}

/** One channel's queue runner. */
interface Lane {
  busy: boolean;
  timer: unknown;
  failures: number;
}

type AttemptFailure = { error: string; errorClass: SendErrorClass };

/**
 * The background sender over an outbox (restored entries resume at once).
 * Nothing here throws; a deliver that rejects counts as a transient failure.
 */
export function createOutboxSender(deps: OutboxSenderDeps, initial: Outbox = {}): OutboxSender {
  const setTimer =
    deps.setTimer ?? ((fn: () => void, delayMs: number): unknown => setTimeout(fn, delayMs));
  const clearTimer = deps.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as number));
  let outbox: Outbox = initial;
  let disposed = false;
  const lanes = new Map<string, Lane>();
  // Voice notes already sent to transcription this session (by local key): a
  // retry after a failed upload never transcribes again.
  const transcribed = new Set<string>();
  // Transcription timeouts still armed, cleared on dispose.
  const transcribeTimers = new Set<unknown>();

  const commit = (next: Outbox): void => {
    if (next === outbox) return;
    outbox = next;
    deps.onChange(outbox);
  };

  const laneFor = (channelId: string): Lane => {
    const existing = lanes.get(channelId);
    if (existing !== undefined) return existing;
    const lane: Lane = { busy: false, timer: null, failures: 0 };
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

  /** The entry as the outbox holds it now; undefined once settled or dropped. */
  const current = (channelId: string, id: string): OutboxEntry | undefined =>
    selectOutbox(outbox, channelId).find((e) => e.id === id);

  const isLive = (channelId: string, lane: Lane): boolean =>
    !disposed && lanes.get(channelId) === lane;

  /** Its files are gone: 'failed' with filesMissing (Remove only); the queue moves on. */
  const markFilesMissing = (channelId: string, id: string): void => {
    const entry = current(channelId, id);
    if (entry === undefined) return;
    const lost: OutboxEntry = { ...entry, state: 'failed', filesMissing: true };
    delete lost.restoring;
    commit(outboxPut(outbox, channelId, lost));
    deps.onEvent({ type: 'state', channelId, id, state: 'failed' });
  };

  /** Transcribe with a timeout; resolves to the transcript or undefined. Never rejects. */
  const transcribeBounded = (file: File): Promise<string | undefined> => {
    const transcribe = deps.transcribe;
    if (transcribe === undefined) return Promise.resolve(undefined);
    return new Promise<string | undefined>((resolve) => {
      let done = false;
      const finish = (value: string | undefined): void => {
        if (done) return;
        done = true;
        clearTimer(timer);
        transcribeTimers.delete(timer);
        resolve(value);
      };
      const timer = setTimer(
        () => finish(undefined),
        deps.transcribeTimeoutMs ?? TRANSCRIBE_TIMEOUT_MS,
      );
      transcribeTimers.add(timer);
      let pending: Promise<TranscribeResult>;
      try {
        pending = transcribe(file);
      } catch {
        finish(undefined);
        return;
      }
      pending.then(
        (result) =>
          finish(result.ok && result.transcript.trim() !== '' ? result.transcript : undefined),
        () => finish(undefined),
      );
    });
  };

  /**
   * Upload the entry's files that have no version id yet, in order (a voice
   * note transcribed alongside). Progress ticks update memory only (no
   * persistence write per tick); each finished upload is committed, so a
   * retry or a reload keeps its version id. Resolves to the entry ready to
   * record, null when it left the outbox (or the sender stopped, or its files
   * are gone) mid-way, or the first failure with its class.
   */
  const uploadPending = async (
    channelId: string,
    lane: Lane,
    id: string,
  ): Promise<{ ok: true; entry: OutboxEntry | null } | ({ ok: false } & AttemptFailure)> => {
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
      if (local.file === null) {
        markFilesMissing(channelId, id);
        return { ok: true, entry: null };
      }
      const file = local.file;
      const upload = local.upload ?? deps.upload;
      if (upload === undefined) {
        return { ok: false, error: 'attachment upload unavailable', errorClass: 'transient' };
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
      const transcript =
        wantsTranscript(target) && !transcribed.has(local.key)
          ? (transcribed.add(local.key), transcribeBounded(file))
          : Promise.resolve(undefined);
      let result: ChatAttachmentUpload;
      try {
        result = await upload(file, (fraction) =>
          publish({ ...target, local: { ...local, progress: fraction } }, false),
        );
      } catch (error) {
        result = { ok: false, message: String(error) };
      }
      const text = await transcript;
      const withTranscript = text !== undefined ? { transcript: text } : {};
      if (!result.ok) {
        // Keep a transcript that did arrive, so the retry does not need one.
        if (text !== undefined) {
          const latest = current(channelId, id)?.local.attachments[index];
          if (latest !== undefined) publish({ ...latest, ...withTranscript }, true);
        }
        return {
          ok: false,
          error: result.message,
          errorClass: classifyUploadFailure(result.message),
        };
      }
      publish(
        {
          ...target,
          ...withTranscript,
          assetId: result.versionId,
          local: { ...local, progress: 1 },
        },
        true,
      );
    }
  };

  const onRecorded = (channelId: string, lane: Lane, message: ThreadMessage): void => {
    lane.busy = false;
    lane.failures = 0;
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
    failure: AttemptFailure,
  ): void => {
    lane.busy = false;
    if (!isLive(channelId, lane)) return;
    deps.onAttemptFailed({
      trace_id: traceId,
      message_id: head.id,
      channel_id: channelId,
      reason,
      error: failure.error,
      error_class: failure.errorClass,
      failures: lane.failures + 1,
    });
    // Settled by a catch-up (or dropped, or refused) while this attempt was in flight.
    if (headOf(selectOutbox(outbox, channelId))?.id !== head.id) {
      lane.failures = 0;
      pump(channelId);
      return;
    }
    if (failure.errorClass === 'permanent') {
      // The server refused this message: "Not sent" + Retry; the rest go on.
      lane.failures = 0;
      setState(channelId, head.id, 'failed');
      pump(channelId);
      return;
    }
    lane.failures += 1;
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
    // A restoring head holds its place until its files are back.
    if (head === undefined || head.restoring === true) return;
    lane.busy = true;
    const traceId = deps.newTraceId();
    let settled = false;
    const recorded = (message: ThreadMessage): void => {
      if (settled) return;
      settled = true;
      onRecorded(channelId, lane, message);
    };
    const failed = (reason: string, failure: AttemptFailure): void => {
      if (settled) return;
      settled = true;
      onFailed(channelId, lane, head, traceId, reason, failure);
    };
    const deliver = (entry: OutboxEntry): void => {
      void deps.deliver(channelId, entry, traceId, recorded).then(
        (outcome) => {
          if (outcome.ok) recorded(outcome.message);
          else {
            failed(outcome.reason, {
              error: outcome.error,
              errorClass: outcome.errorClass ?? 'transient',
            });
          }
        },
        (error: unknown) => failed('error', { error: String(error), errorClass: 'transient' }),
      );
    };
    // A text-only (or fully uploaded) entry records in this same tick.
    if (!head.local.attachments.some(awaitsUpload)) {
      deliver(head);
      return;
    }
    void uploadPending(channelId, lane, head.id).then((uploaded) => {
      if (!uploaded.ok) {
        failed('upload', uploaded);
        return;
      }
      if (uploaded.entry !== null) {
        deliver(uploaded.entry);
        return;
      }
      // Settled, dropped, lost or stopped while uploading: release the lane.
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
      pump(channelId);
    },
    retry: (channelId, id) => {
      if (disposed) return;
      const entry = selectOutbox(outbox, channelId).find((e) => e.id === id);
      if (entry === undefined || entry.state !== 'failed' || entry.filesMissing === true) return;
      setState(channelId, id, 'sending');
      // Back in line at once: a backoff wait for the head restarts now.
      const lane = laneFor(channelId);
      stopTimer(lane);
      lane.failures = 0;
      pump(channelId);
    },
    settle: (channelId, id) => {
      if (disposed) return;
      const wasHead = headOf(selectOutbox(outbox, channelId))?.id === id;
      commit(outboxRemove(outbox, channelId, id));
      const lane = lanes.get(channelId);
      if (!wasHead || lane === undefined) return;
      stopTimer(lane);
      lane.failures = 0;
      pump(channelId);
    },
    dropChannel: (channelId) => {
      const lane = lanes.get(channelId);
      if (lane !== undefined) stopTimer(lane);
      lanes.delete(channelId);
      commit(outboxDropChannel(outbox, channelId));
    },
    restoreFiles: (channelId, id, attachments) => {
      if (disposed) return;
      const entry = current(channelId, id);
      if (entry === undefined || entry.restoring !== true) return;
      if (attachments === null) {
        markFilesMissing(channelId, id);
      } else {
        const back: OutboxEntry = { ...entry, local: { ...entry.local, attachments } };
        delete back.restoring;
        commit(outboxPut(outbox, channelId, back));
        deps.onEvent({ type: 'progress', channelId, id, attachments });
      }
      pump(channelId);
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
      for (const timer of transcribeTimers) clearTimer(timer);
      transcribeTimers.clear();
    },
  };
}
