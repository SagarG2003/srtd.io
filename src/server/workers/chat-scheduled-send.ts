/// <reference types="@cloudflare/workers-types" />
// Cloudflare Worker: chat-scheduled-send. Every minute it sends the scheduled
// chat messages that are due, following the chat-agora-sync precedent: a bare
// service-role supabase-js client (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY,
// no member JWT), stateless, uuid_v7 trace ids on every log line.
//
// One run:
//   1. chat_scheduled_due(p_limit) -> the due scheduled ids (oldest first).
//   2. For each id, one at a time: chat_scheduled_dispatch(p_id, p_trace_id)
//      with a per-item trace id. It locks the row (FOR UPDATE SKIP LOCKED),
//      records the message as the sender via chat_message_send and returns the
//      chat_messages row, or no row when the item was already handled or failed
//      inside the database (the proc marks it failed and writes the sender's
//      'Not sent' inbox entry itself). Two overlapping runs cannot double-send.
//   3. Publish each returned row live over Agora Chat REST as the original
//      sender, with the same ext a live client send carries (buildLiveTextExt,
//      shared with src/lib/chat/thread.ts), so people in the chat see it arrive
//      like any live message. Channel routes are read in one IN query per
//      publish chunk and cached for the run.
//
// Failure isolation: a dispatch or publish failure is logged with its trace id
// and the run moves on; a publish is never retried and the dispatch is never
// repeated (receivers get the message from Postgres on catch-up). No new item
// is picked after RUN_BUDGET_MS and no publish starts after PUBLISH_DEADLINE_MS,
// so with the 5 s REST timeout a run ends inside the cron interval.
// Message bodies are never logged.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import { v7 as uuidv7 } from 'uuid';
import { logger } from '@/server/logger';
import { TRACE_ID_HEADER } from '@/server/trace';
import { parseAttachmentMeta, type ReplyQuote } from '@/lib/chat/attachments';
import { LIVE_WORKSPACE_KEY, buildLiveTextExt } from '@/lib/chat/thread';
import { toAgoraUsername } from './agora-identity';
import {
  AgoraRestError,
  createAgoraMessageApi,
  serializeError,
  type AgoraMessageApi,
  type AgoraMessageChatType,
} from './chat-agora-rest';

interface ChatScheduledSendEnv {
  SUPABASE_URL: string;
  /** Service role: bare client, no minted member JWT. Due + dispatch rpcs, channel reads. */
  SUPABASE_SERVICE_ROLE_KEY: string;
  AGORA_APP_ID: string;
  AGORA_APP_CERTIFICATE: string;
  AGORA_CHAT_APP_KEY: string;
  /** Base host + org + app for the Agora Chat REST API, no trailing slash. */
  AGORA_CHAT_REST_URL: string;
}

/** Due ids read per run; a larger backlog drains across runs. */
export const DUE_LIMIT = 100;

/** No new item is dispatched once a run has been going this long. */
export const RUN_BUDGET_MS = 45_000;

/**
 * Dispatched rows still unpublished at this point of a run are left to
 * catch-up, so with the REST timeout the run ends inside the cron interval.
 */
export const PUBLISH_DEADLINE_MS = 55_000;

/** Dispatched rows are published (one channel read) in chunks of this size. */
export const PUBLISH_CHUNK_SIZE = 10;

/** Error strings in logs are a short operator hint, not a full dump. */
const MAX_ERROR_CHARS = 500;

/** One chat_messages row as chat_scheduled_dispatch returns it. */
export type DispatchedRow =
  Database['public']['Functions']['chat_scheduled_dispatch']['Returns'][number];

/** The chat_channels fields a publish routes on. */
export interface ChannelRoute {
  channelId: string;
  channelType: string;
  agoraGroupId: string | null;
  dmUserA: string | null;
  dmUserB: string | null;
}

/** The DB calls a run makes; injected for tests. */
export interface ScheduledReader {
  /** chat_scheduled_due: due scheduled ids, oldest first. */
  listDue(limit: number, traceId: string): Promise<string[]>;
  /** chat_scheduled_dispatch: the recorded row, or null when nothing was sent. */
  dispatch(id: string, traceId: string): Promise<DispatchedRow | null>;
  /** channel_id -> route for the given channels, in one query. */
  getChannels(channelIds: string[], traceId: string): Promise<Map<string, ChannelRoute>>;
}

export interface ScheduledSendDeps {
  reader: ScheduledReader;
  agora: AgoraMessageApi;
  /** Fresh uuid_v7 trace id. */
  newTraceId(): string;
  /** Epoch ms; the run budget is measured with it. */
  now(): number;
  log: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

/** What one run did; logged once at the end and returned for tests. */
export interface RunSummary {
  due: number;
  sent: number;
  /** Dispatch returned no row (already handled, or failed inside the database). */
  not_sent: number;
  dispatch_errors: number;
  published: number;
  publish_failures: number;
  skipped_groups: number;
  /** Due ids left for the next run because the budget ran out. */
  deferred: number;
}

/** A live publish target resolved from a channel route. */
export type PublishTarget =
  | { ok: true; to: string; chatType: AgoraMessageChatType }
  | { ok: false; reason: 'group_not_synced' | 'no_peer' | 'unknown_channel_type' };

/**
 * Where a row is delivered on the Agora side, mirroring the client's
 * targetFromSummary: a group messages its synced Agora group; a DM messages
 * the other participant's Agora username. Pure.
 */
export function publishTarget(route: ChannelRoute, senderUserId: string): PublishTarget {
  if (route.channelType === 'group') {
    return route.agoraGroupId !== null && route.agoraGroupId !== ''
      ? { ok: true, to: route.agoraGroupId, chatType: 'groupChat' }
      : { ok: false, reason: 'group_not_synced' };
  }
  if (route.channelType === 'dm') {
    const sender = senderUserId.toLowerCase();
    const peer = route.dmUserA?.toLowerCase() === sender ? route.dmUserB : route.dmUserA;
    return peer !== null && peer !== undefined && peer.toLowerCase() !== sender
      ? { ok: true, to: toAgoraUsername(peer), chatType: 'singleChat' }
      : { ok: false, reason: 'no_peer' };
  }
  return { ok: false, reason: 'unknown_channel_type' };
}

/**
 * The live ext for a recorded row: what the client's sendText builds for the
 * same content (buildLiveTextExt) plus the workspace stamp sendRouted adds.
 * The row keeps only the quoted id, so the reply quote is unresolved (empty
 * preview, unknown author), exactly as rowToThreadMessage reads it; receivers
 * hydrate it from Postgres. The thread root is the row's recorded one. Pure.
 */
export function scheduledLiveExt(row: DispatchedRow): Record<string, unknown> {
  const reply: ReplyQuote | null =
    row.reply_to_message_id !== null && row.reply_to_message_id !== ''
      ? {
          id: row.reply_to_message_id,
          authorUserId: null,
          preview: '',
          ...(row.thread_root_message_id !== null && row.thread_root_message_id !== ''
            ? { rootId: row.thread_root_message_id }
            : {}),
        }
      : null;
  const ext = buildLiveTextExt({
    attachments: parseAttachmentMeta(row.attachment_meta, row.attachment_asset_ids ?? []),
    sharedPostIds: row.shared_post_ids ?? [],
    reply,
    liveIds: { sorted_message_id: row.id, sorted_channel_id: row.channel_id },
  });
  return { ...(ext ?? {}), [LIVE_WORKSPACE_KEY]: row.workspace_id };
}

/** Log fields for a failure; an Agora REST fault keeps operation/status/body apart. */
function failureFields(error: unknown): {
  operation: string | null;
  status: number | null;
  body: string | null;
  error: string;
} {
  const base = { error: serializeError(error).slice(0, MAX_ERROR_CHARS) };
  if (error instanceof AgoraRestError) {
    return { operation: error.operation, status: error.status, body: error.body, ...base };
  }
  return { operation: null, status: null, body: null, ...base };
}

interface Dispatched {
  row: DispatchedRow;
  traceId: string;
}

/**
 * Publish a chunk of dispatched rows: one channel read for the routes not yet
 * cached this run, then one REST send per row, in dispatch order. Never throws.
 */
async function publishChunk(
  chunk: readonly Dispatched[],
  routes: Map<string, ChannelRoute | null>,
  deps: ScheduledSendDeps,
  runTraceId: string,
  started: number,
  summary: RunSummary,
): Promise<void> {
  if (chunk.length === 0) return;
  const missing = [...new Set(chunk.map((d) => d.row.channel_id))].filter((id) => !routes.has(id));
  let lookupFailed = false;
  if (missing.length > 0) {
    try {
      const found = await deps.reader.getChannels(missing, runTraceId);
      for (const id of missing) routes.set(id, found.get(id) ?? null);
    } catch (error) {
      lookupFailed = true;
      deps.log.error('chat_scheduled_send channel read failed', {
        trace_id: runTraceId,
        channels: missing.length,
        ...failureFields(error),
      });
    }
  }

  for (const { row, traceId } of chunk) {
    const fields = { trace_id: traceId, message_id: row.id, channel_id: row.channel_id };
    if (deps.now() - started >= PUBLISH_DEADLINE_MS) {
      summary.publish_failures += 1;
      deps.log.warn('chat_scheduled_send publish skipped', { ...fields, reason: 'run_deadline' });
      continue;
    }
    const route = routes.get(row.channel_id);
    if (route === undefined || route === null || row.sender_user_id === null) {
      summary.publish_failures += 1;
      deps.log.error('chat_scheduled_send publish skipped', {
        ...fields,
        reason: lookupFailed
          ? 'channel_read_failed'
          : row.sender_user_id === null
            ? 'no_sender'
            : 'channel_not_found',
      });
      continue;
    }
    const target = publishTarget(route, row.sender_user_id);
    if (!target.ok) {
      if (target.reason === 'group_not_synced') {
        summary.skipped_groups += 1;
        deps.log.info('chat_scheduled_send publish skipped (group not synced)', fields);
      } else {
        summary.publish_failures += 1;
        deps.log.error('chat_scheduled_send publish skipped', { ...fields, reason: target.reason });
      }
      continue;
    }
    try {
      await deps.agora.sendMessage(
        {
          from: toAgoraUsername(row.sender_user_id),
          to: target.to,
          chatType: target.chatType,
          msg: row.body ?? '',
          ext: scheduledLiveExt(row),
        },
        traceId,
      );
      summary.published += 1;
    } catch (error) {
      summary.publish_failures += 1;
      deps.log.error('chat_scheduled_send publish failed', { ...fields, ...failureFields(error) });
    }
  }
}

/**
 * One scheduled run: read the due ids, dispatch them one at a time (each with
 * its own trace id) until the list or the budget runs out, and publish every
 * returned row live. One item failing never stops the batch; never throws.
 */
export async function runScheduledSend(deps: ScheduledSendDeps): Promise<RunSummary> {
  const runTraceId = deps.newTraceId();
  const started = deps.now();
  const summary: RunSummary = {
    due: 0,
    sent: 0,
    not_sent: 0,
    dispatch_errors: 0,
    published: 0,
    publish_failures: 0,
    skipped_groups: 0,
    deferred: 0,
  };

  let ids: string[];
  try {
    ids = await deps.reader.listDue(DUE_LIMIT, runTraceId);
  } catch (error) {
    deps.log.error('chat_scheduled_send due read failed', {
      trace_id: runTraceId,
      ...failureFields(error),
    });
    return summary;
  }
  summary.due = ids.length;

  const routes = new Map<string, ChannelRoute | null>();
  let chunk: Dispatched[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    if (deps.now() - started >= RUN_BUDGET_MS) {
      summary.deferred = ids.length - i;
      deps.log.warn('chat_scheduled_send budget reached', {
        trace_id: runTraceId,
        deferred: summary.deferred,
      });
      break;
    }
    const id = ids[i] as string;
    const traceId = deps.newTraceId();
    let row: DispatchedRow | null;
    try {
      row = await deps.reader.dispatch(id, traceId);
    } catch (error) {
      summary.dispatch_errors += 1;
      deps.log.error('chat_scheduled_send dispatch failed', {
        trace_id: traceId,
        run_trace_id: runTraceId,
        scheduled_id: id,
        ...failureFields(error),
      });
      continue;
    }
    if (row === null) {
      summary.not_sent += 1;
      deps.log.info('chat_scheduled_send dispatch returned no row', {
        trace_id: traceId,
        run_trace_id: runTraceId,
        scheduled_id: id,
      });
      continue;
    }
    summary.sent += 1;
    chunk.push({ row, traceId });
    if (chunk.length >= PUBLISH_CHUNK_SIZE) {
      await publishChunk(chunk, routes, deps, runTraceId, started, summary);
      chunk = [];
    }
  }
  await publishChunk(chunk, routes, deps, runTraceId, started, summary);

  deps.log.info('chat_scheduled_send run complete', {
    trace_id: runTraceId,
    ...summary,
    duration_ms: deps.now() - started,
  });
  return summary;
}

/** Bare service-role client (no acting member), per the chat-agora-sync precedent. */
function createServiceClient(env: ChatScheduledSendEnv): SupabaseClient<Database> {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** The live ScheduledReader; every request carries X-Trace-Id. */
function createScheduledReader(client: SupabaseClient<Database>): ScheduledReader {
  return {
    async listDue(limit, traceId) {
      const args = { p_limit: limit };
      const { data, error } = await client
        .rpc('chat_scheduled_due', args)
        .setHeader(TRACE_ID_HEADER, traceId);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    async dispatch(id, traceId) {
      const args = { p_id: id, p_trace_id: traceId };
      const { data, error } = await client
        .rpc('chat_scheduled_dispatch', args)
        .setHeader(TRACE_ID_HEADER, traceId);
      if (error) throw new Error(error.message);
      return data?.[0] ?? null;
    },
    async getChannels(channelIds, traceId) {
      const byId = new Map<string, ChannelRoute>();
      if (channelIds.length === 0) return byId;
      const { data, error } = await client
        .from('chat_channels')
        .select('channel_id, channel_type, agora_group_id, dm_user_a, dm_user_b')
        .in('channel_id', channelIds)
        .setHeader(TRACE_ID_HEADER, traceId);
      if (error) throw new Error(error.message);
      for (const row of data ?? []) {
        byId.set(row.channel_id, {
          channelId: row.channel_id,
          channelType: row.channel_type,
          agoraGroupId: row.agora_group_id,
          dmUserA: row.dm_user_a,
          dmUserB: row.dm_user_b,
        });
      }
      return byId;
    },
  };
}

function buildDeps(env: ChatScheduledSendEnv): ScheduledSendDeps {
  return {
    reader: createScheduledReader(createServiceClient(env)),
    agora: createAgoraMessageApi({
      appId: env.AGORA_APP_ID,
      appCertificate: env.AGORA_APP_CERTIFICATE,
      restUrl: env.AGORA_CHAT_REST_URL,
    }),
    newTraceId: uuidv7,
    now: Date.now,
    log: logger,
  };
}

export default {
  async fetch(): Promise<Response> {
    return new Response('chat-scheduled-send', { status: 200 });
  },

  // Cron entrypoint (see workers/chat-scheduled-send/wrangler.toml [triggers]):
  // every minute, send the due scheduled messages. waitUntil keeps the run
  // alive past return.
  scheduled(
    _controller: ScheduledController,
    env: ChatScheduledSendEnv,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(runScheduledSend(buildDeps(env)).then(() => undefined));
  },
};
