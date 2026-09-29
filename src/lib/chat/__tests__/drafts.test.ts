import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearDraft,
  draftText,
  draftsVersion,
  EMPTY_DRAFT,
  getDraft,
  isEmptyDraft,
  resetDrafts,
  setDraft,
  stripDeletedReplies,
  subscribeDrafts,
} from '@/lib/chat/drafts';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

const A = 'chan-a';
const B = 'chan-b';

afterEach(() => resetDrafts());

describe('per-chat drafts', () => {
  it('set / get / clear per channel', () => {
    expect(getDraft(A)).toBe(EMPTY_DRAFT);
    setDraft(A, { text: 'hello', caret: 5 });
    expect(getDraft(A)).toMatchObject({ text: 'hello', caret: 5, reply: null });
    setDraft(A, { caret: 2 });
    expect(getDraft(A)).toMatchObject({ text: 'hello', caret: 2 });
    clearDraft(A);
    expect(getDraft(A)).toBe(EMPTY_DRAFT);
  });

  it("channel A's text is never returned for channel B", () => {
    setDraft(A, { text: 'for A only' });
    expect(getDraft(B).text).toBe('');
    expect(draftText(B)).toBe('');
    setDraft(B, { text: 'for B' });
    expect(getDraft(A).text).toBe('for A only');
    expect(getDraft(B).text).toBe('for B');
    clearDraft(B);
    expect(getDraft(A).text).toBe('for A only');
  });

  it('keeps the reply, cards and files with their own chat', () => {
    const quote = { id: 'm1', authorUserId: 'u', preview: 'hi' };
    setDraft(A, { reply: { authorName: 'Ana', quote } });
    expect(getDraft(A).reply?.quote.id).toBe('m1');
    expect(getDraft(B).reply).toBeNull();
    // A reply alone is still a draft; the list preview reads text only.
    expect(isEmptyDraft(getDraft(A))).toBe(false);
    expect(draftText(A)).toBe('');
  });

  it('an emptied draft drops its entry', () => {
    setDraft(A, { text: 'x' });
    setDraft(A, { text: '' });
    expect(getDraft(A)).toBe(EMPTY_DRAFT);
  });

  it('notifies listeners on a change, not on a no-op', () => {
    const listener = vi.fn();
    const off = subscribeDrafts(listener);
    const v0 = draftsVersion();
    setDraft(A, { text: 'x' });
    expect(listener).toHaveBeenCalledTimes(1);
    setDraft(A, { text: 'x' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(draftsVersion()).toBe(v0 + 1);
    off();
    setDraft(A, { text: 'y' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('edit restore', () => {
  it("leaving an edit restores the same chat's draft, never another chat's", async () => {
    const { editRestoreText } = await import('@/components/chat/Composer');
    setDraft(A, { text: 'draft in A' });
    setDraft(B, { text: 'draft in B' });
    expect(editRestoreText(A, 'saved')).toBe('draft in A');
    expect(editRestoreText(B, 'saved')).toBe('draft in B');
    clearDraft(A);
    // No draft in the map: the session's own saved text, still never B's.
    expect(editRestoreText(A, 'saved')).toBe('saved');
    expect(editRestoreText(A, undefined)).toBe('');
  });
});

describe('D1: a deleted message leaves no text in draft replies', () => {
  it('strips the quote text from every draft (any chat) that quotes it and marks it deleted', () => {
    setDraft(A, {
      text: 'my reply',
      reply: { authorName: 'Asha', quote: { id: 'm1', authorUserId: 'p', preview: 'secret' } },
    });
    setDraft(B, {
      reply: { authorName: 'Ravi', quote: { id: 'm2', authorUserId: 'p', preview: 'fine' } },
    });
    const before = draftsVersion();
    stripDeletedReplies(['m1']);
    expect(getDraft(A).reply).toEqual({
      authorName: 'Asha',
      quote: { id: 'm1', authorUserId: 'p', preview: '' },
      deleted: true,
    });
    expect(getDraft(A).text).toBe('my reply');
    expect(getDraft(B).reply?.quote.preview).toBe('fine');
    expect(draftsVersion()).toBe(before + 1);
    // Idempotent: nothing left to strip, no bump.
    stripDeletedReplies(['m1']);
    expect(draftsVersion()).toBe(before + 1);
  });
});
