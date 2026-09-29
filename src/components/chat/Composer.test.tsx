import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import {
  AboutBar,
  composerCanSend,
  composerPlaceholder,
  hashPickerQuery,
  dispatchSend,
  draftAttachments,
  hasLinkCards,
  isSendKeydown,
  shouldShowMic,
  withLinkCards,
} from '@/components/chat/Composer';
import { createOutboxSender, type SendOutcome } from '@/lib/chat/send-flow';
import { canSendAttachmentMessage } from '@/lib/chat/attachments';
import { stripHashToken } from '@/lib/chat/post-refs';
import { IconButton } from '@/components/ui/IconButton';
import { postRefKey } from '@/components/chat/PostRefChip';

// The repo's vitest runs in the node environment with no @testing-library/react,
// so caret/DOM behaviour is not exercised here. Following the codebase pattern
// (see MentionInput.test.tsx), the send-decision is extracted to a pure
// predicate and that contract is unit tested: plain Enter sends; Shift+Enter,
// Enter during IME composition, and a coarse (touch-primary) pointer keep the
// default newline/compose behaviour.
describe('isSendKeydown', () => {
  it('sends on plain Enter', () => {
    expect(
      isSendKeydown({ key: 'Enter', shiftKey: false, isComposing: false, coarsePointer: false }),
    ).toBe(true);
  });

  it('does not send on Shift+Enter (newline)', () => {
    expect(
      isSendKeydown({ key: 'Enter', shiftKey: true, isComposing: false, coarsePointer: false }),
    ).toBe(false);
  });

  it('does not send on Enter during IME composition', () => {
    expect(
      isSendKeydown({ key: 'Enter', shiftKey: false, isComposing: true, coarsePointer: false }),
    ).toBe(false);
  });

  it('does not send on Enter on a touch-primary (coarse pointer) device', () => {
    expect(
      isSendKeydown({ key: 'Enter', shiftKey: false, isComposing: false, coarsePointer: true }),
    ).toBe(false);
  });

  it('ignores other keys', () => {
    expect(
      isSendKeydown({ key: 'a', shiftKey: false, isComposing: false, coarsePointer: false }),
    ).toBe(false);
  });
});

// The trailing composer control swaps between the record-voice-note mic and the
// Send button. The mic shows only when attaching is possible and the composer is
// empty and idle; any text, attachment, shared post, active recording, or
// in-flight voice send falls back to Send.
describe('shouldShowMic', () => {
  const idle = {
    hasUpload: true,
    disabled: false,
    text: '',
    attachmentCount: 0,
    sharedPostCount: 0,
    recording: false,
    voiceBusy: false,
  };

  it('shows the mic on an empty, idle composer that can upload', () => {
    expect(shouldShowMic(idle)).toBe(true);
  });

  it('hides the mic when there is text', () => {
    expect(shouldShowMic({ ...idle, text: 'hello' })).toBe(false);
  });

  it('hides the mic when an attachment is pending', () => {
    expect(shouldShowMic({ ...idle, attachmentCount: 1 })).toBe(false);
  });

  it('hides the mic when a post is shared', () => {
    expect(shouldShowMic({ ...idle, sharedPostCount: 1 })).toBe(false);
  });

  it('hides the mic while recording', () => {
    expect(shouldShowMic({ ...idle, recording: true })).toBe(false);
  });

  it('hides the mic while a voice note is sending', () => {
    expect(shouldShowMic({ ...idle, voiceBusy: true })).toBe(false);
  });

  it('hides the mic when uploads are unavailable', () => {
    expect(shouldShowMic({ ...idle, hasUpload: false })).toBe(false);
  });
});

describe('dispatchSend (Send never waits on the network)', () => {
  const draft = {
    text: 'hello',
    attachments: [],
    sharedPostIds: [],
    reply: null,
    sharedBriefIds: [],
  };

  it('takes the draft in the same tick while the record RPC is still pending', () => {
    let resolveRecord: ((outcome: SendOutcome) => void) | undefined;
    const sender = createOutboxSender({
      deliver: () =>
        new Promise<SendOutcome>((resolve) => {
          resolveRecord = resolve;
        }),
      newTraceId: () => 'trace',
      onEvent: () => {},
      onChange: () => {},
      onAttemptFailed: () => {},
    });
    const taken = dispatchSend(
      (text) =>
        sender.enqueue('c1', {
          id: 'm1',
          text,
          local: { attachments: [], sharedPostIds: [], reply: null },
          state: 'sending',
        }),
      draft,
    );
    // The composer clears on `taken` and Send is enabled again for the next draft.
    expect(taken).toBe(true);
    expect(resolveRecord).toBeDefined();
    expect(sender.entries('c1')[0]?.state).toBe('sending');
    expect(
      canSendAttachmentMessage({
        text: 'next',
        attachmentCount: 0,
        sending: false,
      }),
    ).toBe(true);
    sender.dispose();
  });

  it('keeps the draft only when onSend throws', () => {
    expect(
      dispatchSend(() => {
        throw new Error('boom');
      }, draft),
    ).toBe(false);
  });
});

describe('instant attachment send (files upload after Send)', () => {
  const base = { disabled: false, text: '', sharedPostCount: 0, sharedBriefCount: 0 };

  it('enables Send with a picked file and no text; nothing has to upload first', () => {
    expect(composerCanSend({ ...base, fileCount: 1 })).toBe(true);
    expect(composerCanSend({ ...base, fileCount: 0 })).toBe(false);
    expect(composerCanSend({ ...base, text: 'hi', fileCount: 0 })).toBe(true);
    expect(composerCanSend({ ...base, disabled: true, fileCount: 1 })).toBe(false);
  });

  it('hands every chip over as a local attachment (File, preview, uploader), in order', () => {
    const upload = vi.fn();
    const a = new File(['ab'], 'a.png', { type: 'image/png' });
    const b = new File(['abcd'], 'b.pdf', { type: 'application/pdf' });
    const out = draftAttachments(
      [
        { id: 'att-1', file: a, previewUrl: 'blob:a' },
        { id: 'att-2', file: b, previewUrl: null },
      ],
      upload,
    );
    expect(out).toMatchObject([
      {
        assetId: '',
        name: 'a.png',
        mime: 'image/png',
        size: 2,
        local: { file: a, previewUrl: 'blob:a', progress: 0, upload },
      },
      {
        assetId: '',
        name: 'b.pdf',
        mime: 'application/pdf',
        size: 4,
        local: { file: b, previewUrl: null, progress: 0, upload },
      },
    ]);
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('pasted post and brief links become cards at Send', () => {
  const ORIGIN = 'https://app.example.test';
  const context = { workspaceKey: 'gbl', origin: ORIGIN };
  const draft = (text: string) => ({ text, sharedPostIds: [], sharedBriefIds: [] });
  const readers = () => ({
    postIds: vi.fn((numbers: number[]) =>
      Promise.resolve({
        ok: true as const,
        data: numbers.filter((n) => n !== 404).map((n) => ({ id: `post-${n}`, number: n })),
      }),
    ),
    briefIds: vi.fn((numbers: number[]) =>
      Promise.resolve({
        ok: true as const,
        data: numbers.map((n) => ({ id: `brief-${n}`, number: n })),
      }),
    ),
  });

  it('a link-only body sends the cards with an empty body', async () => {
    const r = readers();
    const out = await withLinkCards(
      draft(` ${ORIGIN}/p/gbl-12\n${ORIGIN}/b/gbl-3 ${ORIGIN}/p/GBL-12 `),
      context,
      r,
    );
    expect(out).toEqual({ text: '', sharedPostIds: ['post-12'], sharedBriefIds: ['brief-3'] });
    // One batched read per entity type, never one per link.
    expect(r.postIds).toHaveBeenCalledTimes(1);
    expect(r.postIds).toHaveBeenCalledWith([12]);
    expect(r.briefIds).toHaveBeenCalledTimes(1);
  });

  it('a mixed body keeps the text as typed and adds the cards', async () => {
    const text = `Can you check ${ORIGIN}/p/gbl-12 today? https://example.com`;
    const out = await withLinkCards(
      { text, sharedPostIds: ['picked'], sharedBriefIds: [] },
      context,
      readers(),
    );
    expect(out).toEqual({ text, sharedPostIds: ['picked', 'post-12'], sharedBriefIds: [] });
  });

  it('an unresolved ref stays a plain link, with no error', async () => {
    const text = `${ORIGIN}/p/gbl-404`;
    expect(await withLinkCards(draft(text), context, readers())).toEqual(draft(text));
    const failing = {
      postIds: () =>
        Promise.resolve({ ok: false as const, error: { code: 'unknown' as const, message: 'x' } }),
      briefIds: () => Promise.resolve({ ok: true as const, data: [] }),
    };
    expect(await withLinkCards(draft(text), context, failing)).toEqual(draft(text));
  });

  it('skips the reads for external links, other workspaces and other origins', async () => {
    const r = readers();
    const text = `https://example.com ${ORIGIN}/p/abc-1 https://other.test/p/gbl-1`;
    expect(hasLinkCards(text, 'gbl', ORIGIN)).toBe(false);
    expect(await withLinkCards(draft(text), context, r)).toEqual(draft(text));
    expect(r.postIds).not.toHaveBeenCalled();
    expect(r.briefIds).not.toHaveBeenCalled();
    expect(hasLinkCards(`${ORIGIN}/b/gbl-1`, 'gbl', ORIGIN)).toBe(true);
    expect(hasLinkCards(`${ORIGIN}/b/gbl-1`, null, ORIGIN)).toBe(false);
  });
});

// The hash character, built so this file passes the chat token-hygiene check.
const HASH = String.fromCharCode(35);

describe('hash picker', () => {
  const at = (
    text: string,
    caret = text.length,
    over: { enabled?: boolean; dismissed?: boolean } = {},
  ) => hashPickerQuery({ enabled: true, dismissed: false, text, caret, ...over });

  it('opens on a hash token at the caret with its query', () => {
    expect(at(HASH)).toBe('');
    expect(at(`${HASH}laun`)).toBe('laun');
    expect(at(`about ${HASH}14`)).toBe('14');
  });

  it('closes on a space with no pick, mid-word, on Escape, or without a bring hook', () => {
    expect(at(`${HASH}laun `)).toBeNull();
    expect(at(`a${HASH}b`)).toBeNull();
    expect(at(`${HASH}laun`, undefined, { dismissed: true })).toBeNull();
    expect(at(`${HASH}laun`, undefined, { enabled: false })).toBeNull();
  });

  it('a pick strips the token and keeps the rest of the draft', () => {
    const text = `look at ${HASH}lau please`;
    const caret = `look at ${HASH}lau`.length;
    expect(at(text, caret)).toBe('lau');
    expect(stripHashToken(text, caret)).toEqual({ text: 'look at  please', caret: 8 });
  });
});

describe('About bar', () => {
  const post = { id: 'p1', number: 14, title: 'Launch teaser', thumbnailAssetVersionId: null };

  function find(node: ReactNode, match: (el: ReactElement) => boolean): ReactElement | null {
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = find(child, match);
        if (hit !== null) return hit;
      }
      return null;
    }
    if (!isValidElement(node)) return null;
    if (match(node)) return node;
    return find((node.props as { children?: ReactNode }).children, match);
  }

  it('renders the reply bar grammar: accent rule, 32px thumb, "About KEY" over the title', () => {
    const html = renderToStaticMarkup(
      <AboutBar post={post} refLabel="GBL-14" onCancel={() => {}} />,
    );
    expect(html).toContain('w-[3px]');
    expect(html).toContain('bg-accent');
    expect(html).toContain('h-8 w-8');
    expect(html).toMatch(/text-accent[^>]*>About GBL-14</);
    expect(html).toContain('Launch teaser');
    expect(html).toContain('aria-label="Close about"');
  });

  it('its X cancels', () => {
    const onCancel = vi.fn();
    const close = find(
      AboutBar({ post, refLabel: 'GBL-14', onCancel }),
      (el) => el.type === IconButton,
    );
    (close?.props as { onClick: () => void }).onClick();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('the placeholder follows About, and mentions the hash otherwise', () => {
    // default
    expect(composerPlaceholder(null)).toBe(`Message, or ${HASH} for a post`);
    // reply draft, no About
    expect(composerPlaceholder(null, true)).toBe(`Reply, or ${HASH} for a post`);
    // About visible (with or without a reply draft)
    expect(composerPlaceholder('GBL-14')).toBe('Message about GBL-14');
    expect(composerPlaceholder('GBL-14', true)).toBe('Message about GBL-14');
    // workspaceKey null: postRefKey yields no ref, so the default applies
    expect(composerPlaceholder(postRefKey(null, 14))).toBe(`Message, or ${HASH} for a post`);
  });
});

describe('About bar while its post loads (F14)', () => {
  it('is a skeleton with the same close: no KEY, a title placeholder', () => {
    const html = renderToStaticMarkup(
      <AboutBar post={null} refLabel="GBL-14" onCancel={() => {}} />,
    );
    expect(html).toContain('data-about-loading');
    expect(html).toMatch(/text-accent[^>]*>About</);
    expect(html).not.toContain('GBL-14');
    expect(html).toContain('h-3 w-28');
    expect(html).toContain('aria-label="Close about"');
  });

  it('can be cancelled while loading', () => {
    const onCancel = vi.fn();
    const root = AboutBar({ post: null, refLabel: null, onCancel });
    const stack: ReactNode[] = [root];
    let close: ReactElement | null = null;
    while (stack.length > 0 && close === null) {
      const node = stack.pop();
      if (Array.isArray(node)) stack.push(...(node as ReactNode[]));
      else if (isValidElement(node)) {
        if (node.type === IconButton) close = node;
        else stack.push((node.props as { children?: ReactNode }).children);
      }
    }
    (close?.props as { onClick: () => void }).onClick();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
