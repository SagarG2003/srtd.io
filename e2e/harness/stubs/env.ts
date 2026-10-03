// Harness-only replacement for src/lib/env.ts (aliased in e2e/harness/vite.config.ts).
// Every URL points at a .test host that Playwright fulfils from fixtures; nothing
// here is a real endpoint or secret.
import type { Env } from '../../../src/lib/env';

export const HARNESS_SUPABASE_URL = 'https://harness.supabase.test';
export const HARNESS_CHAT_TOKEN_URL = 'https://chat-token.harness.test/token';
export const HARNESS_ASSET_READ_URL = 'https://asset-read.harness.test';

export const env: Env = {
  VITE_SUPABASE_URL: HARNESS_SUPABASE_URL,
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_harness_000000000000',
  VITE_ASSET_READ_URL: HARNESS_ASSET_READ_URL,
  VITE_ASSET_UPLOAD_URL: undefined,
  VITE_AVATAR_UPLOAD_URL: undefined,
  VITE_CHAT_TOKEN_URL: HARNESS_CHAT_TOKEN_URL,
  VITE_CHAT_TRANSCRIBE_URL: undefined,
  VITE_SENTRY_DSN_FRONTEND: undefined,
  VITE_SENTRY_ENVIRONMENT: 'development',
  VITE_SENTRY_RELEASE: undefined,
};
