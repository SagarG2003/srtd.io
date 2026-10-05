// Magic-byte verification: confirm a file's leading bytes match the MIME type
// the client claims, so a renamed executable cannot ride in under an allowed
// type. This checks file signatures only; it never parses container internals.
// The ZIP signature is the first gate for Office Open XML (docx/xlsx/pptx); the
// archive itself is opened and checked in file-safety.ts.

import { normalizeMime } from './mime';

/** True when `bytes` starts with the given signature. */
function startsWith(bytes: Uint8Array, sig: readonly number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) {
    if (bytes[i] !== sig[i]) return false;
  }
  return true;
}

/** True when `bytes` carries `sig` starting at `offset`. */
function matchesAt(bytes: Uint8Array, offset: number, sig: readonly number[]): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47];
const GIF = [0x47, 0x49, 0x46]; // "GIF"
const RIFF = [0x52, 0x49, 0x46, 0x46]; // "RIFF" at offset 0
const WEBP = [0x57, 0x45, 0x42, 0x50]; // "WEBP" at offset 8
const PDF = [0x25, 0x50, 0x44, 0x46]; // "%PDF"
const FTYP = [0x66, 0x74, 0x79, 0x70]; // "ftyp" box type at offset 4 (MP4/MOV)
const ZIP = [0x50, 0x4b, 0x03, 0x04]; // ZIP local file header (covers OOXML)
// OLE2 compound file (legacy doc/xls/ppt, and password-protected Office files).
const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const EBML = [0x1a, 0x45, 0xdf, 0xa3]; // Matroska/EBML header (covers webm)
const ID3 = [0x49, 0x44, 0x33]; // "ID3" tag prefixing many MP3 files
const MPEG_FRAME_SYNC = new Set<number>([0xfb, 0xf3, 0xf2]); // 2nd byte after 0xff

/** RIFF....WEBP container. */
function isWebp(bytes: Uint8Array): boolean {
  return startsWith(bytes, RIFF) && matchesAt(bytes, 8, WEBP);
}

/** MP4/MOV: an `ftyp` box type sits at offset 4 (after the 4-byte box size). */
function isFtyp(bytes: Uint8Array): boolean {
  return matchesAt(bytes, 4, FTYP);
}

/**
 * MPEG audio: either an "ID3" tag or a raw frame sync (0xFF followed by a byte
 * whose top bits mark an MPEG-1/2 Layer III frame).
 */
function isMpegAudio(bytes: Uint8Array): boolean {
  if (startsWith(bytes, ID3)) return true;
  return bytes.length >= 2 && bytes[0] === 0xff && MPEG_FRAME_SYNC.has(bytes[1] as number);
}

/** True for a ZIP archive (local file header first). */
export function isZipSignature(bytes: Uint8Array): boolean {
  return startsWith(bytes, ZIP);
}

/** True for an OLE2 compound file, whatever type the client claimed. */
export function isOle2Signature(bytes: Uint8Array): boolean {
  return startsWith(bytes, CFB);
}

/**
 * True when the file's leading bytes are consistent with `claimedMime`. The MIME
 * type is expected to already be on the allowlist; an unmapped type is not
 * blocked here (it cannot reach this point past the allowlist check anyway).
 */
export function verifyMagicBytes(bytes: Uint8Array, claimedMime: string): boolean {
  switch (normalizeMime(claimedMime)) {
    case 'image/jpeg':
      return startsWith(bytes, JPEG);
    case 'image/png':
      return startsWith(bytes, PNG);
    case 'image/gif':
      return startsWith(bytes, GIF);
    case 'image/webp':
      return isWebp(bytes);
    case 'video/mp4':
    case 'video/quicktime':
    case 'audio/mp4':
      // Audio MP4 shares the ISO-BMFF `ftyp` box with video; the brand is not
      // distinguished by bytes alone.
      return isFtyp(bytes);
    case 'audio/webm':
      // WebM is a Matroska profile; the EBML header is shared with video/webm.
      return startsWith(bytes, EBML);
    case 'audio/mpeg':
      return isMpegAudio(bytes);
    case 'application/pdf':
      return startsWith(bytes, PDF);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      // OOXML files are ZIP archives; the ZIP signature is sufficient.
      return startsWith(bytes, ZIP);
    default:
      return true;
  }
}
