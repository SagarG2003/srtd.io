// Worker-level coverage for the chat-origin read gate: the real
// createSupabaseAssetReadStore runs against a mocked supabase-js client, so the
// select (assets.origin), the chat_attachment_readable RPC, the X-Trace-Id
// header and the HTTP status/body mapping are all exercised together.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';

const mockedJwks = vi.hoisted(() => ({ keys: [] as JWK[] }));
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    createRemoteJWKSet: () => actual.createLocalJWKSet(mockedJwks),
  };
});

interface FakeDb {
  origin: string;
  members: Set<string>;
  readable: boolean;
  rpcError: { message: string } | null;
  selects: string[];
  rpcCalls: Array<{ fn: string; args: unknown }>;
  clientOptions: unknown[];
}

const db = vi.hoisted<FakeDb>(() => ({
  origin: 'library',
  members: new Set<string>(),
  readable: false,
  rpcError: null,
  selects: [],
  rpcCalls: [],
  clientOptions: [],
}));

const WORKSPACE = '11111111-1111-7111-8111-111111111111';

vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options: unknown) => {
    db.clientOptions.push(options);
    return {
      from: (table: string) => {
        const filters: Record<string, unknown> = {};
        const builder = {
          select: (cols: string) => {
            db.selects.push(`${table}:${cols}`);
            return builder;
          },
          eq: (col: string, value: unknown) => {
            filters[col] = value;
            return builder;
          },
          limit: () => builder,
          maybeSingle: () => {
            if (table === 'asset_versions') {
              return Promise.resolve({
                data: {
                  workspace_id: WORKSPACE,
                  kind: 'image',
                  r2_key: 'images/a/v1-photo.jpg',
                  mime_type: 'image/jpeg',
                  workspaces: { asset_bucket: 'assets-acme' },
                  assets: { filename: 'photo.jpg', display_name: null, origin: db.origin },
                },
                error: null,
              });
            }
            const key = `${String(filters.user_id)}:${String(filters.workspace_id)}`;
            return Promise.resolve({
              data: db.members.has(key) ? { id: 'm1' } : null,
              error: null,
            });
          },
        };
        return builder;
      },
      rpc: (fn: string, args: unknown) => {
        db.rpcCalls.push({ fn, args });
        return Promise.resolve(
          db.rpcError !== null
            ? { data: null, error: db.rpcError }
            : { data: db.readable, error: null },
        );
      },
    };
  },
}));

const presign = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@srtdio/storage', () => ({
  R2StorageClient: class {
    presignGetUrl(): Promise<string> {
      presign.calls += 1;
      return Promise.resolve('https://signed.example/photo?sig=abc');
    }
  },
}));

import worker, { type AssetReadEnv } from './asset-read';

const USER = '33333333-3333-7333-8333-333333333333';
const VERSION_ID = '55555555-5555-7555-8555-555555555555';
const TRACE = '0192f8a0-7d3e-7c4b-9a1f-2b3c4d5e6f70';
const env: AssetReadEnv = {
  CLOUDFLARE_ACCOUNT_ID: 'acct',
  CLOUDFLARE_R2_ACCESS_KEY_ID: 'akid',
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SECRET_KEY: 'service-role-key',
};

let signingKey: KeyLike;
beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  signingKey = privateKey;
  mockedJwks.keys = [{ ...(await exportJWK(publicKey)), alg: 'ES256', use: 'sig', kid: 'k' }];
});

beforeEach(() => {
  db.origin = 'library';
  db.members = new Set();
  db.readable = false;
  db.rpcError = null;
  db.selects = [];
  db.rpcCalls = [];
  db.clientOptions = [];
  presign.calls = 0;
});

async function post(): Promise<Response> {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: 'k' })
    .setSubject(USER)
    .setExpirationTime('1h')
    .sign(signingKey);
  return worker.fetch(
    new Request('https://worker.test/', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Trace-Id': TRACE,
      },
      body: JSON.stringify({ asset_version_id: VERSION_ID }),
    }),
    env,
  );
}

describe('asset-read worker: chat-origin files', () => {
  it('selects assets.origin and signs a chat file the caller may read', async () => {
    db.origin = 'chat';
    db.readable = true;
    const res = await post();
    expect(res.status).toBe(200);
    expect(db.selects.some((s) => s.includes('assets!asset_id(') && s.includes('origin'))).toBe(
      true,
    );
    expect(db.rpcCalls).toEqual([
      {
        fn: 'chat_attachment_readable',
        args: { p_asset_version_id: VERSION_ID, p_user_id: USER },
      },
    ]);
    // The service-role client carries the request trace on every call.
    expect(db.clientOptions).toContainEqual(
      expect.objectContaining({ global: { headers: { 'X-Trace-Id': TRACE } } }),
    );
    expect(presign.calls).toBe(1);
  });

  it('answers a non-reader with the identical 403 body a library non-member gets', async () => {
    db.origin = 'chat';
    db.readable = false;
    db.members = new Set([`${USER}:${WORKSPACE}`]);
    const chatRes = await post();
    const chatBody: unknown = await chatRes.json();

    db.origin = 'library';
    db.members = new Set();
    const libRes = await post();
    const libBody: unknown = await libRes.json();

    expect(chatRes.status).toBe(403);
    expect(libRes.status).toBe(403);
    expect(chatBody).toEqual(libBody);
    expect(presign.calls).toBe(0);
  });

  it('keeps library reads on the membership check with no chat RPC', async () => {
    db.members = new Set([`${USER}:${WORKSPACE}`]);
    const res = await post();
    expect(res.status).toBe(200);
    expect(db.rpcCalls).toHaveLength(0);
    expect(presign.calls).toBe(1);
  });

  it('returns 500 and never signs when the chat RPC errors', async () => {
    db.origin = 'chat';
    db.rpcError = { message: 'boom' };
    const res = await post();
    expect(res.status).toBe(500);
    expect(presign.calls).toBe(0);
  });
});
