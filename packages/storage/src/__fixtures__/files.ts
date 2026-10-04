// Byte fixtures for the upload file-safety tests. Everything is built in-process
// from small strings: no files on disk, no network, and no real malware (a
// "macro" is an empty vbaProject.bin entry; an "executable" is just a name).

import { deflateRawSync } from 'node:zlib';

const encoder = new TextEncoder();

export const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  png: 'image/png',
  jpeg: 'image/jpeg',
} as const;

export interface ZipFile {
  name: string;
  data: Uint8Array | string;
  /** Default 'deflate'. */
  method?: 'store' | 'deflate';
  /** Sets general-purpose flag bit 0 (traditional ZIP encryption). */
  encrypted?: boolean;
  /** Overrides the uncompressed size written to both headers (a lying header). */
  declaredSize?: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? encoder.encode(data) : data;
}

/** A spec-shaped ZIP: local headers + data, central directory, EOCD. */
export function buildZip(files: readonly ZipFile[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = toBytes(file.data);
    const deflate = (file.method ?? 'deflate') === 'deflate';
    const body = deflate ? new Uint8Array(deflateRawSync(raw, { level: 9 })) : raw;
    const name = encoder.encode(file.name);
    const flags = file.encrypted ? 0x1 : 0;
    const method = deflate ? 8 : 0;
    const size = file.declaredSize ?? raw.length;
    const crc = crc32(raw);

    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

type Kind = 'docx' | 'xlsx' | 'pptx';

const MAIN: Record<Kind, { part: string; type: string }> = {
  docx: {
    part: 'word/document.xml',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  },
  xlsx: {
    part: 'xl/workbook.xml',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  },
  pptx: {
    part: 'ppt/presentation.xml',
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  },
};

const MACRO_MAIN: Record<Kind, string> = {
  docx: 'application/vnd.ms-word.document.macroEnabled.main+xml',
  xlsx: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  pptx: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
};

function contentTypes(mainType: string, extra = ''): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    `<Override PartName="/main" ContentType="${mainType}"/>`,
    extra,
    '</Types>',
  ].join('');
}

const RELS =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>';

export interface OfficeOptions {
  /** Use the macro-enabled main content type (a docm/xlsm/pptm). */
  macroContentType?: boolean;
  /** Extra entries placed in the package. */
  extra?: readonly ZipFile[];
  /** Override the main part's body (e.g. a large sheet). */
  mainBody?: Uint8Array | string;
}

/** A minimal, valid Office Open XML package of the given kind. */
export function office(kind: Kind, options: OfficeOptions = {}): Uint8Array {
  const main = MAIN[kind];
  return buildZip([
    {
      name: '[Content_Types].xml',
      data: contentTypes(options.macroContentType ? MACRO_MAIN[kind] : main.type),
    },
    { name: '_rels/.rels', data: RELS },
    { name: main.part, data: options.mainBody ?? `<root kind="${kind}">Hello</root>` },
    ...(options.extra ?? []),
  ]);
}

/** Bytes of the repeated cell in {@link repetitiveXlsx}. */
const REPEATED_CELL = '<c><v>1</v></c>';

/**
 * An xlsx whose 8 MiB sheet is one cell repeated: deflate level 9 packs it at
 * about 515:1, a realistic "highly repetitive sheet" well under the 1000:1 cap.
 */
export function repetitiveXlsx(): { bytes: Uint8Array; sheetBytes: number } {
  const sheet = REPEATED_CELL.repeat(Math.ceil((8 * 1024 * 1024) / REPEATED_CELL.length));
  return { bytes: office('xlsx', { mainBody: sheet }), sheetBytes: sheet.length };
}

/** OLE2 compound-file header, optionally naming an EncryptedPackage stream. */
export function ole2(options: { encryptedPackage?: boolean } = {}): Uint8Array {
  const header = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  const out = new Uint8Array(1024);
  out.set(header, 0);
  if (options.encryptedPackage) {
    const name = 'EncryptedPackage';
    for (let i = 0; i < name.length; i += 1) out[512 + i * 2] = name.charCodeAt(i);
  }
  return out;
}

export function pdf(options: { encrypted?: boolean } = {}): Uint8Array {
  const trailer = options.encrypted
    ? 'trailer\n<< /Root 1 0 R /Encrypt 5 0 R /ID [<00><00>] >>\n'
    : 'trailer\n<< /Root 1 0 R >>\n';
  return encoder.encode(
    `%PDF-1.7\n1 0 obj\n<< /Type /Catalog /EncryptMetadata false >>\nendobj\n${trailer}%%EOF\n`,
  );
}

/** An ISO-BMFF header with an mp4 brand. */
export function mp4(): Uint8Array {
  return Uint8Array.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
  ]);
}

export function png(): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10,
  ]);
}

export function jpeg(): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
}

export function svg(): Uint8Array {
  return encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>');
}
