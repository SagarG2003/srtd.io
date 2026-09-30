// A recorded voice note goes to the outbox like a picked file: the Composer
// builds a local attachment (no version id yet, the recording's File, its
// length), so the bubble shows its clock at once and nothing is uploaded or
// transcribed before the queue takes it.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { voiceNoteAttachment } from '@/components/chat/Composer';
import { withOutboxBubbles } from '@/lib/chat/thread';
import { bubbleStatus } from '@/components/chat/MessageThread';
import { createOutboxSender } from '@/lib/chat/send-flow';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

const ME = '11111111-1111-4111-8111-111111111111';

describe('voice note enqueue', () => {
  it('is an instant-send attachment: empty version id, the recording, its length', () => {
    const upload = vi.fn();
    const file = new File(['ogg'], 'voice-note.webm', { type: 'audio/webm' });
    const attachment = voiceNoteAttachment(file, 4000, upload);
    expect(attachment).toMatchObject({
      assetId: '',
      name: 'voice-note.webm',
      mime: 'audio/webm',
      size: 3,
      durationMs: 4000,
    });
    expect(attachment.local?.file).toBe(file);
    expect(attachment.local?.previewUrl).toBeNull();
    expect(attachment.transcript).toBeUndefined();
    expect(upload).not.toHaveBeenCalled();
  });

  it('enqueued with the clock immediately, before any upload settles', () => {
    const upload = vi.fn(() => new Promise<never>(() => {}));
    const file = new File(['ogg'], 'voice-note.webm', { type: 'audio/webm' });
    const entry = {
      id: 'v1',
      text: '',
      local: {
        attachments: [voiceNoteAttachment(file, 4000, upload)],
        sharedPostIds: [],
        reply: null,
      },
      state: 'sending' as const,
      createdMs: 1_700_000_000_000,
    };
    const sender = createOutboxSender({
      deliver: vi.fn(),
      newTraceId: () => 't',
      onEvent: () => {},
      onChange: () => {},
      onAttemptFailed: () => {},
    });
    sender.enqueue('c1', entry);
    const [bubble] = withOutboxBubbles([], sender.entries('c1'), ME);
    expect(bubble?.state).toBe('sending');
    expect(
      bubbleStatus(bubble ?? { mine: true, state: 'sent', status: 'sent' }, { showTicks: true }),
    ).toBe('sending');
    expect(upload).toHaveBeenCalledOnce();
    sender.dispose();
  });
});

describe('T3: the composer carries the recorder peaks', () => {
  const file = new File(['ogg'], 'voice-note.webm', { type: 'audio/webm' });

  it('voiceNoteAttachment keeps peaks when the recorder captured them', () => {
    const peaks = Array.from({ length: 48 }, (_, i) => i);
    const attachment = voiceNoteAttachment(file, 4000, vi.fn(), peaks);
    expect(attachment.peaks).toEqual(peaks);
    // A copy: the recorder's array is never shared.
    expect(attachment.peaks).not.toBe(peaks);
  });

  it('no peaks (none read from the recording): the note sends exactly as before', () => {
    expect(voiceNoteAttachment(file, 4000, vi.fn())).not.toHaveProperty('peaks');
    expect(voiceNoteAttachment(file, 4000, vi.fn(), [])).not.toHaveProperty('peaks');
  });
});
