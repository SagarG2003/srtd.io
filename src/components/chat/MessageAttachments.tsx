// Renders the attachments on one message. The per-attachment dispatch is
// explicit (classifyAttachment -> branch) so PR6 can add a shared-post branch
// without touching the image / file branches. Each attachment presigns through
// the shared PresignCache, which dedupes in-flight ids and caches URLs, so a
// thread of attachments never fires N+1 presigns and re-renders never re-presign.
//
// An own instant send renders from its local preview (the picked file's object
// URL) for the whole session, before and after it records, so the tile never
// swaps to the presigned URL. While its upload runs the image is dimmed with a
// thin progress bar along the bottom; the bar's width is the only thing that
// animates, and the tile keeps its size when the upload completes.

import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { IconFile } from '@/components/ui/icons';
import { VoiceNote } from '@/components/chat/VoiceNote';
import { fileExtension } from '@/lib/assets';
import { cn } from '@/lib/cn';
import type { PresignCache } from '@/lib/asset-presign';
import { classifyAttachment, uploadProgress, type MessageAttachment } from '@/lib/chat/attachments';

/** The file chip's Open link, styled as the shared ghost sm Button (it navigates, so it stays a link). */
const OPEN_BUTTON =
  'inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-medium text-fg-2 transition-colors hover:bg-panel-2';

/** Presign one attachment id once, refreshing shortly before expiry; never throws. */
export function useAttachmentUrl(
  assetId: string,
  cache: PresignCache,
  enabled: boolean,
): { url: string | null; failed: boolean } {
  const [url, setUrl] = useState<string | null>(() =>
    enabled && assetId !== '' ? (cache.peek(assetId)?.url ?? null) : null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled || assetId === '') return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async (): Promise<void> => {
      try {
        const presigned = await cache.resolve(assetId);
        if (!live) return;
        setUrl(presigned.url);
        setFailed(false);
        const delay = Math.max(presigned.expiresAt - Date.now() - 60_000, 5_000);
        timer = setTimeout(() => {
          if (live) void load();
        }, delay);
      } catch {
        if (live) setFailed(true);
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [assetId, cache, enabled]);

  return { url, failed };
}

/**
 * The upload bar along a tile's bottom edge: a track and a fill whose width is
 * the progress (the only animated property). White with opacity sits on the
 * image or on the own bubble's fill (white is accent-fg in both themes), so it
 * reads the same in light and dark.
 */
function UploadBar({ progress }: { progress: number }): ReactElement {
  return (
    <span
      role="progressbar"
      aria-label="Uploading"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      className="absolute inset-x-0 bottom-0 h-[3px] bg-white/35"
    >
      <span
        className="block h-full bg-white transition-[width]"
        style={{ width: `${progress * 100}%` }}
      />
    </span>
  );
}

function FileChip({
  name,
  url,
  progress,
}: {
  name: string;
  url: string | null;
  progress?: number | undefined;
}): ReactElement {
  const ext = fileExtension(name);
  const label = name.trim() !== '' ? name : 'Attachment';
  return (
    <div className="relative flex items-center gap-2 overflow-hidden rounded-lg border border-border bg-panel px-2.5 py-2">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-panel-3 text-fg-3">
        <IconFile size={18} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs font-medium text-fg" title={label}>
          {label}
        </span>
        <span className="text-[11px] text-fg-3">{ext !== '' ? ext : 'File'}</span>
      </span>
      {url !== null ? (
        // The 32px ghost button sits in a 44px-tall hit wrapper.
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-h-[44px] shrink-0 items-center"
        >
          <span className={OPEN_BUTTON}>Open</span>
        </a>
      ) : null}
      {progress !== undefined ? <UploadBar progress={progress} /> : null}
    </div>
  );
}

/**
 * The render branch for one attachment, derived purely from its kind and presign
 * lifecycle so it is unit-testable without a DOM (this codebase renders no React
 * in tests). `image` is a resolved thumbnail, `image-pending` its loading shimmer,
 * `file` the chip (whose Open link appears once `url` is non-null). PR6 extension
 * point: add a 'post' variant here and a case below; the image / file branches
 * stay untouched.
 */
export type AttachmentView =
  | { kind: 'image'; src: string; alt: string }
  /** An own instant send: its local preview, with upload progress until the version id lands. */
  | { kind: 'image-local'; src: string; alt: string; progress: number | null }
  | { kind: 'image-pending'; alt: string }
  | {
      kind: 'audio';
      url: string | null;
      name: string;
      transcript: string | undefined;
      durationMs: number | undefined;
    }
  | { kind: 'file'; name: string; url: string | null; progress?: number };

export function attachmentView(args: {
  attachment: MessageAttachment;
  presignEnabled: boolean;
  url: string | null;
  failed: boolean;
}): AttachmentView {
  const { attachment, presignEnabled, url, failed } = args;
  const progress = uploadProgress(attachment);
  const previewUrl = attachment.local?.previewUrl ?? null;
  if (classifyAttachment(attachment.mime) === 'image' && previewUrl !== null) {
    return { kind: 'image-local', src: previewUrl, alt: attachment.name, progress };
  }
  if (progress !== null) {
    return { kind: 'file', name: attachment.name, url: null, progress };
  }
  if (classifyAttachment(attachment.mime) === 'image' && presignEnabled && !failed) {
    return url !== null
      ? { kind: 'image', src: url, alt: attachment.name }
      : { kind: 'image-pending', alt: attachment.name };
  }
  if (classifyAttachment(attachment.mime) === 'audio' && presignEnabled && !failed) {
    return {
      kind: 'audio',
      url,
      name: attachment.name,
      transcript: attachment.transcript,
      durationMs: attachment.durationMs,
    };
  }
  return { kind: 'file', name: attachment.name, url };
}

function AttachmentItem({
  attachment,
  cache,
  presignEnabled,
  onImageClick,
  voiceSpacer,
}: {
  attachment: MessageAttachment;
  cache: PresignCache;
  presignEnabled: boolean;
  onImageClick?: ((attachment: MessageAttachment) => void) | undefined;
  voiceSpacer?: ReactNode;
}): ReactElement {
  // The render layer presigns the attachment's VERSION id (assetId carries the
  // asset_versions.id) through the shared cache, which dedupes in-flight ids.
  // A local preview is the tile for the session: it never presigns.
  const hasPreview = attachment.local?.previewUrl != null;
  const { url, failed } = useAttachmentUrl(
    attachment.assetId,
    cache,
    presignEnabled && !hasPreview,
  );
  const view = attachmentView({ attachment, presignEnabled, url, failed });

  switch (view.kind) {
    case 'image': {
      const image = (
        <img
          src={view.src}
          alt={view.alt}
          className="max-h-48 max-w-[260px] rounded-lg border border-border object-cover"
        />
      );
      // When the caller wants tap-to-open (comments), wrap the unchanged <img> in
      // a button; chat passes no onImageClick so it renders exactly as before.
      return onImageClick !== undefined ? (
        <button
          type="button"
          aria-label="Open image"
          onClick={() => onImageClick(attachment)}
          className="cursor-zoom-in"
        >
          {image}
        </button>
      ) : (
        image
      );
    }
    case 'image-local':
      return (
        <div className="relative overflow-hidden rounded-lg border border-border">
          <img
            src={view.src}
            alt={view.alt}
            className={cn(
              'block max-h-48 max-w-[260px] object-cover',
              view.progress !== null && 'brightness-75',
            )}
          />
          {view.progress !== null ? <UploadBar progress={view.progress} /> : null}
        </div>
      );
    case 'image-pending':
      return <div className="h-32 w-44 animate-pulse rounded-lg border border-border bg-panel-2" />;
    case 'audio':
      return (
        <VoiceNote
          url={view.url}
          name={view.name}
          transcript={view.transcript}
          durationMs={view.durationMs}
          {...(voiceSpacer !== undefined ? { spacer: voiceSpacer } : {})}
        />
      );
    case 'file':
      return <FileChip name={view.name} url={view.url} progress={view.progress} />;
  }
}

export function MessageAttachments({
  attachments,
  cache,
  presignEnabled,
  onImageClick,
  voiceSpacer,
}: {
  attachments: readonly MessageAttachment[];
  cache: PresignCache;
  presignEnabled: boolean;
  /** Optional: tap an image attachment to open it (comments). Chat omits it. */
  onImageClick?: ((attachment: MessageAttachment) => void) | undefined;
  /**
   * Chat voice-only bubbles: the inline time spacer a voice note ends with, and
   * the list sits flush in the bubble (no top margin, full width).
   */
  voiceSpacer?: ReactNode;
}): ReactElement | null {
  if (attachments.length === 0) return null;
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5',
        voiceSpacer !== undefined ? 'items-stretch' : 'mt-1.5 items-start',
      )}
    >
      {attachments.map((attachment, index) => (
        <AttachmentItem
          key={attachment.local?.key ?? `${attachment.assetId}-${index}`}
          attachment={attachment}
          cache={cache}
          presignEnabled={presignEnabled}
          onImageClick={onImageClick}
          {...(voiceSpacer !== undefined ? { voiceSpacer } : {})}
        />
      ))}
    </div>
  );
}
