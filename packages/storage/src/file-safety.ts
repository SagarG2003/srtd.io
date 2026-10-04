// Upload file-safety rules, applied after the MIME allowlist and the
// magic-byte check. Everything here is a pure inspection of the raw bytes and
// the client-supplied filename; nothing is stored or rewritten.
//
//   1. Filename: no executable or script extension in ANY dot segment
//      (invoice.pdf.exe), no control or bidi-override characters, and the final
//      extension (when it is a known one) must belong to the declared MIME type.
//   2. OLE2 compound files are refused whatever their claimed type: they cover
//      legacy doc/xls/ppt and password-protected Office files.
//   3. PDF: an /Encrypt dictionary means the file cannot be inspected; refused.
//   4. Office Open XML: the ZIP central directory is read and every entry is
//      inflated under hard caps (see ZIP_LIMITS). The package must carry
//      [Content_Types].xml and the main part for its claimed type, and may not
//      carry macros (vbaProject.bin or a macroEnabled content type), encrypted
//      entries, OLE objects, or any embedded archive other than a docx, xlsx or
//      pptx, which is checked by the same rules one level deep only.

import { BLOCKED_MIME_TYPES, EXTENSIONS_BY_MIME, normalizeMime } from './mime';
import { isOle2Signature, isZipSignature } from './magic-bytes';

/** Why a file was refused. Each maps to one plain-language message. */
export type FileSafetyCode =
  | 'blocked_type'
  | 'mime_mismatch'
  | 'encrypted_file'
  | 'embedded_content'
  | 'archive_limits';

export const FILE_SAFETY_MESSAGES: Readonly<Record<FileSafetyCode, string>> = {
  blocked_type: "This file type isn't allowed",
  mime_mismatch: "File contents don't match the file type",
  encrypted_file: "Password-protected files can't be shared",
  embedded_content: "This file contains embedded content that can't be checked.",
  archive_limits: 'This file is too complex to check',
};

export type FileSafetyResult = { ok: true } | { ok: false; code: FileSafetyCode; message: string };

/** Caps for any ZIP-based upload, counted across the package and its embeds. */
export const ZIP_LIMITS = {
  /** Total uncompressed bytes across every entry: 500 MiB. */
  maxTotalUncompressedBytes: 500 * 1024 * 1024,
  /** Entries across the package and any embedded package. */
  maxEntries: 10_000,
  /** Uncompressed : compressed, per entry and for the whole upload. */
  maxCompressionRatio: 1000,
  /** Embedded docx/xlsx/pptx are inspected; anything nested inside them is refused. */
  maxEmbedDepth: 1,
} as const;

/**
 * Extensions refused in any dot segment of a filename: executables, scripts,
 * installers, shortcuts, markup the browser runs, and macro-enabled Office.
 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set(
  [
    // Windows executables, installers, shortcuts.
    'exe scr com pif cpl msi msp mst dll sys drv ocx bat cmd hta lnk reg scf inf url msc',
    'gadget chm application appref-ms appx msix appxbundle msixbundle',
    // Scripts.
    'js jse mjs cjs vbs vbe wsf wsh wsc ps1 psm1 psd1 ps1xml sh bash zsh csh ksh command',
    'py pyc pyw pl rb php asp aspx jsp cgi applescript scpt',
    // Other platforms' executables, packages and disk images.
    'jar app dmg pkg apk aab ipa xapk deb rpm bin elf dylib iso vhd vhdx',
    // Markup a browser executes.
    'html htm xhtml xht shtml mht mhtml svg svgz',
    // Macro-enabled and add-in Office.
    'docm dotm xlsm xltm xlam xla xll pptm potm ppsm ppam sldm',
  ]
    .join(' ')
    .split(' '),
);

/**
 * Extensions recognized as naming a file type. A final extension outside this
 * set (e.g. "Report v2.1", "Meeting 10.30am") is treated as part of the name,
 * not as a type claim. Built from every allowed and blocked extension plus the
 * common types that would be a mismatch for any allowed MIME.
 */
const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  ...Object.values(EXTENSIONS_BY_MIME).flat(),
  ...BLOCKED_EXTENSIONS,
  ...[
    'doc dot xls xlt xlsb ppt pot pps rtf odt ods odp txt csv tsv json xml md',
    'dotx xltx potx ppsx zip rar 7z gz tgz tar bz2 xz',
    'heic heif avif tif tiff bmp ico psd ai eps raw dng',
    'mkv avi wmv flv mpg mpeg 3gp wav flac ogg oga opus aac key pages numbers',
  ]
    .join(' ')
    .split(' '),
]);

/**
 * Inclusive code-point ranges refused in a filename: C0/C1 controls and the
 * bidi embedding/override/isolate controls that reorder text to disguise an
 * extension ("invoice<RLO>fdp.exe"). Joiners (ZWJ/ZWNJ, used by emoji and
 * Indic/Persian text) and plain direction marks stay allowed.
 */
const UNSAFE_NAME_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

function hasUnsafeNameChar(name: string): boolean {
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (UNSAFE_NAME_RANGES.some(([low, high]) => code >= low && code <= high)) return true;
  }
  return false;
}

function refuse(code: FileSafetyCode): FileSafetyResult {
  return { ok: false, code, message: FILE_SAFETY_MESSAGES[code] };
}

const OK: FileSafetyResult = { ok: true };

/** Basename of a client filename, NFKC-normalized and lowercased. */
function normalizeName(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? '';
  return base.normalize('NFKC').toLowerCase();
}

/** Dot segments after the first, each trimmed of the spaces and dots Windows drops. */
function extensionSegments(name: string): string[] {
  return name
    .split('.')
    .slice(1)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
}

/**
 * Filename rules: refuse unsafe characters and any blocked extension segment;
 * a known final extension must belong to the declared MIME type. A name with no
 * recognized extension is allowed (the signature check already matched).
 */
export function checkFilename(filename: string, mimeType: string): FileSafetyResult {
  if (hasUnsafeNameChar(filename)) {
    return refuse('blocked_type');
  }
  const segments = extensionSegments(normalizeName(filename));
  if (segments.some((segment) => BLOCKED_EXTENSIONS.has(segment))) {
    return refuse('blocked_type');
  }
  const last = segments.at(-1);
  if (last === undefined || !KNOWN_EXTENSIONS.has(last)) {
    return OK;
  }
  const mime = normalizeMime(mimeType);
  const allowed = (EXTENSIONS_BY_MIME as Readonly<Record<string, readonly string[]>>)[mime];
  if (allowed === undefined || !allowed.includes(last)) {
    return refuse('mime_mismatch');
  }
  return OK;
}

/** Index of `needle` in `haystack` at or after `from`, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  const last = haystack.length - needle.length;
  outer: for (let i = from; i <= last; i += 1) {
    if (haystack[i] !== first) continue;
    for (let j = 1; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const utf16le = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) out[i * 2] = text.charCodeAt(i);
  return out;
};

const OLE_ENCRYPTED_PACKAGE = utf16le('EncryptedPackage');

/** PDF whitespace and delimiters end a name token (ISO 32000 7.2.2). */
const PDF_NAME_TERMINATORS: ReadonlySet<number> = new Set([
  0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20, 0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25,
]);
/** Longer than any spelling of /Encrypt, even with every byte #-escaped. */
const PDF_NAME_SCAN = 24;

function hexValue(byte: number | undefined): number {
  if (byte === undefined) return -1;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return -1;
}

/**
 * True when the PDF carries an /Encrypt entry. Every name token is decoded,
 * including #xx escapes, so "/Encr#79pt" is caught; "/EncryptMetadata" is not
 * a match.
 */
export function isEncryptedPdf(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 0x2f) continue;
    let name = '';
    let j = i + 1;
    while (j < bytes.length && name.length <= PDF_NAME_SCAN) {
      const byte = bytes[j] as number;
      if (PDF_NAME_TERMINATORS.has(byte)) break;
      if (byte === 0x23) {
        const hi = hexValue(bytes[j + 1]);
        const lo = hexValue(bytes[j + 2]);
        if (hi >= 0 && lo >= 0) {
          name += String.fromCharCode(hi * 16 + lo);
          j += 3;
          continue;
        }
      }
      name += String.fromCharCode(byte);
      j += 1;
    }
    if (name === 'Encrypt') return true;
  }
  return false;
}

/** OLE2 files are refused; a password-protected Office file gets its own copy. */
function checkOle2(bytes: Uint8Array): FileSafetyResult {
  return indexOfBytes(bytes, OLE_ENCRYPTED_PACKAGE) !== -1
    ? refuse('encrypted_file')
    : refuse('blocked_type');
}

// ---------------------------------------------------------------------------
// ZIP reading (central directory first, then each entry inflated under caps).
// ---------------------------------------------------------------------------

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const EOCD_SEARCH = EOCD_MIN + 0xffff;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const METHOD_AES = 99;

interface ZipEntry {
  name: string;
  /** Raw name bytes from the central directory, compared to the local header. */
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

type ZipRead =
  | { ok: true; entries: ZipEntry[]; cdOffset: number }
  | { ok: false; code: FileSafetyCode };

function u16(view: DataView, at: number): number {
  return view.getUint16(at, true);
}
function u32(view: DataView, at: number): number {
  return view.getUint32(at, true);
}

/** Parse the central directory. Any structural oddity reads as a mismatch. */
function readCentralDirectory(bytes: Uint8Array): ZipRead {
  const bad: ZipRead = { ok: false, code: 'mime_mismatch' };
  if (bytes.length < EOCD_MIN) return bad;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  const stop = Math.max(0, bytes.length - EOCD_SEARCH);
  for (let i = bytes.length - EOCD_MIN; i >= stop; i -= 1) {
    if (u32(view, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return bad;
  // ZIP64 and split archives are never needed under the 100 MiB upload cap.
  if (eocd >= 20 && u32(view, eocd - 20) === SIG_ZIP64_LOCATOR) return bad;
  if (u16(view, eocd + 4) !== 0 || u16(view, eocd + 6) !== 0) return bad;

  const count = u16(view, eocd + 10);
  if (count !== u16(view, eocd + 8)) return bad;
  const cdSize = u32(view, eocd + 12);
  const cdOffset = u32(view, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return bad;
  if (cdOffset + cdSize > eocd) return bad;
  if (count > ZIP_LIMITS.maxEntries) return { ok: false, code: 'archive_limits' };

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const entries: ZipEntry[] = [];
  let at = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > cdOffset + cdSize || u32(view, at) !== SIG_CENTRAL) return bad;
    const nameLen = u16(view, at + 28);
    const extraLen = u16(view, at + 30);
    const commentLen = u16(view, at + 32);
    const entry: ZipEntry = {
      flags: u16(view, at + 8),
      method: u16(view, at + 10),
      compressedSize: u32(view, at + 20),
      uncompressedSize: u32(view, at + 24),
      localOffset: u32(view, at + 42),
      name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen)),
      nameBytes: bytes.subarray(at + 46, at + 46 + nameLen),
    };
    if (
      entry.compressedSize === 0xffffffff ||
      entry.uncompressedSize === 0xffffffff ||
      entry.localOffset === 0xffffffff
    ) {
      return bad;
    }
    entries.push(entry);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, entries, cdOffset };
}

/** Shared budget for the outer package and everything embedded in it. */
interface ZipBudget {
  entries: number;
  uncompressedBytes: number;
}

type Inflated =
  | { ok: true; head: Uint8Array; body: Uint8Array | null }
  | { ok: false; code: FileSafetyCode };

const HEAD_BYTES = 8;

/**
 * Inflate one entry's data, counting output as it streams. More output than
 * the central directory declared (a lying header) is refused as over the caps.
 * Only the first bytes are kept unless `keep` is set.
 */
async function inflateEntry(entry: ZipEntry, data: Uint8Array, keep: boolean): Promise<Inflated> {
  if (entry.method === METHOD_STORED) {
    if (data.length !== entry.uncompressedSize) return { ok: false, code: 'mime_mismatch' };
    return { ok: true, head: data.subarray(0, HEAD_BYTES), body: keep ? data : null };
  }

  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const written = writer
    .write(data.buffer instanceof ArrayBuffer ? (data as Uint8Array<ArrayBuffer>) : data.slice())
    .then(() => writer.close())
    .catch(() => undefined);
  const reader = stream.readable.getReader();
  // The declared size is already capped, so the kept buffer is sized once.
  const body = keep ? new Uint8Array(entry.uncompressedSize) : null;
  const head = new Uint8Array(HEAD_BYTES);
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total < HEAD_BYTES) {
        head.set(value.subarray(0, HEAD_BYTES - total), total);
      }
      total += value.byteLength;
      if (total > entry.uncompressedSize) {
        await reader.cancel().catch(() => undefined);
        await written;
        return { ok: false, code: 'archive_limits' };
      }
      if (body !== null) body.set(value, total - value.byteLength);
    }
  } catch {
    await written;
    return { ok: false, code: 'mime_mismatch' };
  }
  await written;
  if (total !== entry.uncompressedSize) return { ok: false, code: 'mime_mismatch' };

  return { ok: true, head: head.subarray(0, Math.min(total, HEAD_BYTES)), body };
}

// ---------------------------------------------------------------------------
// Office Open XML rules.
// ---------------------------------------------------------------------------

type OoxmlKind = 'docx' | 'xlsx' | 'pptx';

const OOXML_BY_MIME: Readonly<Record<string, OoxmlKind>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

const MAIN_PART: Readonly<Record<OoxmlKind, string>> = {
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml',
};

/** The main-part content type each kind must declare in [Content_Types].xml. */
const MAIN_CONTENT_TYPE: Readonly<Record<OoxmlKind, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
};

const CONTENT_TYPES_PART = '[content_types].xml';

/** Printer setup blobs (DEVMODE) are plain data, not OLE objects. */
const PRINTER_SETTINGS = /^printersettings\d*\.bin$/;

/**
 * Largest part inflated into memory for inspection: an embedded docx/xlsx/pptx
 * or [Content_Types].xml. Keeps a Worker well inside its memory limit; a chart
 * workbook is typically kilobytes.
 */
export const MAX_INSPECTED_PART_BYTES = 16 * 1024 * 1024;

/**
 * Leading bytes of containers and executables that may not hide inside an
 * Office package under any name (zip variants, OLE2, rar, 7z, gzip, bzip2,
 * xz, cab, PE/DOS executables, ELF).
 */
const NESTED_SIGNATURES: ReadonlyArray<readonly number[]> = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07],
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
  [0x1f, 0x8b],
  [0x42, 0x5a, 0x68],
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
  [0x4d, 0x53, 0x43, 0x46],
  [0x4d, 0x5a],
  [0x7f, 0x45, 0x4c, 0x46],
];

/**
 * Parts whose leading bytes are legitimately compressed or obfuscated:
 * gzip-wrapped metafiles (.emz, .wmz) and embedded fonts (.odttf, .fntdata).
 * They are still counted, capped and checked for ZIP/OLE2/RAR/7z content.
 */
const COMPRESSED_MEDIA = /\.(emz|wmz)$/;
const OBFUSCATED_FONT = /\.(odttf|fntdata)$/;
const STRONG_SIGNATURE_MIN = 4;

function isNestedContainer(head: Uint8Array, name: string): boolean {
  const gzipOk = COMPRESSED_MEDIA.test(name);
  const shortOk = OBFUSCATED_FONT.test(name);
  return NESTED_SIGNATURES.some(
    (sig) =>
      !(shortOk && sig.length < STRONG_SIGNATURE_MIN) &&
      !(gzipOk && sig[0] === 0x1f && sig[1] === 0x8b) &&
      head.length >= sig.length &&
      sig.every((byte, i) => head[i] === byte),
  );
}

export function ooxmlKindForMime(mimeType: string): OoxmlKind | null {
  return OOXML_BY_MIME[normalizeMime(mimeType)] ?? null;
}

function ooxmlKindForName(name: string): OoxmlKind | null {
  if (name.endsWith('.docx')) return 'docx';
  if (name.endsWith('.xlsx')) return 'xlsx';
  if (name.endsWith('.pptx')) return 'pptx';
  return null;
}

function basename(name: string): string {
  return name.split('/').pop() ?? name;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Decode XML character and predefined entity references ("&#109;" -> "m"). */
function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (_whole, ref: string) => {
    const lower = ref.toLowerCase();
    if (lower.startsWith('#')) {
      const code = lower.startsWith('#x')
        ? parseInt(lower.slice(2), 16)
        : parseInt(lower.slice(1), 10);
      // An out-of-range reference decodes to U+FFFD instead of throwing (a 500).
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[lower] ?? '';
  });
}

/** Attribute value from one XML start tag, or null. */
function xmlAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  if (match === null) return null;
  return decodeXmlEntities(match[1] ?? match[2] ?? '');
}

/**
 * [Content_Types].xml rules: no macro or VBA content type anywhere (checked on
 * the entity-decoded text), and the main part must be declared with exactly the
 * claimed type's main content type.
 */
function checkContentTypes(raw: string, kind: OoxmlKind): FileSafetyResult {
  const decoded = decodeXmlEntities(raw).toLowerCase();
  // macrosheet also covers intlmacrosheet (Excel 4.0 XLM macro sheets).
  if (['macroenabled', 'vbaproject', 'macrosheet'].some((token) => decoded.includes(token))) {
    return refuse('blocked_type');
  }
  const mainPart = `/${MAIN_PART[kind]}`;
  for (const tag of raw.match(/<override\b[^>]*>/gi) ?? []) {
    const part = xmlAttribute(tag, 'PartName');
    if (part === null || part.toLowerCase() !== mainPart) continue;
    const type = xmlAttribute(tag, 'ContentType');
    return type !== null && type.toLowerCase() === MAIN_CONTENT_TYPE[kind]
      ? OK
      : refuse('mime_mismatch');
  }
  return refuse('mime_mismatch');
}

/**
 * Open an OOXML package and apply every rule. `depth` is 0 for the upload and 1
 * for an embedded package; the budget is shared so embeds count toward the caps.
 */
async function inspectOoxml(
  bytes: Uint8Array,
  kind: OoxmlKind,
  depth: number,
  budget: ZipBudget,
): Promise<FileSafetyResult> {
  if (!isZipSignature(bytes)) return refuse('mime_mismatch');
  const read = readCentralDirectory(bytes);
  if (!read.ok) return refuse(read.code);
  const { entries, cdOffset } = read;

  // Declared-size caps first: no inflating a package that already says it is too big.
  budget.entries += entries.length;
  if (budget.entries > ZIP_LIMITS.maxEntries) return refuse('archive_limits');
  const seen = new Set<string>();
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    // A duplicate name lets two readers see two different files.
    if (seen.has(lower)) return refuse('mime_mismatch');
    seen.add(lower);
    if ((entry.flags & 0x1) !== 0 || entry.method === METHOD_AES) {
      return refuse('encrypted_file');
    }
    if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
      return refuse('mime_mismatch');
    }
    budget.uncompressedBytes += entry.uncompressedSize;
    if (budget.uncompressedBytes > ZIP_LIMITS.maxTotalUncompressedBytes) {
      return refuse('archive_limits');
    }
    if (
      entry.uncompressedSize >
      ZIP_LIMITS.maxCompressionRatio * Math.max(entry.compressedSize, 1)
    ) {
      return refuse('archive_limits');
    }
  }
  const declaredTotal = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  if (declaredTotal > ZIP_LIMITS.maxCompressionRatio * bytes.length) {
    return refuse('archive_limits');
  }

  // Structure: the content-types part and the claimed type's main part.
  if (!seen.has(CONTENT_TYPES_PART) || !seen.has(MAIN_PART[kind])) {
    return refuse('mime_mismatch');
  }

  // Macros, OLE objects and stray embeddings, by name, before any inflating.
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    const name = basename(lower);
    if (name.startsWith('vbaproject') || name === 'vbadata.xml') return refuse('blocked_type');
    if (name.endsWith('.bin') && !PRINTER_SETTINGS.test(name)) return refuse('embedded_content');
    if (name.startsWith('oleobject')) return refuse('embedded_content');
    if (lower.includes('embeddings/') && ooxmlKindForName(lower) === null) {
      return refuse('embedded_content');
    }
  }

  // Local headers: each must match its central entry, and entry data may not
  // overlap (overlapping entries are the classic non-recursive zip bomb).
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const spans: Array<{ entry: ZipEntry; start: number; end: number }> = [];
  for (const entry of entries) {
    const local = entry.localOffset;
    if (local + 30 > cdOffset || u32(view, local) !== SIG_LOCAL) return refuse('mime_mismatch');
    if ((u16(view, local + 6) & 0x1) !== 0) return refuse('encrypted_file');
    if (u16(view, local + 8) !== entry.method) return refuse('mime_mismatch');
    const nameLen = u16(view, local + 26);
    if (!sameBytes(bytes.subarray(local + 30, local + 30 + nameLen), entry.nameBytes)) {
      return refuse('mime_mismatch');
    }
    const start = local + 30 + nameLen + u16(view, local + 28);
    const end = start + entry.compressedSize;
    if (end > cdOffset) return refuse('mime_mismatch');
    spans.push({ entry, start, end });
  }
  const ordered = [...spans].sort((x, y) => x.entry.localOffset - y.entry.localOffset);
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.entry.localOffset < previous.end
    ) {
      return refuse('archive_limits');
    }
  }

  for (const { entry, start, end } of spans) {
    const lower = entry.name.toLowerCase();
    const embedKind = ooxmlKindForName(lower);
    const isContentTypes = lower === CONTENT_TYPES_PART;
    const keep = isContentTypes || embedKind !== null;
    if (keep && entry.uncompressedSize > MAX_INSPECTED_PART_BYTES) {
      return refuse('archive_limits');
    }
    const inflated = await inflateEntry(entry, bytes.subarray(start, end), keep);
    if (!inflated.ok) return refuse(inflated.code);

    if (isContentTypes) {
      const checked = checkContentTypes(
        new TextDecoder().decode(inflated.body ?? new Uint8Array()),
        kind,
      );
      if (!checked.ok) return checked;
      continue;
    }

    if (embedKind !== null) {
      // Only a docx/xlsx/pptx may be embedded, and only in the uploaded package.
      if (depth >= ZIP_LIMITS.maxEmbedDepth || inflated.body === null) {
        return refuse('embedded_content');
      }
      if (!isZipSignature(inflated.body)) return refuse('embedded_content');
      const inner = await inspectOoxml(inflated.body, embedKind, depth + 1, budget);
      if (!inner.ok) return inner;
      continue;
    }

    if (isNestedContainer(inflated.head, lower)) return refuse('embedded_content');
  }
  return OK;
}

/**
 * Apply every content rule for an upload whose MIME is already allowlisted and
 * whose leading bytes already match it. Returns the first refusal.
 */
export async function inspectUpload(input: {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<FileSafetyResult> {
  const mime = normalizeMime(input.mimeType);
  if (BLOCKED_MIME_TYPES.has(mime)) return refuse('blocked_type');
  if (isOle2Signature(input.bytes)) return checkOle2(input.bytes);

  const name = checkFilename(input.filename, mime);
  if (!name.ok) return name;

  if (mime === 'application/pdf' && isEncryptedPdf(input.bytes)) {
    return refuse('encrypted_file');
  }

  const kind = ooxmlKindForMime(mime);
  if (kind !== null) {
    return inspectOoxml(input.bytes, kind, 0, { entries: 0, uncompressedBytes: 0 });
  }
  return OK;
}
