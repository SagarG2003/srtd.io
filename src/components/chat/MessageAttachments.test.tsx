import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PresignCache, type PresignDeps } from '@/lib/asset-presign';
import { MessageAttachments, attachmentView } from '@/components/chat/MessageAttachments';
import type { MessageAttachment } from '@/lib/chat/attachments';

// Realistic asset_versions.id fixtures: the render layer must presign the VERSION
// id (asset-read looks it up in asset_versions), so a future asset-vs-version
// regression that carried the asset id would fail the cache assertions below.
const IMG_VERSION = '11111111-1111-4111-8111-111111111111';
const FILE_VERSION = '22222222-2222-4222-8222-222222222222';
const AUDIO_VERSION = '33333333-3333-4333-8333-333333333333';

const IMAGE: MessageAttachment = { assetId: IMG_VERSION, name: 'photo.png', mime: 'image/png' };
const FILE: MessageAttachment = {
  assetId: FILE_VERSION,
  name: 'brief.pdf',
  mime: 'application/pdf',
};
const AUDIO: MessageAttachment = {
  assetId: AUDIO_VERSION,
  name: 'note.webm',
  mime: 'audio/webm',
  transcript: 'hello there',
};

describe('attachmentView render dispatch', () => {
  it('renders a resolved image as a thumbnail (src + alt)', () => {
    expect(
      attachmentView({
        attachment: IMAGE,
        presignEnabled: true,
        url: 'https://signed/img',
        failed: false,
      }),
    ).toEqual({ kind: 'image', src: 'https://signed/img', alt: 'photo.png' });
  });

  it('shows the image shimmer while the presign is still in flight', () => {
    expect(
      attachmentView({ attachment: IMAGE, presignEnabled: true, url: null, failed: false }),
    ).toEqual({ kind: 'image-pending', alt: 'photo.png' });
  });

  it('falls back to a file chip for an image when presign failed or is disabled', () => {
    expect(
      attachmentView({ attachment: IMAGE, presignEnabled: true, url: null, failed: true }),
    ).toEqual({ kind: 'file', name: 'photo.png', url: null });
    expect(
      attachmentView({ attachment: IMAGE, presignEnabled: false, url: null, failed: false }),
    ).toEqual({ kind: 'file', name: 'photo.png', url: null });
  });

  it('renders a non-image as a file chip, with an Open link once the url resolves', () => {
    expect(
      attachmentView({ attachment: FILE, presignEnabled: true, url: null, failed: false }),
    ).toEqual({ kind: 'file', name: 'brief.pdf', url: null });
    // A non-null url is the chip's Open link target.
    expect(
      attachmentView({
        attachment: FILE,
        presignEnabled: true,
        url: 'https://signed/pdf',
        failed: false,
      }),
    ).toEqual({ kind: 'file', name: 'brief.pdf', url: 'https://signed/pdf' });
  });

  it('renders an audio attachment as a voice note with its transcript', () => {
    expect(
      attachmentView({
        attachment: AUDIO,
        presignEnabled: true,
        url: 'https://signed/audio',
        failed: false,
      }),
    ).toEqual({
      kind: 'audio',
      url: 'https://signed/audio',
      name: 'note.webm',
      transcript: 'hello there',
    });
  });

  it('passes the stored durationMs through to the voice note', () => {
    expect(
      attachmentView({
        attachment: { ...AUDIO, durationMs: 18_000 },
        presignEnabled: true,
        url: null,
        failed: false,
      }),
    ).toMatchObject({ kind: 'audio', durationMs: 18_000 });
  });

  it('keeps the voice note while the presign is still in flight (url null)', () => {
    expect(
      attachmentView({ attachment: AUDIO, presignEnabled: true, url: null, failed: false }),
    ).toEqual({ kind: 'audio', url: null, name: 'note.webm', transcript: 'hello there' });
  });

  it('falls back to a file chip for audio when presign failed or is disabled', () => {
    expect(
      attachmentView({ attachment: AUDIO, presignEnabled: true, url: null, failed: true }),
    ).toEqual({ kind: 'file', name: 'note.webm', url: null });
    expect(
      attachmentView({ attachment: AUDIO, presignEnabled: false, url: null, failed: false }),
    ).toEqual({ kind: 'file', name: 'note.webm', url: null });
  });
});

/** A PresignCache whose only injected dependency, the fetcher, is a spy. */
function spiedCache() {
  const fetcher = vi.fn<PresignDeps['fetcher']>(
    async () =>
      new Response(
        JSON.stringify({ url: 'https://signed/x', expires_at: '2999-01-01T00:00:00Z' }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
  );
  const deps: PresignDeps = {
    endpoint: 'https://asset-read',
    getAccessToken: async () => 'tok',
    fetcher,
  };
  return { cache: new PresignCache(deps), fetcher };
}

/** The asset_version_id sent in a presign request body (the cache's POST). */
function presignedVersionId(init: RequestInit | undefined): unknown {
  const parsed = JSON.parse((init?.body as string | undefined) ?? '{}') as {
    asset_version_id?: unknown;
  };
  return parsed.asset_version_id;
}

describe('presign through the shared cache (what the render layer asks of it)', () => {
  it('presigns each attachment once, keyed on the VERSION id', async () => {
    const { cache, fetcher } = spiedCache();

    // The renderer resolves each attachment's assetId (the version id) via the cache.
    await Promise.all([IMAGE, FILE].map((attachment) => cache.resolve(attachment.assetId)));

    expect(fetcher).toHaveBeenCalledTimes(2);
    const ids = fetcher.mock.calls.map((call) => presignedVersionId(call[1]));
    expect(ids).toEqual([IMG_VERSION, FILE_VERSION]);
  });

  it('never presigns the same version id twice (cache dedupe)', async () => {
    const { cache, fetcher } = spiedCache();

    // Two attachments referencing the same version id (e.g. re-render or repeat).
    await Promise.all([IMG_VERSION, IMG_VERSION].map((id) => cache.resolve(id)));

    expect(fetcher).toHaveBeenCalledOnce();
    expect(presignedVersionId(fetcher.mock.calls[0]?.[1])).toBe(IMG_VERSION);
  });
});

describe('instant send tile (local preview + upload progress)', () => {
  const file = new File(['abc'], 'photo.png', { type: 'image/png' });
  const local = (progress: number, assetId = ''): MessageAttachment => ({
    assetId,
    name: 'photo.png',
    mime: 'image/png',
    size: 3,
    local: { key: 'local-1', file, previewUrl: 'blob:preview', progress },
  });

  it('renders the local preview with its progress while uploading', () => {
    expect(
      attachmentView({ attachment: local(0.4), presignEnabled: true, url: null, failed: false }),
    ).toEqual({ kind: 'image-local', src: 'blob:preview', alt: 'photo.png', progress: 0.4 });
  });

  it('keeps the local preview after the version id lands (never swaps to the presigned url)', () => {
    expect(
      attachmentView({
        attachment: local(1, IMG_VERSION),
        presignEnabled: true,
        url: 'https://signed/img',
        failed: false,
      }),
    ).toEqual({ kind: 'image-local', src: 'blob:preview', alt: 'photo.png', progress: null });
  });

  it('a non-image file shows its chip with the bar and no Open link until uploaded', () => {
    const pdf: MessageAttachment = {
      assetId: '',
      name: 'brief.pdf',
      mime: 'application/pdf',
      local: { key: 'local-2', file, previewUrl: null, progress: 0.5 },
    };
    expect(
      attachmentView({ attachment: pdf, presignEnabled: true, url: null, failed: false }),
    ).toEqual({ kind: 'file', name: 'brief.pdf', url: null, progress: 0.5 });
  });

  function render(attachment: MessageAttachment) {
    const { cache, fetcher } = spiedCache();
    const html = renderToStaticMarkup(
      <MessageAttachments attachments={[attachment]} cache={cache} presignEnabled />,
    );
    return { html, fetcher };
  }

  it('the tile is dimmed with a thin white bar (width = progress) while uploading', () => {
    const { html, fetcher } = render(local(0.4));
    expect(html).toContain('src="blob:preview"');
    expect(html).toContain('brightness-75');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('h-[3px]');
    expect(html).toContain('bg-white/35');
    expect(html).toContain('width:40%');
    expect(html).toContain('transition-[width]');
    // The local preview never presigns.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('is plain once uploaded: same preview, no dim, no bar', () => {
    const { html } = render(local(1, IMG_VERSION));
    expect(html).toContain('src="blob:preview"');
    expect(html).not.toContain('brightness-75');
    expect(html).not.toContain('progressbar');
  });
});
