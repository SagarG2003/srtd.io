// Installs the harness network: a fake signed-in Supabase session in
// localStorage, the fixture PostgREST for https://harness.supabase.test, the
// chat-token and asset-read .test hosts, and a hard block on every other
// non-localhost request. Nothing leaves the machine.

import { deflateSync } from 'node:zlib';
import type { Page, Route } from '@playwright/test';
import { answerRest, type Row, type Tables } from './postgrest';
import {
  buildWorld,
  ME,
  REFUSED_SEND,
  threadRootOf,
  WORKSPACE_ID,
  type ChatWorld,
} from './chat-data';
import { notesChannelRow } from './notes-data';

const SUPABASE_HOST = 'harness.supabase.test';
const CHAT_TOKEN_HOST = 'chat-token.harness.test';
const ASSET_READ_HOST = 'asset-read.harness.test';
const ASSET_UPLOAD_HOST = 'asset-upload.harness.test';

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function fakeSession(): string {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const user = {
    id: ME,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'sam@harness.test',
    app_metadata: { provider: 'email' },
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  };
  const accessToken = [
    base64url({ alg: 'HS256', typ: 'JWT' }),
    base64url({ sub: ME, exp, role: 'authenticated', aud: 'authenticated', email: user.email }),
    'harness',
  ].join('.');
  return JSON.stringify({
    access_token: accessToken,
    refresh_token: 'harness-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: exp,
    user,
  });
}

// CRC32 for the PNG chunks below.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A solid-colour PNG so photo tiles have real pixels without any network. */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rowBytes = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    rowBytes[1 + x * 3] = rgb[0];
    rowBytes[2 + x * 3] = rgb[1];
    rowBytes[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => rowBytes));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function silentWav(): Buffer {
  const samples = 8000;
  const buffer = Buffer.alloc(44 + samples);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write('WAVEfmt ', 8, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(8000, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples, 40);
  buffer.fill(128, 44);
  return buffer;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, HEAD, OPTIONS',
  'access-control-expose-headers': 'content-range',
};

type RpcHandler = (args: Record<string, unknown>, tables: Tables) => unknown;

const RPC: Record<string, RpcHandler> = {
  user_dashboard_tour_state: () => true,
  chat_unread_counts: (_args, tables) => {
    const cursors = tables.chat_read_cursors ?? [];
    const channels = tables.chat_channels ?? [];
    return channels.map((channel) => {
      const mine = cursors.find((c) => c.channel_id === channel.channel_id && c.user_id === ME);
      const after = String(mine?.last_read_at ?? '');
      const unread = (tables.chat_messages ?? []).filter(
        (m) =>
          m.channel_id === channel.channel_id &&
          m.sender_user_id !== ME &&
          String(m.created_at) > after,
      ).length;
      return { channel_id: channel.channel_id, unread_count: unread };
    });
  },
  chat_read_cursor_set: () => null,
  inbox_mark_read: () => null,
  // Bell read state: snooze one entry, or mark every unread entry of the types read.
  inbox_snooze: (args, tables) => {
    const row = (tables.inbox_entries ?? []).find((r) => r.id === args.p_entry_id);
    if (row !== undefined) row.snoozed_until = new Date(Date.now() + 3_600_000).toISOString();
    return null;
  },
  inbox_mark_read_events: (args, tables) => {
    const types = Array.isArray(args.p_event_types) ? args.p_event_types.map(String) : [];
    for (const row of tables.inbox_entries ?? []) {
      if (row.read_at === null && types.includes(String(row.event_type))) {
        row.read_at = new Date().toISOString();
      }
    }
    return null;
  },
  // Reminders: an id already held is a no-op; a new one replaces the pending
  // reminder on the same message (the proc's Change time rule).
  chat_reminder_set: (args, tables) => {
    const rows = (tables.chat_message_reminders ??= []);
    if (rows.some((r) => r.id === args.p_id)) return null;
    const now = new Date().toISOString();
    for (const r of rows) {
      if (r.message_id === args.p_message_id && r.fired_at === null && r.cancelled_at === null) {
        r.cancelled_at = now;
      }
    }
    rows.push({
      id: args.p_id,
      user_id: ME,
      message_id: args.p_message_id,
      channel_id: args.p_channel_id,
      workspace_id: WORKSPACE_ID,
      remind_at: args.p_remind_at,
      fired_at: null,
      cancelled_at: null,
      created_at: now,
    });
    return null;
  },
  chat_reminder_cancel: (args, tables) => {
    const row = (tables.chat_message_reminders ?? []).find((r) => r.id === args.p_id);
    if (row !== undefined && row.fired_at === null) row.cancelled_at = new Date().toISOString();
    return null;
  },
  session_register: () => null,
  // Personal notes: the deterministic channel, created once (idempotent).
  notes_channel_ensure: (args, tables) => {
    const channels = (tables.chat_channels ??= []);
    const id = `notes__${String(args.p_workspace_id)}__${ME}`;
    if (!channels.some((c) => c.channel_id === id))
      channels.push({ ...notesChannelRow(), channel_id: id });
    return id;
  },
  // Message search: each word a prefix match, newest first, keyset paging,
  // deleted rows left out, the limit clamped 1..50, a query outside 2..100 empty.
  chat_message_search: (args, tables) => {
    // A filter chip (p_kind): the newest matches of that kind, the query
    // (when 2+ characters) narrowing them, like the 8-arg proc.
    if (typeof args.p_kind === 'string') return kindSearch(args, tables);
    const query = String(args.p_query ?? '').trim();
    if (query.length < 2 || query.length > 100) return [];
    const words = query.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
    const limit = Math.min(50, Math.max(1, Number(args.p_limit ?? 30)));
    const beforeAt = typeof args.p_before_created_at === 'string' ? args.p_before_created_at : null;
    const beforeId = typeof args.p_before_id === 'string' ? args.p_before_id : null;
    return (tables.chat_messages ?? [])
      .filter((m) => m.deleted_at === null && typeof m.body === 'string')
      .filter((m) => args.p_channel_id == null || m.channel_id === args.p_channel_id)
      .filter((m) => {
        const tokens =
          String(m.body)
            .toLowerCase()
            .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
        return words.every((w) => tokens.some((t) => t.startsWith(w)));
      })
      .sort(
        (a, b) =>
          String(b.created_at).localeCompare(String(a.created_at)) ||
          String(b.id).localeCompare(String(a.id)),
      )
      .filter((m) => {
        if (beforeAt === null || beforeId === null) return true;
        const at = String(m.created_at);
        return at < beforeAt || (at === beforeAt && String(m.id) < beforeId);
      })
      .slice(0, limit);
  },
  // Live replies per thread root (deleted ones left out), the first 200 ids only.
  chat_thread_reply_counts: (args, tables) => {
    const ids = Array.isArray(args.p_root_ids) ? args.p_root_ids.slice(0, 200).map(String) : [];
    const replies = (tables.chat_messages ?? []).filter(
      (m) =>
        m.channel_id === args.p_channel_id &&
        m.deleted_at === null &&
        ids.includes(String(m.thread_root_message_id)),
    );
    return ids
      .map((root) => {
        const own = replies.filter((m) => m.thread_root_message_id === root);
        const last = own
          .map((m) => String(m.created_at))
          .sort()
          .pop();
        return { root_id: root, reply_count: own.length, last_reply_at: last ?? null };
      })
      .filter((row) => row.reply_count > 0);
  },
  // The record write: the row lands now, its thread root set by the trigger's rule.
  chat_message_send: (args, tables) => {
    const rows = tables.chat_messages ?? [];
    const existing = rows.find((m) => m.id === args.p_id);
    if (existing !== undefined) return existing;
    const replyTo =
      typeof args.p_reply_to_message_id === 'string' ? args.p_reply_to_message_id : null;
    const row: Row = {
      id: args.p_id,
      channel_id: args.p_channel_id,
      workspace_id: WORKSPACE_ID,
      sender_user_id: ME,
      body: typeof args.p_body === 'string' ? args.p_body : null,
      mentions: Array.isArray(args.p_mentions) ? args.p_mentions : null,
      attachment_asset_ids: Array.isArray(args.p_attachment_asset_ids)
        ? args.p_attachment_asset_ids
        : null,
      shared_post_ids: Array.isArray(args.p_shared_post_ids) ? args.p_shared_post_ids : null,
      shared_brief_ids: null,
      reply_to_message_id: replyTo,
      forwarded_from_message_id: null,
      attachment_meta: isObject(args.p_attachment_meta) ? args.p_attachment_meta : null,
      agora_event_id: null,
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted_at: null,
      thread_root_message_id: threadRootOf(rows, replyTo),
    };
    if (typeof args.p_forwarded_from_message_id === 'string') {
      row.forwarded_from_message_id = args.p_forwarded_from_message_id;
    }
    if (Array.isArray(args.p_shared_brief_ids)) row.shared_brief_ids = args.p_shared_brief_ids;
    rows.push(row);
    return row;
  },
  // Scheduled sends: the four procs over the chat_scheduled_messages fixture.
  chat_message_schedule: (args, tables) => {
    const rows = (tables.chat_scheduled_messages ??= []);
    const now = new Date().toISOString();
    const row: Row = {
      id: args.p_id,
      channel_id: args.p_channel_id,
      workspace_id: WORKSPACE_ID,
      sender_user_id: ME,
      body: typeof args.p_body === 'string' ? args.p_body : null,
      mentions: Array.isArray(args.p_mentions) ? args.p_mentions : null,
      attachment_asset_ids: Array.isArray(args.p_attachment_asset_ids)
        ? args.p_attachment_asset_ids
        : null,
      attachment_meta: isObject(args.p_attachment_meta) ? args.p_attachment_meta : null,
      shared_post_ids: Array.isArray(args.p_shared_post_ids) ? args.p_shared_post_ids : null,
      shared_brief_ids: Array.isArray(args.p_shared_brief_ids) ? args.p_shared_brief_ids : null,
      reply_to_message_id:
        typeof args.p_reply_to_message_id === 'string' ? args.p_reply_to_message_id : null,
      send_at: args.p_send_at,
      status: 'scheduled',
      failure_reason: null,
      sent_at: null,
      created_at: now,
      updated_at: now,
    };
    rows.push(row);
    return row;
  },
  chat_scheduled_update: (args, tables) => {
    const row = (tables.chat_scheduled_messages ?? []).find((r) => r.id === args.p_id);
    if (row === undefined) return null;
    row.send_at = args.p_send_at;
    row.body = args.p_body;
    row.mentions = args.p_mentions;
    row.updated_at = new Date().toISOString();
    return row;
  },
  chat_scheduled_cancel: (args, tables) => {
    const row = (tables.chat_scheduled_messages ?? []).find((r) => r.id === args.p_id);
    if (row !== undefined) row.status = 'cancelled';
    return null;
  },
  chat_scheduled_send_now: (args, tables) => {
    const row = (tables.chat_scheduled_messages ?? []).find((r) => r.id === args.p_id);
    if (row === undefined) return null;
    row.status = 'sent';
    row.sent_at = new Date().toISOString();
    const send = RPC.chat_message_send;
    return send === undefined
      ? null
      : send(
          {
            p_id: row.id,
            p_channel_id: row.channel_id,
            p_body: row.body,
            p_mentions: row.mentions,
            p_shared_post_ids: row.shared_post_ids,
            p_reply_to_message_id: row.reply_to_message_id,
            p_attachment_asset_ids: row.attachment_asset_ids,
            p_attachment_meta: row.attachment_meta,
          },
          tables,
        );
  },
};

/** chat_message_search with p_kind: photo / voice / file by attachment mime, link by body. */
function kindSearch(args: Record<string, unknown>, tables: Tables): Row[] {
  const kind = String(args.p_kind);
  const query = String(args.p_query ?? '').trim();
  if (query.length === 1 || query.length > 100) return [];
  const words = query.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const limit = Math.min(50, Math.max(1, Number(args.p_limit ?? 30)));
  const beforeAt = typeof args.p_before_created_at === 'string' ? args.p_before_created_at : null;
  const beforeId = typeof args.p_before_id === 'string' ? args.p_before_id : null;
  const mimes = (m: Row): string[] =>
    isObject(m.attachment_meta)
      ? Object.values(m.attachment_meta).map((v) => (isObject(v) ? String(v.mime ?? '') : ''))
      : [];
  const ofKind = (m: Row): boolean => {
    if (kind === 'link') return /https?:\/\//i.test(String(m.body ?? ''));
    const list = mimes(m);
    if (kind === 'photo') return list.some((t) => t.startsWith('image/'));
    if (kind === 'voice') return list.some((t) => t.startsWith('audio/'));
    if (kind === 'file')
      return list.some((t) => !t.startsWith('image/') && !t.startsWith('audio/'));
    return false;
  };
  return (tables.chat_messages ?? [])
    .filter((m) => m.deleted_at === null && ofKind(m))
    .filter((m) => args.p_channel_id == null || m.channel_id === args.p_channel_id)
    .filter((m) => {
      if (words.length === 0) return true;
      const tokens =
        String(m.body ?? '')
          .toLowerCase()
          .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
      return words.every((w) => tokens.some((t) => t.startsWith(w)));
    })
    .sort(
      (a, b) =>
        String(b.created_at).localeCompare(String(a.created_at)) ||
        String(b.id).localeCompare(String(a.id)),
    )
    .filter((m) => {
      if (beforeAt === null || beforeId === null) return true;
      const at = String(m.created_at);
      return at < beforeAt || (at === beforeAt && String(m.id) < beforeId);
    })
    .slice(0, limit);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A refused record write (the proc raised): the send shows "Not sent" with its alert. */
function refusedSend(name: string, args: Record<string, unknown>): boolean {
  return (
    name === 'chat_message_send' &&
    typeof args.p_body === 'string' &&
    args.p_body.includes(REFUSED_SEND)
  );
}

export interface HarnessNetwork {
  world: ChatWorld;
  /** Requests the fixtures did not recognise (answered with an empty result). */
  unmatched: string[];
  /** Every non-localhost request that was blocked outright. */
  blocked: string[];
  /** Gate chat_messages reads until release() so a test can see first paint. */
  holdHistory: () => { release: () => void };
  /** Every file name the asset-upload stub received, in order. */
  uploads: string[];
  /** Gate asset uploads until release() so a test can see them in flight. */
  holdUploads: () => { release: () => void };
}

export async function installHarnessNetwork(page: Page): Promise<HarnessNetwork> {
  const world = buildWorld();
  const unmatched: string[] = [];
  const blocked: string[] = [];
  let historyGate: Promise<void> | null = null;
  const uploads: string[] = [];
  let uploadGate: Promise<void> | null = null;

  await page.addInitScript((session) => {
    window.localStorage.setItem('sb-harness-auth-token', session);
  }, fakeSession());

  const png = solidPng(64, 48, [96, 128, 160]);
  const wav = silentWav();

  const handle = async (route: Route): Promise<void> => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    if (url.hostname === SUPABASE_HOST) {
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.slice('/rest/v1/rpc/'.length);
        const handler = RPC[name];
        if (!handler) unmatched.push(`rpc ${name}`);
        const args = (request.postDataJSON() ?? {}) as Record<string, unknown>;
        if (refusedSend(name, args)) {
          await route.fulfill({
            status: 400,
            headers: { ...CORS, 'content-type': 'application/json' },
            body: JSON.stringify({ code: 'P0001', message: 'refused', details: null, hint: null }),
          });
          return;
        }
        const result = handler ? handler(args, world.tables) : null;
        await route.fulfill({
          status: 200,
          headers: { ...CORS, 'content-type': 'application/json' },
          body: JSON.stringify(result),
        });
        return;
      }
      if (url.pathname.startsWith('/rest/v1/')) {
        const table = url.pathname.slice('/rest/v1/'.length);
        if (method !== 'GET' && method !== 'HEAD') {
          unmatched.push(`${method} ${table}`);
          await route.fulfill({ status: 204, headers: CORS });
          return;
        }
        if (!(table in world.tables)) unmatched.push(`table ${table}`);
        if (table === 'chat_messages' && historyGate) await historyGate;
        const answer = answerRest(world.tables, table, url.searchParams, method, request.headers());
        await route.fulfill({
          status: answer.status,
          headers: { ...CORS, ...answer.headers },
          body: answer.body,
        });
        return;
      }
      if (url.pathname.startsWith('/auth/v1/user')) {
        const session = JSON.parse(fakeSession()) as { user: Row };
        await route.fulfill({
          status: 200,
          headers: { ...CORS, 'content-type': 'application/json' },
          body: JSON.stringify(session.user),
        });
        return;
      }
      unmatched.push(`${method} ${url.pathname}`);
      await route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: '{}',
      });
      return;
    }
    if (url.hostname === CHAT_TOKEN_HOST) {
      await route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({
          token: 'harness-chat-token',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          agora_username: ME.replace(/-/g, ''),
          app_key: 'harness#app',
        }),
      });
      return;
    }
    if (url.hostname === ASSET_READ_HOST) {
      if (url.pathname.startsWith('/blob/audio')) {
        await route.fulfill({
          status: 200,
          headers: { ...CORS, 'content-type': 'audio/wav' },
          body: wav,
        });
        return;
      }
      if (url.pathname.startsWith('/blob/')) {
        await route.fulfill({
          status: 200,
          headers: { ...CORS, 'content-type': 'image/png' },
          body: png,
        });
        return;
      }
      const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
      const id = String(body.asset_version_id ?? body.id ?? 'x');
      const isAudio = Object.values(world.tables.chat_messages ?? []).some((m) => {
        const meta = m.attachment_meta as Record<string, { mime?: string }> | null;
        return meta?.[id]?.mime?.startsWith('audio/') === true;
      });
      await route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({
          url: `https://${ASSET_READ_HOST}/blob/${isAudio ? 'audio' : 'image'}/${id}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      });
      return;
    }
    if (url.hostname === ASSET_UPLOAD_HOST && method === 'POST') {
      // The asset-upload Worker's answer: a fresh asset and version per file.
      if (uploadGate) await uploadGate;
      const body = request.postDataBuffer()?.toString('latin1') ?? '';
      const name = /filename="([^"]+)"/.exec(body)?.[1] ?? 'file';
      uploads.push(name);
      const n = String(uploads.length).padStart(12, '0');
      await route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({
          asset: {
            assetId: `0190f000-0000-7000-8000-${n}`,
            versionId: `0190f100-0000-7000-8000-${n}`,
            reused: false,
          },
        }),
      });
      return;
    }
    blocked.push(request.url());
    await route.abort('blockedbyclient');
  };

  // The page's own object URLs (picked-file previews; WebKit routes them) never
  // leave the page, so they are not routed.
  await page.route(/^(?!https?:\/\/localhost[:/]|blob:)/, handle);
  // page.route never sees WebSockets. A socket to a fixture host is accepted
  // and left silent (no server behind it); any other socket is closed and
  // recorded as blocked.
  await page.routeWebSocket(/^(?!wss?:\/\/localhost[:/])/, (socket) => {
    const host = new URL(socket.url()).hostname;
    if (host.endsWith('.test')) return;
    blocked.push(socket.url());
    void socket.close();
  });

  return {
    world,
    unmatched,
    blocked,
    holdHistory: () => {
      let release = (): void => {};
      historyGate = new Promise<void>((resolve) => {
        release = () => {
          historyGate = null;
          resolve();
        };
      });
      return { release };
    },
    uploads,
    holdUploads: () => {
      let release = (): void => {};
      uploadGate = new Promise<void>((resolve) => {
        release = () => {
          uploadGate = null;
          resolve();
        };
      });
      return { release };
    },
  };
}

export { WORKSPACE_ID };
