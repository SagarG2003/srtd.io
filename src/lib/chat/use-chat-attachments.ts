// React adapter that binds chat attachments to the app's runtime: the active
// workspace, the session token, the trace factory, and the asset Worker URLs.
// It mirrors AssetsPage's wiring (one PresignCache for the surface, an upload
// command that mints a fresh trace) so the composer and renderer stay free of
// the env / supabase / fetch import chain and remain unit-testable in isolation.

import { useCallback, useMemo } from 'react';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { fetchWithTrace } from '@/lib/fetch';
import { env } from '@/lib/env';
import { useNewTrace } from '@/lib/trace-context';
import { useWorkspace } from '@/lib/workspace-context';
import { PresignCache } from '@/lib/asset-presign';
import {
  CHAT_UPLOAD_FAILED,
  uploadChatAttachment,
  type AttachmentUploader,
  type ChatAttachmentUpload,
} from '@/lib/chat/attachments';
import {
  TRANSCRIBE_TIMEOUT_MS,
  transcribeAudio,
  type TranscribeResult,
} from '@/lib/chat/transcribe';
import {
  uploadWithSessionRetry,
  watchUploadStall,
  type SessionRefresh,
  type StallWatch,
  type UploadAttemptResult,
} from '@/lib/chat/send-flow';

export interface ChatAttachments {
  /** Whether the composer can upload (endpoint configured + a workspace selected). */
  canAttach: boolean;
  /** Whether thumbnails can be presigned (asset-read endpoint configured). */
  presignEnabled: boolean;
  /** One cache for the thread: bounds presign concurrency and caches URLs (no N+1). */
  presignCache: PresignCache;
  /**
   * Upload one picked file over XHR, reporting progress (0..1) when asked;
   * never throws (asset-upload Result contract). An upload with no progress
   * for UPLOAD_STALL_MS (or no answer UPLOAD_RESPONSE_WAIT_MS after its last
   * byte) is aborted and fails like a network error; a failure carries the
   * XHR status, and a 401 refreshes the session and retries once.
   */
  uploadFile: AttachmentUploader;
  /** Transcribe a recorded voice note; never throws (Result contract). */
  transcribe: (blob: Blob) => Promise<TranscribeResult>;
  /** Whether transcription is configured (transcribe endpoint set). */
  canTranscribe: boolean;
}

/** Refresh the session once for an upload refused with 401. */
async function refreshChatSession(): Promise<SessionRefresh> {
  const { data, error } = await supabase.auth.refreshSession();
  if (error !== null) return isAuthRetryableFetchError(error) ? 'unreachable' : 'rejected';
  return data.session !== null ? 'refreshed' : 'rejected';
}

export function useChatAttachments(): ChatAttachments {
  const { workspaceId } = useWorkspace();
  const newTrace = useNewTrace();
  const uploadEndpoint = env.VITE_ASSET_UPLOAD_URL;
  const transcribeEndpoint = env.VITE_CHAT_TRANSCRIBE_URL;
  const canTranscribe = transcribeEndpoint !== undefined && transcribeEndpoint !== '';
  const presignEnabled = env.VITE_ASSET_READ_URL !== undefined && env.VITE_ASSET_READ_URL !== '';

  const presignCache = useMemo(
    () =>
      new PresignCache({
        endpoint: env.VITE_ASSET_READ_URL ?? null,
        getAccessToken: async () =>
          (await supabase.auth.getSession()).data.session?.access_token ?? null,
        fetcher: (input, init) => fetchWithTrace(input, init),
      }),
    [],
  );

  const uploadFile = useCallback(
    async (file: File, onProgress?: (fraction: number) => void): Promise<ChatAttachmentUpload> => {
      if (uploadEndpoint === undefined || uploadEndpoint === '') {
        return { ok: false, message: CHAT_UPLOAD_FAILED };
      }
      if (workspaceId === null) {
        return { ok: false, message: 'No workspace selected.' };
      }
      const endpoint = uploadEndpoint;
      const workspace = workspaceId;
      // One attempt: the stall watch and the status read ride on the request
      // the shared XHR transport opens; the watch stops however it settles.
      const attempt = async (): Promise<UploadAttemptResult> => {
        const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
        if (token === null || token === '') {
          return {
            result: { ok: false, message: 'Your session expired. Sign in again.' },
            status: null,
          };
        }
        const held: { request: XMLHttpRequest | null; watch: StallWatch | null } = {
          request: null,
          watch: null,
        };
        try {
          const result = await uploadChatAttachment({
            file,
            workspaceId: workspace,
            token,
            endpoint,
            xhr: {
              traceId: newTrace(),
              ...(onProgress !== undefined ? { onProgress } : {}),
              createRequest: () => {
                const request = new XMLHttpRequest();
                held.request = request;
                held.watch = watchUploadStall(request);
                return request;
              },
            },
          });
          return { result, status: held.request?.status ?? null };
        } finally {
          held.watch?.stop();
        }
      };
      return uploadWithSessionRetry(attempt, refreshChatSession);
    },
    [uploadEndpoint, workspaceId, newTrace],
  );

  const transcribe = useCallback(
    async (blob: Blob): Promise<TranscribeResult> => {
      if (transcribeEndpoint === undefined || transcribeEndpoint === '') {
        return { ok: false, message: 'Transcription is unavailable.' };
      }
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      if (token === null || token === '') {
        return { ok: false, message: 'Your session expired. Sign in again.' };
      }
      return transcribeAudio({
        blob,
        endpoint: transcribeEndpoint,
        token,
        fetcher: (input, init) => fetchWithTrace(input, init, newTrace()),
        timeoutMs: TRANSCRIBE_TIMEOUT_MS,
      });
    },
    [transcribeEndpoint, newTrace],
  );

  const canAttach = uploadEndpoint !== undefined && uploadEndpoint !== '' && workspaceId !== null;
  return { canAttach, presignEnabled, presignCache, uploadFile, transcribe, canTranscribe };
}
