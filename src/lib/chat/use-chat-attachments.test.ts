// T6: the chat composer/outbox uploads with origin 'chat'; the comment composers
// upload with origin 'library'. The hooks are exercised directly (react's memo
// hooks are identity here), with the upload call itself captured.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ params: [] as Array<Record<string, unknown>> }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useCallback: <T>(fn: T): T => fn,
    useMemo: <T>(factory: () => T): T => factory(),
  };
});
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: { access_token: 'jwt' } } }),
      refreshSession: () => Promise.resolve({ data: { session: null }, error: null }),
    },
  },
}));
vi.mock('@/lib/env', () => ({
  env: {
    VITE_ASSET_UPLOAD_URL: 'https://upload.test',
    VITE_ASSET_READ_URL: 'https://read.test',
  },
}));
vi.mock('@/lib/workspace-context', () => ({ useWorkspace: () => ({ workspaceId: 'ws-1' }) }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/chat/attachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat/attachments')>();
  return {
    ...actual,
    uploadChatAttachment: (params: Record<string, unknown>) => {
      captured.params.push(params);
      return Promise.resolve({ ok: true, reused: false, versionId: 'v-1' });
    },
  };
});

import { useChatAttachments, useCommentAttachments } from './use-chat-attachments';

beforeEach(() => {
  captured.params = [];
});

const file = new File(['x'], 'photo.png', { type: 'image/png' });

describe('upload origin by composer', () => {
  it("the chat composer (useChatAttachments) uploads with origin 'chat'", async () => {
    const result = await useChatAttachments().uploadFile(file);
    expect(result.ok).toBe(true);
    expect(captured.params).toHaveLength(1);
    expect(captured.params[0]?.origin).toBe('chat');
  });

  it("the comment composer (useCommentAttachments) uploads with origin 'library'", async () => {
    const result = await useCommentAttachments().uploadFile(file);
    expect(result.ok).toBe(true);
    expect(captured.params).toHaveLength(1);
    expect(captured.params[0]?.origin).toBe('library');
  });

  it('wires comments to the library hook and only the chat surfaces to the chat hook', () => {
    const read = (path: string): string =>
      readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
    const comments = read('../../components/comments/Comments.tsx');
    expect(comments).toContain('useCommentAttachments()');
    expect(comments).not.toContain('useChatAttachments');
    for (const chatSurface of [
      '../../components/chat/MessageThread.tsx',
      '../../components/chat/ChatStoreProvider.tsx',
    ]) {
      const source = read(chatSurface);
      expect(source).toContain('useChatAttachments()');
      expect(source).not.toContain('useCommentAttachments');
    }
  });
});
