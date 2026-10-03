// Installs the harness network: a fake signed-in Supabase session in
// localStorage, the fixture PostgREST for https://harness.supabase.test, the
// chat-token and asset-read .test hosts, and a hard block on every other
// non-localhost request. Nothing leaves the machine.

import { deflateSync } from 'node:zlib';
import type { Page, Route } from '@playwright/test';
import { answerRest, type Row, type Tables } from './postgrest';
import { buildWorld, ME, WORKSPACE_ID, type ChatWorld } from './chat-data';

const SUPABASE_HOST = 'harness.supabase.test';
const CHAT_TOKEN_HOST = 'chat-token.harness.test';
const ASSET_READ_HOST = 'asset-read.harness.test';

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
  session_register: () => null,
};

export interface HarnessNetwork {
  world: ChatWorld;
  /** Requests the fixtures did not recognise (answered with an empty result). */
  unmatched: string[];
  /** Every non-localhost request that was blocked outright. */
  blocked: string[];
  /** Gate chat_messages reads until release() so a test can see first paint. */
  holdHistory: () => { release: () => void };
}

export async function installHarnessNetwork(page: Page): Promise<HarnessNetwork> {
  const world = buildWorld();
  const unmatched: string[] = [];
  const blocked: string[] = [];
  let historyGate: Promise<void> | null = null;

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
    blocked.push(request.url());
    await route.abort('blockedbyclient');
  };

  await page.route(/^(?!https?:\/\/localhost[:/])/, handle);
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
  };
}

export { WORKSPACE_ID };
