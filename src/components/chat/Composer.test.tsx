import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  composerCanSend,
  dispatchSend,
  draftAttachments,
  isSendKeydown,
  shouldShowMic,
} from '@/components/chat/Composer';
import { createOutboxSender, type SendOutcome } from '@/lib/chat/send-flow';
import { canSendAttachmentMessage } from '@/lib/chat/attachments';

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
