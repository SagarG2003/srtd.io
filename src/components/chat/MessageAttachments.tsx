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
//
// Chat groups a message's images into one album (AlbumGrid): the grid is sized
// from the image COUNT alone, so first paint is final and a presigned image
// arriving never shifts layout. Every tile is a real button that opens the
// lightbox at its index; non-image attachments render below the album as before.

import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { IconFile, IconImage } from '@/components/ui/icons';
import { VoiceNote } from '@/components/chat/VoiceNote';
import { fileExtension } from '@/lib/assets';
import { cn } from '@/lib/cn';
import type { PresignCache } from '@/lib/asset-presign';
import {
  classifyAttachment,
  isVoiceAttachment,
  localAudioUrl,
  splitAlbum,
  uploadProgress,
  type MessageAttachment,
} from '@/lib/chat/attachments';

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
          draggable={false}
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
      durationMs: number | undefined;
      /** Own instant send: upload progress until the version id lands; null once sent. */
      progress: number | null;
    }
  | { kind: 'file'; name: string; url: string | null; progress?: number };

/**
 * A chat voice note's message context: its id (played state and transcript
 * key), side, sender photo, and the voice note right below it from the same
 * sender (auto-play next), if any.
 */
export interface VoiceContext {
  messageId: string;
  mine: boolean;
  sender: { name: string; src?: string | undefined };
  nextVoiceId: string | null;
}

export function attachmentView(args: {
  attachment: MessageAttachment;
  presignEnabled: boolean;
  url: string | null;
  failed: boolean;
  /** An own voice note's recorded file (object URL); plays before and after the upload. */
  localUrl?: string | null;
}): AttachmentView {
  const { attachment, presignEnabled, url, failed } = args;
  const progress = uploadProgress(attachment);
  const previewUrl = attachment.local?.previewUrl ?? null;
  if (classifyAttachment(attachment.mime) === 'image' && previewUrl !== null) {
    return { kind: 'image-local', src: previewUrl, alt: attachment.name, progress };
  }
  // A voice note is always the voice bubble, uploading or sent, so the switch
  // never changes its size; it plays from the local file when there is one.
  if (isVoiceAttachment(attachment)) {
    const localUrl = args.localUrl ?? null;
    return {
      kind: 'audio',
      url: localUrl ?? (presignEnabled && !failed ? url : null),
      name: attachment.name,
      durationMs: attachment.durationMs,
      progress,
    };
  }
  if (progress !== null) {
    return { kind: 'file', name: attachment.name, url: null, progress };
  }
  if (classifyAttachment(attachment.mime) === 'image' && presignEnabled && !failed) {
    return url !== null
      ? { kind: 'image', src: url, alt: attachment.name }
      : { kind: 'image-pending', alt: attachment.name };
  }
  return { kind: 'file', name: attachment.name, url };
}

function AttachmentItem({
  attachment,
  cache,
  presignEnabled,
  onImageClick,
  voiceSpacer,
  voice,
}: {
  attachment: MessageAttachment;
  cache: PresignCache;
  presignEnabled: boolean;
  onImageClick?: (() => void) | undefined;
  voiceSpacer?: ReactNode;
  voice?: VoiceContext | undefined;
}): ReactElement {
  // The render layer presigns the attachment's VERSION id (assetId carries the
  // asset_versions.id) through the shared cache, which dedupes in-flight ids.
  // A local preview (or an own voice note's recorded file) is the source for
  // the session: it never presigns.
  const localUrl = isVoiceAttachment(attachment) ? localAudioUrl(attachment) : null;
  const hasPreview = attachment.local?.previewUrl != null || localUrl !== null;
  const { url, failed } = useAttachmentUrl(
    attachment.assetId,
    cache,
    presignEnabled && !hasPreview,
  );
  const view = attachmentView({ attachment, presignEnabled, url, failed, localUrl });

  switch (view.kind) {
    case 'image': {
      const image = (
        <img
          src={view.src}
          alt={view.alt}
          draggable={false}
          className="max-h-48 max-w-[260px] rounded-lg border border-border object-cover"
        />
      );
      // When the caller wants tap-to-open (comments), wrap the unchanged <img> in
      // a button; chat passes no onImageClick so it renders exactly as before.
      return onImageClick !== undefined ? (
        <button
          type="button"
          aria-label="Open image"
          onClick={onImageClick}
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
            draggable={false}
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
      // One wrapper in both states; the upload bar is absolute, so the bubble
      // keeps its size when the upload completes.
      return (
        <div data-voice-upload={view.progress !== null ? '' : undefined} className="relative">
          <VoiceNote
            url={view.url}
            name={view.name}
            durationMs={view.durationMs}
            {...(voiceSpacer !== undefined ? { spacer: voiceSpacer } : {})}
            {...(voice !== undefined ? voice : {})}
          />
          {view.progress !== null ? <UploadBar progress={view.progress} /> : null}
        </div>
      );
    case 'file':
      return <FileChip name={view.name} url={view.url} progress={view.progress} />;
  }
}

/** One album tile: the image it shows, its grid classes, and the "+N" overflow count. */
export interface AlbumTile {
  index: number;
  className: string;
  /** Images beyond the fourth, shown as "+N" on the fourth tile; 0 shows none. */
  more: number;
}

/** The album grid's column template by count: one column for a single image, else two. */
export function albumGridClass(count: number): string {
  return count === 1 ? 'grid grid-cols-1' : 'grid grid-cols-2';
}

/**
 * Tile layout by image count, derived from the count alone so the grid never
 * waits on an image load. 1: one full-width tile (4:3 box, capped at 320px, the
 * image object-cover inside it). 2: two squares. 3: a 2:1 wide tile over two
 * squares. 4 or more: a 2x2 of squares, the fourth carrying "+N" (N = count - 4)
 * when there are more. Pure.
 */
export function albumTiles(count: number): AlbumTile[] {
  if (count <= 0) return [];
  if (count === 1) return [{ index: 0, className: 'aspect-[4/3] max-h-[320px]', more: 0 }];
  if (count === 2) {
    return [0, 1].map((index) => ({ index, className: 'aspect-square', more: 0 }));
  }
  if (count === 3) {
    return [
      { index: 0, className: 'col-span-2 aspect-[2/1]', more: 0 },
      { index: 1, className: 'aspect-square', more: 0 },
      { index: 2, className: 'aspect-square', more: 0 },
    ];
  }
  return [0, 1, 2, 3].map((index) => ({
    index,
    className: 'aspect-square',
    more: index === 3 ? count - 4 : 0,
  }));
}

/** The tile button's accessible name: "Open photo i of n" (1-based). Pure. */
export function albumTileLabel(index: number, count: number): string {
  return `Open photo ${index + 1} of ${count}`;
}

/**
 * The image inside one album tile. It fills the tile absolutely (object-cover),
 * so the tile's size comes from the grid, never from the image. Until the
 * presigned image arrives the tile's own bg-panel-3 shows; an own instant send
 * shows its local preview, dimmed with the upload bar while it uploads. A failed
 * or disabled presign keeps the tile with a centred image glyph (the lightbox
 * owns the retry).
 */
function AlbumTileImage({
  attachment,
  cache,
  presignEnabled,
}: {
  attachment: MessageAttachment;
  cache: PresignCache;
  presignEnabled: boolean;
}): ReactElement | null {
  const hasPreview = attachment.local?.previewUrl != null;
  const { url, failed } = useAttachmentUrl(
    attachment.assetId,
    cache,
    presignEnabled && !hasPreview,
  );
  const view = attachmentView({ attachment, presignEnabled, url, failed });
  const src = view.kind === 'image' || view.kind === 'image-local' ? view.src : null;
  const progress =
    view.kind === 'image-local'
      ? view.progress
      : view.kind === 'file'
        ? (view.progress ?? null)
        : null;
  return (
    <>
      {src !== null ? (
        <img
          src={src}
          alt={attachment.name}
          draggable={false}
          className={cn(
            'absolute inset-0 h-full w-full object-cover',
            progress !== null && 'brightness-75',
          )}
        />
      ) : view.kind === 'file' && progress === null ? (
        <span className="absolute inset-0 flex items-center justify-center text-fg-3">
          <IconImage size={22} />
        </span>
      ) : null}
      {progress !== null ? <UploadBar progress={progress} /> : null}
    </>
  );
}

/**
 * The album: every image of one message in a count-sized grid, tiles 2px apart,
 * 15px outer corners (the 18px bubble minus its 3px padding). Hook-free (the
 * per-tile presign lives in AlbumTileImage) so tests can call it directly. Each
 * tile is a real button; tapping opens the viewer at that index, and the "+N"
 * tile opens at index 3. The overlay is white on black/50, theme-independent.
 */
export function AlbumGrid({
  images,
  cache,
  presignEnabled,
  onOpen,
}: {
  images: readonly MessageAttachment[];
  cache: PresignCache;
  presignEnabled: boolean;
  onOpen: (index: number) => void;
}): ReactElement {
  const count = images.length;
  return (
    <div
      data-album={count}
      className={cn(
        albumGridClass(count),
        'w-[320px] max-w-full gap-[2px] overflow-hidden rounded-[15px]',
      )}
    >
      {albumTiles(count).map((tile) => {
        const attachment = images[tile.index] as MessageAttachment;
        return (
          <button
            key={attachment.local?.key ?? `${attachment.assetId}-${tile.index}`}
            type="button"
            aria-label={albumTileLabel(tile.index, count)}
            onClick={() => onOpen(tile.index)}
            className={cn(
              'relative block w-full cursor-zoom-in overflow-hidden bg-panel-3 [-webkit-touch-callout:none]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
              tile.className,
            )}
          >
            <AlbumTileImage attachment={attachment} cache={cache} presignEnabled={presignEnabled} />
            {tile.more > 0 ? (
              <span
                aria-hidden="true"
                className="absolute inset-0 flex items-center justify-center bg-black/50 text-[22px] font-semibold text-white"
              >
                +{tile.more}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function MessageAttachments({
  attachments,
  cache,
  presignEnabled,
  onImageClick,
  voiceSpacer,
  voice,
  album,
  caption,
}: {
  attachments: readonly MessageAttachment[];
  cache: PresignCache;
  presignEnabled: boolean;
  /**
   * Optional: tap an image to open it. `index` is the image's position in the
   * album (album mode) or in the attachment list (comments, which ignores it).
   */
  onImageClick?: ((attachment: MessageAttachment, index: number) => void) | undefined;
  /**
   * Chat: group the images into one album (AlbumGrid) with the rest below. The
   * caller turns it on only when the message carries at least one image.
   */
  album?: boolean;
  /** Album mode: the caption (message text), rendered right under the album. */
  caption?: ReactNode;
  /**
   * Chat voice-only bubbles: the inline time spacer a voice note ends with, and
   * the list sits flush in the bubble (no top margin, full width).
   */
  voiceSpacer?: ReactNode;
  /** Chat voice-only bubbles: the recorded message the note belongs to. */
  voice?: VoiceContext | undefined;
}): ReactElement | null {
  if (attachments.length === 0) return null;
  if (album === true) {
    const { images, others } = splitAlbum(attachments);
    if (images.length > 0) {
      const hasBelow = caption != null || others.length > 0;
      return (
        <div data-album-block="" className="flex flex-col">
          <AlbumGrid
            images={images}
            cache={cache}
            presignEnabled={presignEnabled}
            onOpen={(index) => {
              const attachment = images[index];
              if (attachment !== undefined) onImageClick?.(attachment, index);
            }}
          />
          {hasBelow ? (
            <div className="flex flex-col items-start gap-1.5 px-[9px] pb-[5px] pt-1.5">
              {caption}
              {others.map((attachment, index) => (
                <AttachmentItem
                  key={attachment.local?.key ?? `${attachment.assetId}-${index}`}
                  attachment={attachment}
                  cache={cache}
                  presignEnabled={presignEnabled}
                />
              ))}
            </div>
          ) : null}
        </div>
      );
    }
  }
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
          onImageClick={
            onImageClick !== undefined ? () => onImageClick(attachment, index) : undefined
          }
          {...(voiceSpacer !== undefined ? { voiceSpacer } : {})}
          voice={voice}
        />
      ))}
    </div>
  );
}
