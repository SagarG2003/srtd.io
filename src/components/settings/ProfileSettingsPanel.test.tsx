import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import type { Client, Result, UserProfileUpdateArgs } from '@srtdio/rpc';
import {
  PHOTO_VIEW_INITIAL,
  profileErrorMessage,
  settlePhotoChange,
  shownPhoto,
  submitProfileChange,
  type PhotoIntent,
  type PhotoView,
} from '@/components/settings/ProfileSettingsPanel';

const client = {} as Client;
const TRACE = '01927c3e-0000-7000-8000-000000000000';
const URL_SAVED = 'https://cdn.srtd.io/u-me/old.png';
const URL_NEW = 'https://cdn.srtd.io/u-me/new.png';

function run(photo: PhotoIntent, saveResult: Result<string> = { ok: true, data: 'u-me' }) {
  const save = vi.fn<(c: Client, a: UserProfileUpdateArgs) => Promise<Result<string>>>(() =>
    Promise.resolve(saveResult),
  );
  const done = submitProfileChange({
    client,
    save,
    newTrace: () => TRACE,
    displayName: 'Asha Rao',
    designation: 'Brand Manager',
    emailOptIn: false,
    photo,
  });
  return { save, done };
}

describe('profile photo args', () => {
  it('Remove sends p_avatar_url as the empty string', async () => {
    const { save, done } = run({ kind: 'clear' });
    expect(await done).toEqual({ ok: true, data: undefined });
    expect(save).toHaveBeenCalledWith(client, {
      p_display_name: 'Asha Rao',
      p_designation: 'Brand Manager',
      p_avatar_url: '',
      p_email_opt_in: false,
      p_trace_id: TRACE,
    });
  });

  it('Save with an unchanged photo sends NULL, never the empty string', async () => {
    const { save, done } = run({ kind: 'keep' });
    await done;
    expect(save.mock.calls[0]?.[1].p_avatar_url).toBeNull();
  });

  it('a new upload sends the uploaded https URL', async () => {
    const upload = vi.fn(() =>
      Promise.resolve<Result<{ avatarUrl: string }>>({ ok: true, data: { avatarUrl: URL_NEW } }),
    );
    const { save, done } = run({ kind: 'upload', upload });
    await done;
    expect(upload).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[1].p_avatar_url).toBe(URL_NEW);
  });

  it('a failed upload never saves', async () => {
    const upload = () =>
      Promise.resolve<Result<{ avatarUrl: string }>>({
        ok: false,
        error: { code: 'unknown', message: 'Upload failed. Check your connection and retry' },
      });
    const { save, done } = run({ kind: 'upload', upload });
    expect((await done).ok).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('server error', () => {
  it('reverts the photo and shows the message', async () => {
    const { done } = run(
      { kind: 'clear' },
      { ok: false, error: { code: 'unknown', message: 'Profile write refused' } },
    );
    const result = await done;
    const previous: PhotoView = PHOTO_VIEW_INITIAL;
    const next: PhotoView = { previewUrl: null, removed: true };
    const settled = settlePhotoChange(result, previous, next);
    expect(settled.photo).toEqual(previous);
    expect(settled.error).toBe('Profile write refused');
    expect(shownPhoto(URL_SAVED, settled.photo)).toBe(URL_SAVED);
  });

  it('keeps the new photo on success', () => {
    const next: PhotoView = { previewUrl: null, removed: true };
    const settled = settlePhotoChange({ ok: true, data: undefined }, PHOTO_VIEW_INITIAL, next);
    expect(settled).toEqual({ photo: next, error: null });
    expect(shownPhoto(URL_SAVED, settled.photo)).toBeNull();
  });

  it('turns raw codes and multi-line errors into one readable line', () => {
    expect(profileErrorMessage('invalid_payload')).toBe('Could not save your profile. Try again');
    expect(profileErrorMessage('')).toBe('Could not save your profile. Try again');
    expect(profileErrorMessage('Bad thing\nstack here')).toBe('Bad thing');
  });
});

describe('shownPhoto', () => {
  it('prefers a staged preview, then removal, then the saved url', () => {
    expect(shownPhoto(URL_SAVED, { previewUrl: 'blob:x', removed: false })).toBe('blob:x');
    expect(shownPhoto(URL_SAVED, { previewUrl: null, removed: true })).toBeNull();
    expect(shownPhoto(URL_SAVED, PHOTO_VIEW_INITIAL)).toBe(URL_SAVED);
    expect(shownPhoto(null, PHOTO_VIEW_INITIAL)).toBeNull();
    expect(shownPhoto('', PHOTO_VIEW_INITIAL)).toBeNull();
  });
});
