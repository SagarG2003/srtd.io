// Group photo image prep. Applies the SAME output contract as the user avatar
// path (AvatarCropper.exportPng): a square crop exported as a 512x512 PNG via
// canvas.toBlob, which the avatar-upload worker then caps at 5 MiB and
// magic-byte checks. The group flow has no drag / zoom step, so the crop is the
// cropper's own starting placement: the photo scaled to cover the square and
// centred. No new limits are introduced here.

/** Export edge in px; matches AvatarCropper's EXPORT. */
export const GROUP_AVATAR_EXPORT_PX = 512;

/**
 * The source rectangle of a centred cover crop: the largest centred square of
 * the image. Pure, so the geometry is unit-tested without a canvas.
 */
export function centerSquare(
  width: number,
  height: number,
): { sx: number; sy: number; side: number } {
  const side = Math.min(width, height);
  return { sx: (width - side) / 2, sy: (height - side) / 2, side };
}

function loadImage(file: File): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * Centre-crop a picked or captured photo to a 512px square PNG, ready for the
 * avatar-upload worker. Null when the file is not a readable image.
 */
export async function groupAvatarPng(file: File): Promise<File | null> {
  const img = await loadImage(file);
  if (img === null || img.width === 0 || img.height === 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = GROUP_AVATAR_EXPORT_PX;
  canvas.height = GROUP_AVATAR_EXPORT_PX;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  const { sx, sy, side } = centerSquare(img.width, img.height);
  ctx.drawImage(img, sx, sy, side, side, 0, 0, GROUP_AVATAR_EXPORT_PX, GROUP_AVATAR_EXPORT_PX);
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve(blob === null ? null : new File([blob], 'avatar.png', { type: 'image/png' }));
    }, 'image/png');
  });
}
