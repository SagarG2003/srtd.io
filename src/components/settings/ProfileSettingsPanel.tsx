// Settings -> Profile editor. Unlike onboarding, the photo is OPTIONAL here: the
// user can rename or re-title without re-uploading. So this panel does NOT reuse
// submit-profile-setup (which hard-requires a file); it orchestrates its own
// upload-then-save, only uploading when the cropper actually holds a new photo and
// otherwise sending NULL for the photo (the proc keeps the current one). The email
// preference is passed through unchanged because there is no toggle on this screen.
//
// The photo carries a camera badge that opens the shared PhotoOptionsSheet ("Your
// photo"). A picked file is staged in the AvatarCropper and saved through the same
// pipeline as before (crop, uploadAvatarFile, user_profile_update). Remove photo
// sends '' for the photo, which the proc treats as clear; only Remove sends ''.
// Every change refetches the shared profile store, so the header avatar follows.
//
// Network goes through the same tested helpers as onboarding (uploadAvatarFile +
// the @srtdio/rpc userProfileUpdate wrapper); colors are tokens only so light/dark
// parity is automatic.

import { useEffect, useRef, useState } from 'react';
import type { Client, Result, UserProfileUpdateArgs } from '@srtdio/rpc';
import { userProfileUpdate } from '@srtdio/rpc';
import { AvatarCropper, type AvatarCropperHandle } from '@/components/onboarding/AvatarCropper';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { IconCamera } from '@/components/ui/icons';
import { Input } from '@/components/ui/Input';
import { PhotoOptionsSheet } from '@/components/ui/PhotoOptionsSheet';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { uploadAvatarFile } from '@/lib/avatar-upload';
import { useCurrentProfile } from '@/lib/use-current-profile';

/** What a save does to the photo: leave it, replace it, or clear it. */
export type PhotoChange = { kind: 'keep' } | { kind: 'set'; url: string } | { kind: 'clear' };

/** p_avatar_url for a change: NULL keeps the current photo, '' clears it. Pure. */
export function avatarArg(change: PhotoChange): string | null {
  if (change.kind === 'keep') return null;
  if (change.kind === 'clear') return '';
  return change.url;
}

/** The user_profile_update args for one save. Pure. */
export function profileUpdateArgs(input: {
  displayName: string;
  designation: string;
  emailOptIn: boolean;
  photo: PhotoChange;
  traceId: string;
}): UserProfileUpdateArgs {
  return {
    p_display_name: input.displayName,
    // The proc treats a blank designation as leave-unchanged, matching the
    // null intent; the generated arg type is a plain string, so blank stays ''.
    p_designation: input.designation,
    // The generated arg is `string`, but the proc takes NULL to keep the photo.
    p_avatar_url: avatarArg(input.photo) as string,
    p_email_opt_in: input.emailOptIn,
    p_trace_id: input.traceId,
  };
}

/** How the photo is sourced for a save: keep, clear, or upload a staged file. */
export type PhotoIntent =
  | { kind: 'keep' }
  | { kind: 'clear' }
  | { kind: 'upload'; upload: () => Promise<Result<{ avatarUrl: string }>> };

/**
 * Upload (when a new photo is staged) then save. Never throws; the first failing
 * step's error comes back. Dependencies are injected so it runs without a DOM.
 */
export async function submitProfileChange(deps: {
  client: Client;
  save: typeof userProfileUpdate;
  newTrace: () => string;
  displayName: string;
  designation: string;
  emailOptIn: boolean;
  photo: PhotoIntent;
}): Promise<Result<void>> {
  let change: PhotoChange = { kind: 'keep' };
  if (deps.photo.kind === 'clear') change = { kind: 'clear' };
  if (deps.photo.kind === 'upload') {
    const up = await deps.photo.upload();
    if (!up.ok) return up;
    change = { kind: 'set', url: up.data.avatarUrl };
  }
  const saved = await deps.save(
    deps.client,
    profileUpdateArgs({
      displayName: deps.displayName,
      designation: deps.designation,
      emailOptIn: deps.emailOptIn,
      photo: change,
      traceId: deps.newTrace(),
    }),
  );
  if (!saved.ok) return saved;
  return { ok: true, data: undefined };
}

/** The panel's local photo override on top of the loaded avatar_url. */
export interface PhotoView {
  /** Object URL of a staged (not yet saved) photo. */
  previewUrl: string | null;
  /** The photo was removed here; show initials until the refetch lands. */
  removed: boolean;
}

export const PHOTO_VIEW_INITIAL: PhotoView = { previewUrl: null, removed: false };

const SAVE_FALLBACK = 'Could not save your profile. Try again';

/** One readable line for a server / upload error. Pure. */
export function profileErrorMessage(message: string): string {
  const line = message.split('\n')[0]?.trim() ?? '';
  if (line.length === 0 || /^[a-z_]+$/.test(line)) return SAVE_FALLBACK;
  return line;
}

/**
 * The photo view and message once a change settles: success keeps `next`; a
 * failure reverts to `previous` (the photo shown before the change) and yields
 * the one-line message. Pure.
 */
export function settlePhotoChange(
  result: Result<void>,
  previous: PhotoView,
  next: PhotoView,
): { photo: PhotoView; error: string | null } {
  if (result.ok) return { photo: next, error: null };
  return { photo: previous, error: profileErrorMessage(result.error.message) };
}

/** The src the photo shows for a loaded avatar_url and the local view. Pure. */
export function shownPhoto(avatarUrl: string | null, view: PhotoView): string | null {
  if (view.previewUrl !== null) return view.previewUrl;
  if (view.removed) return null;
  return avatarUrl !== null && avatarUrl !== '' ? avatarUrl : null;
}

export function ProfileSettingsPanel(): React.ReactElement {
  const newTrace = useNewTrace();
  const { profile, loading, error, refetch } = useCurrentProfile();
  const cropperRef = useRef<AvatarCropperHandle>(null);

  const [name, setName] = useState('');
  const [designation, setDesignation] = useState('');
  const [photoView, setPhotoView] = useState<PhotoView>(PHOTO_VIEW_INITIAL);
  // A new photo sits in the cropper waiting for Save (drives upload + cropper UI).
  const [staged, setStaged] = useState(false);
  const [photoSheetOpen, setPhotoSheetOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Prefill once the profile loads (and whenever a refetch lands a new row).
  useEffect(() => {
    if (profile === null) return;
    setName(profile.display_name);
    setDesignation(profile.designation ?? '');
  }, [profile]);

  const trimmedName = name.trim();
  const canSave = !loading && profile !== null && !submitting && trimmedName.length >= 1;

  function uploadStaged(): Promise<Result<{ avatarUrl: string }>> {
    return (async () => {
      const endpoint = env.VITE_AVATAR_UPLOAD_URL;
      if (endpoint === undefined) {
        return { ok: false, error: { code: 'unknown', message: 'Photo upload is not configured' } };
      }
      const file = await cropperRef.current?.exportPng();
      if (file === null || file === undefined) {
        return {
          ok: false,
          error: { code: 'unknown', message: 'Could not read the photo. Choose it again' },
        };
      }
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      return uploadAvatarFile(file, {
        endpoint,
        token,
        fetcher: (input, init) => fetchWithTrace(input, init, newTrace()),
      });
    })();
  }

  async function runChange(input: {
    displayName: string;
    designation: string;
    photo: PhotoIntent;
    next: PhotoView;
  }): Promise<boolean> {
    if (profile === null) return false;
    const previous = photoView;
    setSubmitting(true);
    setFormError(null);
    setSaved(false);
    // Removal paints the initials right away; a failure reverts below.
    if (input.photo.kind === 'clear') setPhotoView(input.next);
    try {
      const result = await submitProfileChange({
        client: supabase,
        save: userProfileUpdate,
        newTrace,
        displayName: input.displayName,
        designation: input.designation,
        emailOptIn: profile.email_opt_in,
        photo: input.photo,
      });
      if (!result.ok) {
        logger.error('settings profile save failed', { error: result.error.message });
      }
      const settled = settlePhotoChange(
        result,
        input.photo.kind === 'upload' ? { ...previous, previewUrl: null } : previous,
        input.next,
      );
      setPhotoView(settled.photo);
      setFormError(settled.error);
      // A save settles the staged photo (saved, or reverted); a failed Remove
      // leaves whatever was staged before it untouched.
      if (input.photo.kind !== 'clear' || result.ok) setStaged(false);
      if (!result.ok) return false;
      // Propagate the new name/photo to the rest of the app (header, comments).
      refetch();
      return true;
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSave(): Promise<void> {
    if (profile === null) return;
    if (trimmedName.length < 1) {
      setFormError('Display name is required');
      return;
    }
    // Only upload when the user actually staged a new photo here.
    const upload = staged && cropperRef.current?.hasPhoto() === true;
    const ok = await runChange({
      displayName: trimmedName,
      designation: designation.trim(),
      photo: upload ? { kind: 'upload', upload: uploadStaged } : { kind: 'keep' },
      next: upload ? { previewUrl: photoView.previewUrl, removed: false } : photoView,
    });
    if (ok) setSaved(true);
  }

  function handleRemove(): void {
    if (profile === null) return;
    // Clear with the saved fields so unsaved edits are not written by Remove.
    void runChange({
      displayName: profile.display_name,
      designation: profile.designation ?? '',
      photo: { kind: 'clear' },
      next: { previewUrl: null, removed: true },
    });
  }

  if (loading) {
    return <div className="max-w-[520px] text-sm text-fg-3">Loading</div>;
  }

  if (error || profile === null) {
    return (
      <div className="max-w-[520px] flex flex-col gap-3">
        <p className="text-sm text-bad">Could not load your profile.</p>
        <div>
          <Button onClick={refetch}>Retry</Button>
        </div>
      </div>
    );
  }

  const photoSrc = shownPhoto(profile.avatar_url, photoView);

  return (
    <div className="max-w-[520px] flex flex-col gap-4">
      <div className="flex flex-col items-start gap-3">
        <div className="relative h-[112px] w-[112px]">
          <Avatar
            key={photoSrc ?? 'none'}
            size="hero"
            name={trimmedName.length > 0 ? trimmedName : profile.display_name}
            {...(photoSrc !== null ? { src: photoSrc } : {})}
          />
          <button
            type="button"
            aria-label="Change photo"
            disabled={submitting}
            onClick={() => setPhotoSheetOpen(true)}
            className="absolute -bottom-2 -right-2 grid h-11 w-11 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          >
            <span
              data-camera-badge=""
              aria-hidden="true"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-accent-fg ring-4 ring-panel"
            >
              <IconCamera size={20} />
            </span>
          </button>
        </div>
        {/* Always mounted so a picked file can be handed in; shown only while a
            new photo is staged for positioning. */}
        <div className={staged ? undefined : 'hidden'}>
          <AvatarCropper
            ref={cropperRef}
            hidePicker
            onPhotoChange={(info) => {
              setPhotoView({ previewUrl: info.previewUrl, removed: false });
              setStaged(info.hasPhoto);
              setSaved(false);
            }}
          />
        </div>
      </div>

      <PhotoOptionsSheet
        open={photoSheetOpen}
        onClose={() => setPhotoSheetOpen(false)}
        title="Your photo"
        hasPhoto={photoSrc !== null}
        onFile={(file) => {
          setFormError(null);
          cropperRef.current?.loadFile(file);
        }}
        onRemove={handleRemove}
      />

      <Field label="Display name" htmlFor="settings-display-name">
        <Input
          id="settings-display-name"
          value={name}
          maxLength={80}
          placeholder="Your name"
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }}
        />
      </Field>

      <Field label="Designation" htmlFor="settings-designation">
        <Input
          id="settings-designation"
          value={designation}
          maxLength={80}
          placeholder="e.g. Brand Manager"
          onChange={(event) => {
            setDesignation(event.target.value);
            setSaved(false);
          }}
        />
      </Field>

      {formError !== null ? <p className="text-sm text-bad">{formError}</p> : null}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="primary"
          size="lg"
          disabled={!canSave}
          onClick={() => void handleSave()}
        >
          {submitting ? 'Saving...' : 'Save profile'}
        </Button>
        {saved ? <span className="text-sm text-fg-2">Saved</span> : null}
      </div>
    </div>
  );
}
