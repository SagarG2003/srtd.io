import { deflateRawSync, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_EXTENSIONS,
  FILE_SAFETY_MESSAGES,
  MAX_INSPECTED_PART_BYTES,
  ZIP_LIMITS,
  checkFilename,
  inspectUpload,
  isEncryptedPdf,
  pdfNeedsPassword,
  type FileSafetyCode,
} from './file-safety';
import {
  MIME,
  buildZip,
  contentTypesFor,
  encryptedPdf,
  relationships,
  storedLocalHeader,
  jpeg,
  mp4,
  office,
  ole2,
  pdf,
  png,
  repetitiveXlsx,
  svg,
} from './__fixtures__/files';

async function codeOf(filename: string, mimeType: string, bytes: Uint8Array) {
  const result = await inspectUpload({ filename, mimeType, bytes });
  return result.ok ? 'ok' : result.code;
}

describe('allowed types still pass', () => {
  it.each([
    ['report.docx', MIME.docx, () => office('docx')],
    ['budget.xlsx', MIME.xlsx, () => office('xlsx')],
    ['deck.pptx', MIME.pptx, () => office('pptx')],
    ['brochure.pdf', MIME.pdf, () => pdf()],
    ['clip.mp4', MIME.mp4, () => mp4()],
    ['photo.png', MIME.png, () => png()],
    ['photo.jpeg', MIME.jpeg, () => jpeg()],
    ['photo.JPG', MIME.jpeg, () => jpeg()],
    ['voice-note.m4a', 'audio/mp4', () => mp4()],
    ['WhatsApp Image 2026-06-22 at 3.13.08 PM.jpeg', MIME.jpeg, () => jpeg()],
    ['Dr.Sangeeta_Carousel_01.pdf', MIME.pdf, () => pdf()],
    ['Report v2.1', MIME.pdf, () => pdf()],
    ['no-extension', MIME.png, () => png()],
  ])('%s', async (name, mime, bytes) => {
    expect(await codeOf(name, mime, bytes())).toBe('ok');
  });

  it('a pdf that only mentions /EncryptMetadata is not encrypted', () => {
    expect(isEncryptedPdf(pdf())).toBe(false);
  });
});

describe('R1 Office packages are opened and checked', () => {
  it('refuses a plain zip renamed .docx (no content types, no main part)', async () => {
    const zip = buildZip([{ name: 'notes.txt', data: 'hello' }]);
    expect(await codeOf('report.docx', MIME.docx, zip)).toBe('mime_mismatch');
  });

  it('refuses a docx whose main part is for another type', async () => {
    expect(await codeOf('report.docx', MIME.docx, office('xlsx'))).toBe('mime_mismatch');
  });

  it('refuses a docm (macro content type) renamed .docx', async () => {
    expect(await codeOf('report.docx', MIME.docx, office('docx', { macroContentType: true }))).toBe(
      'blocked_type',
    );
  });

  it('refuses a docx carrying vbaProject.bin', async () => {
    const bytes = office('docx', { extra: [{ name: 'word/vbaProject.bin', data: 'x' }] });
    expect(await codeOf('report.docx', MIME.docx, bytes)).toBe('blocked_type');
  });

  it('refuses truncated bytes that only carry a ZIP signature', async () => {
    const bytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
    expect(await codeOf('report.docx', MIME.docx, bytes)).toBe('mime_mismatch');
  });

  it('allows printer settings blobs', async () => {
    const bytes = office('xlsx', {
      extra: [{ name: 'xl/printerSettings/printerSettings1.bin', data: 'devmode' }],
    });
    expect(await codeOf('budget.xlsx', MIME.xlsx, bytes)).toBe('ok');
  });
});

describe('embedded content', () => {
  it('passes a pptx with an embedded chart workbook', async () => {
    const bytes = office('pptx', {
      extra: [{ name: 'ppt/embeddings/Microsoft_Excel_Worksheet.xlsx', data: office('xlsx') }],
    });
    expect(await codeOf('deck.pptx', MIME.pptx, bytes)).toBe('ok');
  });

  it('refuses a pptx whose embedded workbook carries vbaProject.bin', async () => {
    const workbook = office('xlsx', { extra: [{ name: 'xl/vbaProject.bin', data: 'x' }] });
    const bytes = office('pptx', {
      extra: [{ name: 'ppt/embeddings/Microsoft_Excel_Worksheet.xlsx', data: workbook }],
    });
    expect(await codeOf('deck.pptx', MIME.pptx, bytes)).toBe('blocked_type');
  });

  it('refuses a pptx whose embedded workbook is macro-enabled by content type', async () => {
    const workbook = office('xlsx', { macroContentType: true });
    const bytes = office('pptx', {
      extra: [{ name: 'ppt/embeddings/Microsoft_Excel_Worksheet.xlsx', data: workbook }],
    });
    expect(await codeOf('deck.pptx', MIME.pptx, bytes)).toBe('blocked_type');
  });

  it('refuses a docx with oleObject1.bin', async () => {
    const bytes = office('docx', {
      extra: [{ name: 'word/embeddings/oleObject1.bin', data: ole2() }],
    });
    expect(await codeOf('report.docx', MIME.docx, bytes)).toBe('embedded_content');
  });

  it('refuses an embedded archive that is not Office', async () => {
    const bytes = office('docx', {
      extra: [{ name: 'word/embeddings/archive.zip', data: buildZip([{ name: 'a', data: 'a' }]) }],
    });
    expect(await codeOf('report.docx', MIME.docx, bytes)).toBe('embedded_content');
  });

  it('refuses a zip hidden under an image name', async () => {
    const bytes = office('docx', {
      extra: [{ name: 'word/media/image1.png', data: buildZip([{ name: 'a', data: 'a' }]) }],
    });
    expect(await codeOf('report.docx', MIME.docx, bytes)).toBe('embedded_content');
  });

  it('refuses an embedded Office file nested beyond depth 1', async () => {
    const inner = office('xlsx', {
      extra: [{ name: 'xl/embeddings/doc.docx', data: office('docx') }],
    });
    const bytes = office('pptx', { extra: [{ name: 'ppt/embeddings/book.xlsx', data: inner }] });
    expect(await codeOf('deck.pptx', MIME.pptx, bytes)).toBe('embedded_content');
  });

  it('refuses an embedded docx that is not a real package', async () => {
    const bytes = office('pptx', {
      extra: [{ name: 'ppt/embeddings/doc.docx', data: buildZip([{ name: 'a', data: 'a' }]) }],
    });
    expect(await codeOf('deck.pptx', MIME.pptx, bytes)).toBe('mime_mismatch');
  });
});

describe('R2 legacy OLE Office and SVG are blocked', () => {
  it.each([
    ['legacy .doc', 'old.doc', 'application/msword', () => ole2()],
    ['legacy .xls', 'old.xls', 'application/vnd.ms-excel', () => ole2()],
    ['legacy .ppt', 'old.ppt', 'application/vnd.ms-powerpoint', () => ole2()],
    ['svg', 'logo.svg', 'image/svg+xml', () => svg()],
    ['OLE2 bytes claiming docx', 'report.docx', MIME.docx, () => ole2()],
  ])('%s', async (_label, name, mime, bytes) => {
    expect(await codeOf(name, mime, bytes())).toBe('blocked_type');
  });
});

describe('R3 disguised files', () => {
  it('refuses invoice.pdf.exe even with real pdf bytes', async () => {
    expect(await codeOf('invoice.pdf.exe', MIME.pdf, pdf())).toBe('blocked_type');
  });

  it.each([
    'invoice.exe.pdf',
    'photo.html.png',
    'run.JS.pdf',
    'setup.MSI.pdf',
    'logo.svg.png',
    'invoice.pdf.exe. ',
    'ｉｎｖｏｉｃｅ.ｅｘｅ.pdf',
    'C:\\fakepath\\pay.bat.pdf',
  ])('refuses a blocked segment in %s', (name) => {
    expect(checkFilename(name, MIME.pdf).ok).toBe(false);
  });

  it('refuses a right-to-left override disguise', () => {
    expect(checkFilename('invoice\u202Efdp.exe', MIME.pdf)).toMatchObject({ code: 'blocked_type' });
  });

  it('refuses when extension and declared MIME disagree', async () => {
    expect(await codeOf('photo.png', MIME.jpeg, jpeg())).toBe('mime_mismatch');
    expect(await codeOf('report.pdf', MIME.docx, office('docx'))).toBe('mime_mismatch');
    expect(await codeOf('IMG_0001.HEIC', MIME.mp4, mp4())).toBe('mime_mismatch');
  });

  it('covers every listed executable or script extension', () => {
    for (const ext of ['exe', 'scr', 'bat', 'cmd', 'com', 'js', 'vbs', 'ps1', 'msi', 'jar']) {
      expect(BLOCKED_EXTENSIONS.has(ext)).toBe(true);
    }
    for (const ext of ['app', 'dmg', 'apk', 'html', 'htm', 'svg']) {
      expect(BLOCKED_EXTENSIONS.has(ext)).toBe(true);
    }
  });
});

describe('R4 archive caps', () => {
  it('passes an xlsx with highly repetitive sheet data at about 500:1', async () => {
    const { bytes, sheetBytes } = repetitiveXlsx();
    // The whole package is the deflated sheet plus a few hundred header bytes.
    const ratio = sheetBytes / bytes.length;
    expect(ratio).toBeGreaterThan(450);
    expect(ratio).toBeLessThan(ZIP_LIMITS.maxCompressionRatio);
    expect(await codeOf('budget.xlsx', MIME.xlsx, bytes)).toBe('ok');
  });

  it('refuses an entry over the 1000:1 ratio cap', async () => {
    const bytes = office('xlsx', { mainBody: new Uint8Array(20 * 1024 * 1024) });
    expect(await codeOf('budget.xlsx', MIME.xlsx, bytes)).toBe('archive_limits');
  });

  it('refuses a package declaring over 500 MiB uncompressed', async () => {
    let seed = 7;
    const noise = (): Uint8Array =>
      Uint8Array.from({ length: 400 * 1024 }, () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed >>> 16;
      });
    const bytes = office('xlsx', {
      extra: [
        { name: 'xl/media/a.png', data: noise(), declaredSize: 300 * 1024 * 1024 },
        { name: 'xl/media/b.png', data: noise(), declaredSize: 300 * 1024 * 1024 },
      ],
    });
    expect(await codeOf('budget.xlsx', MIME.xlsx, bytes)).toBe('archive_limits');
  });

  it('refuses more than 10000 entries', async () => {
    const extra = Array.from({ length: ZIP_LIMITS.maxEntries }, (_, i) => ({
      name: `xl/e/${i}.xml`,
      data: '',
      method: 'store' as const,
    }));
    expect(await codeOf('budget.xlsx', MIME.xlsx, office('xlsx', { extra }))).toBe(
      'archive_limits',
    );
  });

  it('refuses an entry that inflates past its declared size (lying header)', async () => {
    const bytes = office('xlsx', {
      extra: [{ name: 'xl/media/a.png', data: new Uint8Array(512 * 1024), declaredSize: 2000 }],
    });
    expect(await codeOf('budget.xlsx', MIME.xlsx, bytes)).toBe('archive_limits');
  });

  it('counts an embedded package toward the entry cap', async () => {
    const half = Math.floor(ZIP_LIMITS.maxEntries / 2) + 1;
    const many = (prefix: string) =>
      Array.from({ length: half }, (_, i) => ({
        name: `${prefix}/${i}.xml`,
        data: '',
        method: 'store' as const,
      }));
    const inner = office('xlsx', { extra: many('xl/e') });
    const bytes = office('pptx', {
      extra: [{ name: 'ppt/embeddings/book.xlsx', data: inner }, ...many('ppt/e')],
    });
    expect(await codeOf('deck.pptx', MIME.pptx, bytes)).toBe('archive_limits');
  });
});

describe('R5 encrypted files', () => {
  it('refuses an encrypted pdf', async () => {
    expect(await codeOf('statement.pdf', MIME.pdf, pdf({ encrypted: true }))).toBe(
      'encrypted_file',
    );
  });

  it('refuses a zip-based file with an encrypted entry', async () => {
    const bytes = office('docx', {
      extra: [{ name: 'word/secret.xml', data: 'x', encrypted: true }],
    });
    expect(await codeOf('report.docx', MIME.docx, bytes)).toBe('encrypted_file');
  });

  it('refuses a password-protected Office file (OLE2 EncryptedPackage)', async () => {
    expect(await codeOf('report.docx', MIME.docx, ole2({ encryptedPackage: true }))).toBe(
      'encrypted_file',
    );
  });
});

describe('R6 refusal copy', () => {
  it('is plain and never mentions the connection', () => {
    for (const code of Object.keys(FILE_SAFETY_MESSAGES) as FileSafetyCode[]) {
      const message = FILE_SAFETY_MESSAGES[code];
      expect(message).not.toMatch(/connect|network|offline|\u2014/i);
    }
    expect(FILE_SAFETY_MESSAGES.encrypted_file).toBe("Password-protected files can't be shared");
    expect(FILE_SAFETY_MESSAGES.blocked_type).toBe("This file type isn't allowed");
    expect(FILE_SAFETY_MESSAGES.embedded_content).toBe(
      "This file contains embedded content that can't be checked.",
    );
  });
});

describe('audit regressions', () => {
  it('refuses a macro content type hidden behind XML character references', async () => {
    const xml = [
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.&#109;acroEnabled.main+xml"/>',
      '<Override PartName="/decoy.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
      '<Default Extension="dat" ContentType="application/vnd.ms-office.&#x76;baProject"/>',
      '</Types>',
    ].join('');
    const bytes = office('docx', {
      contentTypesXml: xml,
      extra: [{ name: 'word/vba.dat', data: 'x' }],
    });
    expect(await codeOf('report.docx', MIME.docx, bytes)).toBe('blocked_type');
  });

  it('refuses a docx whose main part is declared with another type (decoy override)', async () => {
    const xml = contentTypesFor('docx').replace(
      'PartName="/word/document.xml"',
      'PartName="/decoy.xml"',
    );
    expect(await codeOf('report.docx', MIME.docx, office('docx', { contentTypesXml: xml }))).toBe(
      'mime_mismatch',
    );
  });

  it('refuses a pdf whose /Encrypt name is #-escaped', () => {
    const escaped = new TextEncoder().encode(
      '%PDF-1.7\ntrailer\n<< /Root 1 0 R /Encr#79pt 5 0 R >>\n%%EOF\n',
    );
    expect(isEncryptedPdf(escaped)).toBe(true);
  });

  it.each([
    ['a rar archive', 'word/media/x.dat', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]],
    ['a 7z archive', 'word/media/x.dat', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
    ['a gzip stream', 'word/media/x.dat', [0x1f, 0x8b, 0x08, 0x00]],
    ['a self-extracting exe', 'word/media/x.png', [0x4d, 0x5a, 0x90, 0x00, 0x50, 0x4b]],
  ])('refuses %s hidden inside the package', async (_label, name, head) => {
    const bytes = office('docx', { extra: [{ name, data: Uint8Array.from(head) }] });
    expect(await codeOf('report.docx', MIME.docx, bytes)).toBe('embedded_content');
  });

  it('refuses a non-Office file in an embeddings folder', async () => {
    const bytes = office('docx', {
      extra: [{ name: 'word/embeddings/Microsoft_PowerPoint_Slide.sldx', data: office('pptx') }],
    });
    expect(await codeOf('report.docx', MIME.docx, bytes)).toBe('embedded_content');
  });

  it('allows emoji and Indic/Persian names that use joiners and direction marks', () => {
    for (const name of [
      'Diwali \u{1F468}\u200D\u{1F469}\u200D\u{1F467} post.png',
      '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645.png',
      '\u0915\u094D\u200D\u0937 poster.png',
      '\u200Freport\u200E.png',
    ]) {
      expect(checkFilename(name, MIME.png)).toEqual({ ok: true });
    }
  });

  it('refuses a local header whose name differs from the central directory', async () => {
    const bytes = office('docx', {
      extra: [{ name: 'word/media/a.png', localName: 'word/vbaProject.bin.x', data: 'x' }],
    });
    expect(await codeOf('report.docx', MIME.docx, bytes)).toBe('mime_mismatch');
  });

  it('refuses overlapping entries (non-recursive zip bomb shape)', async () => {
    const payload = new Uint8Array(64);
    const bytes = office(
      'docx',
      {
        extra: [
          {
            name: 'word/media/a.png',
            method: 'store',
            data: storedLocalHeader('word/media/b.png', payload),
          },
        ],
      },
      [{ name: 'word/media/b.png', into: 'word/media/a.png', size: payload.length }],
    );
    expect(await codeOf('report.docx', MIME.docx, bytes)).toBe('archive_limits');
  });

  it('refuses an embedded package too large to inspect in memory', async () => {
    const workbook = office('xlsx', {
      extra: [
        // Stored, so only the in-memory part cap (not the ratio cap) can refuse it.
        {
          name: 'xl/media/big.png',
          data: new Uint8Array(MAX_INSPECTED_PART_BYTES),
          method: 'store',
        },
      ],
    });
    const bytes = office('pptx', {
      extra: [{ name: 'ppt/embeddings/book.xlsx', data: workbook, method: 'store' }],
    });
    expect(await codeOf('deck.pptx', MIME.pptx, bytes)).toBe('archive_limits');
  });

  it.each([
    ['anim.gif', 'image/gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    ['photo.webp', 'image/webp', [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]],
    ['clip.mov', 'video/quicktime', [0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74]],
    ['voice-note.webm', 'audio/webm', [0x1a, 0x45, 0xdf, 0xa3]],
    ['voice-note.mp3', 'audio/mpeg', [0x49, 0x44, 0x33, 0x03]],
  ])('still allows %s', async (name, mime, head) => {
    expect(await codeOf(name, mime, Uint8Array.from(head))).toBe('ok');
  });

  it('does not throw on an out-of-range character reference', async () => {
    const xml = contentTypesFor('docx', `<!-- &#x${'f'.repeat(300)}; &#${'9'.repeat(400)}; -->`);
    expect(await codeOf('report.docx', MIME.docx, office('docx', { contentTypesXml: xml }))).toBe(
      'ok',
    );
  });

  it('refuses an Excel 4.0 macro sheet', async () => {
    const xml = contentTypesFor(
      'xlsx',
      '<Override PartName="/xl/macrosheets/sheet1.xml" ContentType="application/vnd.ms-excel.macrosheet+xml"/>',
    );
    const bytes = office('xlsx', {
      contentTypesXml: xml,
      extra: [{ name: 'xl/macrosheets/sheet1.xml', data: '<xm/>' }],
    });
    expect(await codeOf('budget.xlsx', MIME.xlsx, bytes)).toBe('blocked_type');
  });

  it('allows gzip-wrapped metafiles and fonts whose first bytes look like MZ', async () => {
    const bytes = office('pptx', {
      extra: [
        { name: 'ppt/media/image1.emz', data: Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 1, 2]) },
        { name: 'ppt/fonts/font1.fntdata', data: Uint8Array.from([0x4d, 0x5a, 0x01, 0x02, 3]) },
      ],
    });
    expect(await codeOf('deck.pptx', MIME.pptx, bytes)).toBe('ok');
  });

  it('still refuses a zip hidden under a metafile name', async () => {
    const bytes = office('pptx', {
      extra: [{ name: 'ppt/media/image1.emz', data: buildZip([{ name: 'a', data: 'a' }]) }],
    });
    expect(await codeOf('deck.pptx', MIME.pptx, bytes)).toBe('embedded_content');
  });

  it('refuses a UTF-16 [Content_Types].xml that could hide a macro type', async () => {
    const text = contentTypesFor('docx').replace('encoding="UTF-8"', 'encoding="UTF-16"');
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16.set([0xff, 0xfe], 0);
    for (let i = 0; i < text.length; i += 1) utf16[2 + i * 2] = text.charCodeAt(i);
    const swapped = buildZip([
      { name: '[Content_Types].xml', data: utf16 },
      { name: '_rels/.rels', data: '<Relationships/>' },
      { name: 'word/document.xml', data: '<w/>' },
    ]);
    expect(await codeOf('report.docx', MIME.docx, swapped)).toBe('mime_mismatch');
  });

  it('refuses a [Content_Types].xml with a DTD', async () => {
    const xml = contentTypesFor('xlsx').replace(
      '<Types',
      '<!DOCTYPE Types [<!ENTITY m "macro">]><Types',
    );
    expect(await codeOf('budget.xlsx', MIME.xlsx, office('xlsx', { contentTypesXml: xml }))).toBe(
      'mime_mismatch',
    );
  });

  it('caps the overall ratio across the upload and its embeds', async () => {
    // The embed stores its sheet uncompressed (1:1) and the outer package
    // deflates the embed at about 690:1: every entry is under 1000:1, but the
    // embed and its contents together reach about 1380x the upload.
    const sheet = '<v>0</v>'.repeat((8 * 1024 * 1024) / 8);
    const workbook = office('xlsx', {
      extra: [{ name: 'xl/worksheets/sheet1.xml', data: sheet, method: 'store' }],
    });
    const bytes = office('pptx', {
      extra: [{ name: 'ppt/embeddings/book.xlsx', data: workbook }],
    });
    expect(await codeOf('deck.pptx', MIME.pptx, bytes)).toBe('archive_limits');
    expect(await codeOf('book.xlsx', MIME.xlsx, workbook)).toBe('ok');
  });

  it.each([
    'invoice.pdf.exe\u200B',
    'invoice.pdf.ex\u200Be',
    'invoice.pdf.e\u00ADxe',
    'invoice.pdf.exe\u2060',
    'invoice.pdf.e\u200Dxe',
  ])('refuses a blocked extension hidden by invisible characters: %j', (name) => {
    expect(checkFilename(name, MIME.pdf)).toMatchObject({ code: 'blocked_type' });
  });

  it('accepts a [Content_Types].xml that starts with a UTF-8 BOM', async () => {
    const text = new TextEncoder().encode(contentTypesFor('docx'));
    const bom = new Uint8Array(3 + text.length);
    bom.set([0xef, 0xbb, 0xbf], 0);
    bom.set(text, 3);
    const bytes = buildZip([
      { name: '[Content_Types].xml', data: bom },
      { name: '_rels/.rels', data: '<Relationships/>' },
      { name: 'word/document.xml', data: '<w/>' },
    ]);
    expect(await codeOf('report.docx', MIME.docx, bytes)).toBe('ok');
  });
});

describe('F1 PDFs are refused only when a password is needed to open them', () => {
  const revisions = [
    [2, 'RC4 40-bit'],
    [3, 'RC4 128-bit'],
    [4, 'AES-128'],
    [5, 'AES-256 R5'],
    [6, 'AES-256 R6'],
  ] as const;

  it.each(revisions)('passes an owner-only lock, revision %i (%s)', async (revision) => {
    const bytes = encryptedPdf({ revision, userPassword: '' });
    expect(isEncryptedPdf(bytes)).toBe(true);
    expect(await pdfNeedsPassword(bytes)).toBe(false);
    expect(await codeOf('statement.pdf', MIME.pdf, bytes)).toBe('ok');
  });

  it.each(revisions)('refuses a user password, revision %i (%s)', async (revision) => {
    const bytes = encryptedPdf({ revision, userPassword: 'secret' });
    expect(await codeOf('statement.pdf', MIME.pdf, bytes)).toBe('encrypted_file');
  });

  it.each([2, 3, 4] as const)(
    'reads /O and /U written as escaped literal strings, revision %i',
    async (revision) => {
      const open = encryptedPdf({ revision, userPassword: '', literalStrings: true });
      const locked = encryptedPdf({ revision, userPassword: 'secret', literalStrings: true });
      expect(await codeOf('a.pdf', MIME.pdf, open)).toBe('ok');
      expect(await codeOf('a.pdf', MIME.pdf, locked)).toBe('encrypted_file');
    },
  );

  it('refuses the public-key handler (/Adobe.PubSec)', async () => {
    const bytes = encryptedPdf({ revision: 4, userPassword: '', filter: 'Adobe.PubSec' });
    expect(await codeOf('a.pdf', MIME.pdf, bytes)).toBe('encrypted_file');
  });

  it('refuses an /Encrypt reference whose dictionary cannot be read', async () => {
    expect(await codeOf('a.pdf', MIME.pdf, pdf({ encrypted: true }))).toBe('encrypted_file');
  });

  it('passes a PDF with no /Encrypt at all', async () => {
    expect(await pdfNeedsPassword(pdf())).toBe(false);
  });
});

describe('F2 Office files that load content from the internet', () => {
  const docxWithRels = (rels: string, name = 'word/_rels/settings.xml.rels') =>
    office('docx', { extra: [{ name, data: rels }] });

  it('refuses a remote attachedTemplate', async () => {
    const rels = relationships([
      { type: 'attachedTemplate', target: 'http://example.test/t.dotm', external: true },
    ]);
    const result = await inspectUpload({
      filename: 'report.docx',
      mimeType: MIME.docx,
      bytes: docxWithRels(rels),
    });
    expect(result).toEqual({
      ok: false,
      code: 'external_content',
      message: "This file loads content from the internet and can't be shared.",
    });
  });

  it.each(['oleObject', 'frame', 'subDocument'])('refuses an external %s', async (type) => {
    const rels = relationships([{ type, target: 'http://example.test/x', external: true }]);
    expect(
      await codeOf('report.docx', MIME.docx, docxWithRels(rels, 'word/_rels/document.xml.rels')),
    ).toBe('external_content');
  });

  it.each([
    'ms-msdt:/id PCWDiagnostic',
    'MS-MSDT:x',
    'ms-word:ofe|u|http://x',
    'msdt:x',
    'search-ms:query=x',
  ])('refuses a protocol-handler target %j even as a hyperlink', async (target) => {
    const rels = relationships([{ type: 'hyperlink', target, external: true }]);
    expect(
      await codeOf('report.docx', MIME.docx, docxWithRels(rels, 'word/_rels/document.xml.rels')),
    ).toBe('external_content');
  });

  it('refuses an entity-escaped ms-msdt target', async () => {
    const rels = relationships([
      { type: 'oleObject', target: 'ms&#45;msdt&#58;/id x', external: false },
    ]);
    expect(await codeOf('report.docx', MIME.docx, docxWithRels(rels))).toBe('external_content');
  });

  it('refuses a remote template inside an embedded workbook', async () => {
    const workbook = office('xlsx', {
      extra: [
        {
          name: 'xl/_rels/workbook.xml.rels',
          data: relationships([
            { type: 'oleObject', target: 'https://example.test/x.bin', external: true },
          ]),
        },
      ],
    });
    const bytes = office('pptx', { extra: [{ name: 'ppt/embeddings/book.xlsx', data: workbook }] });
    expect(await codeOf('deck.pptx', MIME.pptx, bytes)).toBe('external_content');
  });

  it('passes ordinary external web links and internal relationships', async () => {
    const rels = relationships([
      { type: 'hyperlink', target: 'https://srtd.io/brief?x=1', external: true },
      { type: 'hyperlink', target: 'mailto:hello@example.test', external: true },
      { type: 'image', target: 'media/image1.png' },
      { type: 'attachedTemplate', target: 'Normal.dotm' },
    ]);
    expect(
      await codeOf('report.docx', MIME.docx, docxWithRels(rels, 'word/_rels/document.xml.rels')),
    ).toBe('ok');
  });
});

describe('F3 regressions from the real-file dry run (synthetic)', () => {
  it('passes Excel worksheet customProperty .bin data blobs', async () => {
    const bytes = office('xlsx', {
      extra: [{ name: 'xl/customProperty1.bin', data: Uint8Array.from([0x41, 0x00, 0x42, 0x00]) }],
    });
    expect(await codeOf('budget.xlsx', MIME.xlsx, bytes)).toBe('ok');
  });

  it('still refuses a container hidden in a customProperty .bin', async () => {
    const bytes = office('xlsx', {
      extra: [{ name: 'xl/customProperty1.bin', data: ole2() }],
    });
    expect(await codeOf('budget.xlsx', MIME.xlsx, bytes)).toBe('embedded_content');
  });

  it('accepts the main type declared through <Default Extension="xml"> (.NET writers)', async () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>';
    const bom = '\uFEFF' + xml;
    expect(await codeOf('report.docx', MIME.docx, office('docx', { contentTypesXml: bom }))).toBe(
      'ok',
    );
  });

  it('still refuses a wrong main type declared through <Default>', async () => {
    const xml =
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml"/>' +
      '</Types>';
    expect(await codeOf('report.docx', MIME.docx, office('docx', { contentTypesXml: xml }))).toBe(
      'mime_mismatch',
    );
  });

  it('accepts namespace-prefixed package XML (<ns0:Types>, <ns0:Relationship>)', async () => {
    const xml =
      '<ns0:Types xmlns:ns0="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<ns0:Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '</ns0:Types>';
    const bytes = office('xlsx', {
      contentTypesXml: xml,
      extra: [
        {
          name: 'xl/_rels/workbook.xml.rels',
          data: relationships([{ type: 'worksheet', target: 'worksheets/sheet1.xml' }], 'ns0'),
        },
      ],
    });
    expect(await codeOf('budget.xlsx', MIME.xlsx, bytes)).toBe('ok');
  });

  it('still refuses a prefixed remote template', async () => {
    const rels = relationships(
      [{ type: 'attachedTemplate', target: 'http://example.test/t.dotm', external: true }],
      'ns0',
    );
    const bytes = office('docx', { extra: [{ name: 'word/_rels/settings.xml.rels', data: rels }] });
    expect(await codeOf('report.docx', MIME.docx, bytes)).toBe('external_content');
  });

  it('accepts backslash path separators and still applies every path rule to them', async () => {
    const ok = buildZip([
      { name: '[Content_Types].xml', data: contentTypesFor('xlsx') },
      { name: '_rels\\.rels', data: '<Relationships/>' },
      { name: 'xl\\workbook.xml', data: '<workbook/>' },
    ]);
    expect(await codeOf('budget.xlsx', MIME.xlsx, ok)).toBe('ok');
    const hidden = office('xlsx', {
      extra: [{ name: 'xl\\embeddings\\x.zip', data: buildZip([{ name: 'a', data: 'a' }]) }],
    });
    expect(await codeOf('budget.xlsx', MIME.xlsx, hidden)).toBe('embedded_content');
  });
});

describe('fix-round audit regressions', () => {
  const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');
  const fromLatin1 = (text: string) => Uint8Array.from(Buffer.from(text, 'latin1'));
  /** The "<< ... >>" body of object 7 in an encryptedPdf() fixture. */
  const encryptBody = (bytes: Uint8Array) => {
    const text = latin1(bytes);
    const start = text.indexOf('7 0 obj\n') + '7 0 obj\n'.length;
    return text.slice(start, text.indexOf('\nendobj', start));
  };
  const ownerOnly = encryptBody(encryptedPdf({ revision: 3, userPassword: '' }));

  it('refuses a password PDF with an owner-only decoy object after %%EOF', async () => {
    const locked = latin1(encryptedPdf({ revision: 3, userPassword: 'secret' }));
    const bytes = fromLatin1(`${locked}%7 0 obj\n${ownerOnly}\n`);
    expect(await codeOf('a.pdf', MIME.pdf, bytes)).toBe('encrypted_file');
  });

  it('refuses when the real definition uses other whitespace and a decoy uses spaces', async () => {
    const locked = latin1(encryptedPdf({ revision: 3, userPassword: 'secret' })).replace(
      '7 0 obj',
      '7\r\n0\nobj',
    );
    const bytes = fromLatin1(locked.replace('%%EOF', `%%EOF\n%7 0 obj ${ownerOnly}`));
    expect(await codeOf('a.pdf', MIME.pdf, bytes)).toBe('encrypted_file');
  });

  it('refuses a password dictionary hidden in an object stream behind a text decoy', async () => {
    const realDict = encryptBody(encryptedPdf({ revision: 3, userPassword: 'secret' }));
    const header = '7 0 ';
    const packed = deflateSync(Buffer.from(header + realDict, 'latin1'));
    const text = [
      '%PDF-1.7',
      '1 0 obj << /Type /Catalog >> endobj',
      `9 0 obj << /Type /ObjStm /N 1 /First ${header.length} /Filter /FlateDecode /Length ${packed.length} >>`,
      'stream',
      packed.toString('latin1'),
      'endstream',
      'endobj',
      `7 0 obj ${ownerOnly} endobj`,
      'trailer << /Root 1 0 R /Encrypt 7 0 R /ID [<00112233445566778899aabbccddeeff><00112233445566778899aabbccddeeff>] >>',
      '%%EOF',
    ].join('\n');
    expect(await codeOf('a.pdf', MIME.pdf, fromLatin1(text))).toBe('encrypted_file');
  });

  it('passes an owner-only PDF that also has an unrelated object stream', async () => {
    const header = '3 0 ';
    const packed = deflateSync(Buffer.from(`${header}<< /Producer (x) >>`, 'latin1'));
    const owner = latin1(encryptedPdf({ revision: 3, userPassword: '' })).replace(
      'trailer',
      `9 0 obj << /Type /ObjStm /N 1 /First ${header.length} /Filter /FlateDecode /Length ${packed.length} >>\nstream\n${packed.toString('latin1')}\nendstream\nendobj\ntrailer`,
    );
    expect(await codeOf('a.pdf', MIME.pdf, fromLatin1(owner))).toBe('ok');
  });

  it('refuses many distinct encryption dictionaries without computing them', async () => {
    const dicts = Array.from(
      { length: 50 },
      (_, i) => `/Encrypt ${ownerOnly.replace('/P', `/X ${i} /P`)}`,
    );
    const text = `%PDF-1.7\n${dicts.join('\n')}\ntrailer << /ID [<00112233445566778899aabbccddeeff>] >>\n%%EOF`;
    const started = Date.now();
    expect(await codeOf('a.pdf', MIME.pdf, fromLatin1(text))).toBe('encrypted_file');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('checks a repeated reference to one dictionary once (fast, still passes)', async () => {
    const owner = latin1(encryptedPdf({ revision: 6, userPassword: '' }));
    const padding = '/Encrypt 7 0 R\n'.repeat(2000);
    const started = Date.now();
    expect(
      await codeOf('a.pdf', MIME.pdf, fromLatin1(owner.replace('trailer', `${padding}trailer`))),
    ).toBe('ok');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  const relsDocx = (rels: string) =>
    office('docx', { extra: [{ name: 'word/_rels/settings.xml.rels', data: rels }] });
  const RELS_OPEN =
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';

  it("refuses a remote template whose Target holds a raw '>'", async () => {
    const rels = `${RELS_OPEN}<Relationship Id="r1" Target="http://evil.test/t.dotm#>" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" TargetMode="External"/></Relationships>`;
    expect(await codeOf('a.docx', MIME.docx, relsDocx(rels))).toBe('external_content');
  });

  it("refuses an ms-msdt target holding a raw '>'", async () => {
    const rels = `${RELS_OPEN}<Relationship Id="r1" Target="ms-msdt:/id PCWDiagnostic>x" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject"/></Relationships>`;
    expect(await codeOf('a.docx', MIME.docx, relsDocx(rels))).toBe('external_content');
  });

  it('refuses a decoy TargetMode written inside another attribute value', async () => {
    const rels = `${RELS_OPEN}<Relationship Id="r1" Target="http://evil.test/t.dotm? TargetMode='Internal'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" TargetMode="External"/></Relationships>`;
    expect(await codeOf('a.docx', MIME.docx, relsDocx(rels))).toBe('external_content');
  });

  it('refuses malformed package XML (unterminated quote, duplicate attribute)', async () => {
    for (const rel of [
      '<Relationship Id="r1 Target="x"/>',
      '<Relationship Id="r1" Id="r2" Target="x"/>',
    ]) {
      expect(
        await codeOf('a.docx', MIME.docx, relsDocx(`${RELS_OPEN}${rel}</Relationships>`)),
      ).toBe('mime_mismatch');
    }
  });

  const withObjectStream = (filter: string, data: string) =>
    fromLatin1(
      latin1(encryptedPdf({ revision: 3, userPassword: '' })).replace(
        'trailer',
        `9 0 obj << /Type /ObjStm /N 1 /First 4 /Filter /${filter} /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\ntrailer`,
      ),
    );

  it('passes an owner-only PDF whose object streams are encrypted (do not inflate)', async () => {
    const encryptedLooking = String.fromCharCode(
      ...Array.from({ length: 64 }, (_, i) => (i * 97 + 13) & 0xff),
    );
    expect(await codeOf('a.pdf', MIME.pdf, withObjectStream('FlateDecode', encryptedLooking))).toBe(
      'ok',
    );
  });

  it('refuses an owner-only PDF with an object stream it cannot check (other filter)', async () => {
    expect(await codeOf('a.pdf', MIME.pdf, withObjectStream('LZWDecode', 'xxxx'))).toBe(
      'encrypted_file',
    );
  });

  const ID = '/ID [<00112233445566778899aabbccddeeff><00112233445566778899aabbccddeeff>]';
  const userOnly = encryptBody(encryptedPdf({ revision: 3, userPassword: 'secret' }));
  const pdfWith = (objects: string, ref = '7 0 R') =>
    fromLatin1(
      `%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n${objects}\ntrailer << /Root 1 0 R /Encrypt ${ref} ${ID} >>\n%%EOF\n`,
    );

  it.each([
    [
      'a comment inside the real definition',
      `7 0 %c\nobj ${userOnly} endobj\n%7 0 obj ${ownerOnly}`,
    ],
    ['a letter before the real definition', `x7 0 obj ${userOnly} endobj\n%7 0 obj ${ownerOnly}`],
    ['leading zeros on the real definition', `007 0 obj ${userOnly} endobj\n%7 0 obj ${ownerOnly}`],
  ])('refuses a decoy when the real definition has %s', async (_label, objects) => {
    expect(await codeOf('a.pdf', MIME.pdf, pdfWith(objects))).toBe('encrypted_file');
  });

  it('refuses a decoy when an object stream without /Type holds the real dictionary', async () => {
    const header = '7 0 ';
    const packed = deflateSync(Buffer.from(header + userOnly, 'latin1'));
    const stream = `9 0 obj << /N 1 /First ${header.length} /Filter /FlateDecode /Length ${packed.length} >>\nstream\n${packed.toString('latin1')}\nendstream\nendobj`;
    expect(await codeOf('a.pdf', MIME.pdf, pdfWith(`${stream}\n7 0 obj ${ownerOnly} endobj`))).toBe(
      'encrypted_file',
    );
  });

  it('matches the generation: a gen-0 decoy cannot stand in for a gen-1 dictionary', async () => {
    const objects = `7 1 obj ${userOnly} endobj\n7 0 obj ${ownerOnly} endobj`;
    expect(await codeOf('a.pdf', MIME.pdf, pdfWith(objects, '7 1 R'))).toBe('encrypted_file');
  });

  it('ignores an outline /First reference when looking for object streams', async () => {
    const objects = `7 0 obj ${ownerOnly} endobj\n3 0 obj << /Type /Outlines /First 4 0 R /Last 4 0 R >> endobj`;
    expect(await codeOf('a.pdf', MIME.pdf, pdfWith(objects))).toBe('ok');
  });

  it('stays fast on a long comment line full of candidate numbers', async () => {
    const objects = `7 0 obj ${ownerOnly} endobj\n%${'7 %'.repeat(2_000_000)}\n`;
    const started = Date.now();
    expect(await codeOf('a.pdf', MIME.pdf, pdfWith(objects))).toBe('ok');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('skips CDATA and comments in .rels but still sees the real relationship', async () => {
    const inner = `<![CDATA[<x/>]]><!-- <Relationship Id="c" Target="ms-msdt:x"/> --><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="http://evil.test/t.dotm" TargetMode="External"/>`;
    expect(
      await codeOf('a.docx', MIME.docx, relsDocx(`${RELS_OPEN}${inner}</Relationships>`)),
    ).toBe('external_content');
    const commentOnly = `<!-- <Relationship Id="c" Target="ms-msdt:x"/> -->`;
    expect(
      await codeOf('a.docx', MIME.docx, relsDocx(`${RELS_OPEN}${commentOnly}</Relationships>`)),
    ).toBe('ok');
  });

  const within = async (ms: number, work: () => Promise<unknown>) => {
    const started = Date.now();
    await work();
    expect(Date.now() - started).toBeLessThan(ms);
  };

  it('stays fast on many /First keys inside unclosed strings (no /Encrypt)', async () => {
    await within(2000, async () => {
      expect(
        await codeOf('a.pdf', MIME.pdf, fromLatin1(`%PDF-1.7\n${'/First ('.repeat(200_000)}`)),
      ).toBe('ok');
    });
  });

  it('refuses an object 0 encryption reference without scanning a zero run', async () => {
    await within(2000, async () => {
      const objects = `0 0 obj ${ownerOnly} endobj\n${'0'.repeat(4_000_000)}`;
      expect(await codeOf('a.pdf', MIME.pdf, pdfWith(objects, '0 0 R'))).toBe('encrypted_file');
    });
  });

  it('stays fast on a long zero run before a candidate object number', async () => {
    await within(2000, async () => {
      const objects = `10 0 obj ${ownerOnly} endobj\n${'0'.repeat(4_000_000)}`;
      expect(await codeOf('a.pdf', MIME.pdf, pdfWith(objects, '10 0 R'))).toBe('ok');
    });
  });

  it('inflates only object stream headers, however long the streams are', async () => {
    // Ciphertext-like stream data (no zlib header), as in an encrypted PDF.
    const headers = Array.from(
      { length: 500 },
      (_, i) =>
        `${100 + i} 0 obj<</Type/ObjStm/N 1/First 4/Filter/FlateDecode>>stream\n\x8f\x13\xa2\x07`,
    ).join('\n');
    await within(3000, async () => {
      const objects = `7 0 obj ${ownerOnly} endobj\n${headers}\n${'A'.repeat(8_000_000)}\nendstream`;
      expect(await codeOf('a.pdf', MIME.pdf, pdfWith(objects))).toBe('ok');
    });
  });

  it('refuses an object stream with a zlib header that does not inflate to its header', async () => {
    const objects = `7 0 obj ${ownerOnly} endobj\n9 0 obj<</Type/ObjStm/N 1/First 4/Filter/FlateDecode>>stream\n\x78\x9c\xff\xff\nendstream`;
    expect(await codeOf('a.pdf', MIME.pdf, pdfWith(objects))).toBe('encrypted_file');
  });

  it('refuses a decoy when the real dictionary sits after empty stored deflate blocks', async () => {
    const raw = deflateRawSync(Buffer.from(`7 0 ${userOnly}`, 'latin1'));
    const padded = Buffer.concat([
      Buffer.from([0x78, 0x01]),
      Buffer.from('000000ffff'.repeat(400), 'hex'),
      raw,
    ]);
    const stream = `9 0 obj << /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${padded.length} >>\nstream\n${padded.toString('latin1')}\nendstream\nendobj`;
    expect(await codeOf('a.pdf', MIME.pdf, pdfWith(`${stream}\n7 0 obj ${ownerOnly} endobj`))).toBe(
      'encrypted_file',
    );
  });

  it('refuses a decoy "obj << ... >> stream" hidden in a string of the real object stream', async () => {
    const packed = deflateSync(Buffer.from(`7 0 ${userOnly}`, 'latin1'));
    const stream = `9 0 obj << /X (obj << /N 1 /First 4 >>\nstream\n1 0 ) /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${packed.length} >>\nstream\n${packed.toString('latin1')}\nendstream\nendobj`;
    expect(await codeOf('a.pdf', MIME.pdf, pdfWith(`${stream}\n7 0 obj ${ownerOnly} endobj`))).toBe(
      'encrypted_file',
    );
  });

  it.each(['/First %c\n4', '/First +4'])(
    'finds an untyped object stream whose header length is written %j',
    async (first) => {
      const packed = deflateSync(Buffer.from(`7 0 ${userOnly}`, 'latin1'));
      const stream = `9 0 obj << /N 1 ${first} /Filter /FlateDecode /Length ${packed.length} >>\nstream\n${packed.toString('latin1')}\nendstream\nendobj`;
      expect(
        await codeOf('a.pdf', MIME.pdf, pdfWith(`${stream}\n7 0 obj ${ownerOnly} endobj`)),
      ).toBe('encrypted_file');
    },
  );

  it('passes an owner-only PDF when a structure element carries a later /ID', async () => {
    const owner = latin1(pdfWith(`7 0 obj ${ownerOnly} endobj`));
    const tagged = `${owner}20 0 obj << /Type /StructElem /ID (abc) >> endobj\ntrailer << /Size 21 >>\n%%EOF\n`;
    expect(await codeOf('a.pdf', MIME.pdf, fromLatin1(tagged))).toBe('ok');
  });
});

describe('G1/G2 external relationships by target location', () => {
  const T = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const docxWith = (type: string, target: string, external = true) =>
    office('docx', {
      extra: [
        {
          name: 'word/_rels/document.xml.rels',
          data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="${T}/${type}" Target="${target.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"${external ? ' TargetMode="External"' : ''}/></Relationships>`,
        },
      ],
    });

  const network = [
    'http://evil.test/t.dotm',
    'HTTPS://evil.test/t.dotm',
    'ftp://evil.test/t.dotm',
    '\\\\server\\share\\t.dotm',
    '//server/share/t.dotm',
    '\\\\?\\UNC\\server\\share\\t.dotm',
    'file://server/share/t.dotm',
    'file:////server/share/t.dotm',
    'file:\\\\server\\share\\t.dotm',
    'file://%5C%5Cserver/t.dotm',
    '%5C%5Cserver%5Cshare%5Ct.dotm',
    'smb://server/share/t.dotm',
    'file://localhost//server/share/t.dotm',
    'file://localhost/\\\\server\\share\\t.dotm',
    'file://LOCALHOST////server/share/t.dotm',
    'ms-msdt:/id PCWDiagnostic',
    'search-ms:query=x',
  ];
  const local = [
    'file:///C:\\Users\\me\\Templates\\Normal.dotm',
    'file:///C:/Program%20Files/Template.dotm',
    'file:///',
    'file://localhost/C:/t.dotm',
    'C:\\Templates\\Report.dotm',
    'Normal.dotm',
    '../templates/report.dotm',
    'templates/report.dotm',
  ];

  for (const type of ['attachedTemplate', 'oleObject', 'frame', 'subDocument']) {
    it.each(network)(`G1 refuses an external ${type} at a network target %j`, async (target) => {
      expect(await codeOf('a.docx', MIME.docx, docxWith(type, target))).toBe('external_content');
    });
    it.each(local)(`G1 passes an external ${type} at a local target %j`, async (target) => {
      expect(await codeOf('a.docx', MIME.docx, docxWith(type, target))).toBe('ok');
    });
  }

  it.each([
    ['image', '\\\\server\\share\\logo.png'],
    ['image', '//server/share/logo.png'],
    ['image', 'file://server/share/logo.png'],
    ['image', 'file:////server/share/logo.png'],
    ['audio', '\\\\server\\share\\a.wav'],
    ['video', 'file://fileserver/v.mp4'],
    ['image', 'file://localhost//server/share/logo.png'],
    ['externalLinkPath', '\\\\server\\share\\book.xlsx'],
  ])('G2 refuses an external %s loaded from a share %j', async (type, target) => {
    const result = await inspectUpload({
      filename: 'a.docx',
      mimeType: MIME.docx,
      bytes: docxWith(type, target),
    });
    expect(result).toEqual({
      ok: false,
      code: 'external_content',
      message: "This file loads content from the internet and can't be shared.",
    });
  });

  it.each([
    ['image', 'http://cdn.example.test/logo.png'],
    ['image', 'https://cdn.example.test/logo.png'],
    ['image', 'file:///C:/pictures/logo.png'],
    ['image', 'logo.png'],
    ['hyperlink', '\\\\server\\share\\doc.docx'],
    ['hyperlink', 'file://server/share/doc.docx'],
    ['hyperlink', 'https://srtd.io'],
  ])('G2 passes an external %s at %j', async (type, target) => {
    expect(await codeOf('a.docx', MIME.docx, docxWith(type, target))).toBe('ok');
  });

  it('G2 still refuses a protocol handler even in a hyperlink', async () => {
    expect(await codeOf('a.docx', MIME.docx, docxWith('hyperlink', 'ms-msdt:/id x'))).toBe(
      'external_content',
    );
  });

  it('G1 leaves internal (non-External) relationships alone', async () => {
    expect(
      await codeOf(
        'a.docx',
        MIME.docx,
        docxWith('attachedTemplate', 'http://evil.test/t.dotm', false),
      ),
    ).toBe('ok');
  });
});

describe('H1-H3 share targets hidden by path tricks', () => {
  const T = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const docxWith = (type: string, target: string) =>
    office('docx', {
      extra: [
        {
          name: 'word/_rels/document.xml.rels',
          data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="${T}/${type}" Target="${target.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" TargetMode="External"/></Relationships>`,
        },
      ],
    });

  const hidden = [
    // H1: "//" inside a file: path, or "." / ".." segments.
    'file:///.//server/share/t.dotm',
    'file:///./\\\\server\\share\\t.dotm',
    'file:///x/..//server/share/t.dotm',
    'file:///x/../\\\\server\\share\\t.dotm',
    'file://localhost/./\\\\server\\share\\t.dotm',
    'file://localhost/.//server/share/t.dotm',
    'file://localhost/%2e//server/share/t.dotm',
    'file://localhost/x/..//server/share/t.dotm',
    'file:///C:/docs/../t.dotm',
    'file:/./x/t.dotm',
    // H2: NT object-manager UNC prefix.
    '\\??\\UNC\\server\\share\\t.dotm',
    '\\??\\unc\\server\\share\\t.dotm',
    'file:///\\??\\UNC\\server\\share\\t.dotm',
    // H3: whitespace that only appears after %-decoding.
    '%20\\\\server\\share\\t.dotm',
    '%09\\\\server\\share\\t.dotm',
    '%0A//server/share/t.dotm',
    '%20%20file://server/share/t.dotm',
  ];

  for (const type of ['attachedTemplate', 'oleObject', 'frame', 'subDocument', 'image', 'audio']) {
    it.each(hidden)(`refuses an external ${type} at %j`, async (target) => {
      expect(await codeOf('a.docx', MIME.docx, docxWith(type, target))).toBe('external_content');
    });
  }

  it.each([
    'file:///C:/Users/me/Templates/Normal.dotm',
    'file:///C:\\Program Files\\Office\\Normal.dotm',
    'file://localhost/C:/t.dotm',
    '\\??\\C:\\Templates\\t.dotm',
    '%20Normal.dotm',
    'templates/report.dotm',
  ])('still passes the local template %j', async (target) => {
    expect(await codeOf('a.docx', MIME.docx, docxWith('attachedTemplate', target))).toBe('ok');
  });

  it.each(hidden)('still passes a hyperlink to %j', async (target) => {
    expect(await codeOf('a.docx', MIME.docx, docxWith('hyperlink', target))).toBe('ok');
  });
});

describe('H4-H5 NT object paths and control characters', () => {
  const T = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const docxWith = (type: string, target: string) =>
    office('docx', {
      extra: [
        {
          name: 'word/_rels/document.xml.rels',
          data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="${T}/${type}" Target="${target.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" TargetMode="External"/></Relationships>`,
        },
      ],
    });

  const ntShares = [
    '\\??\\GLOBALROOT\\Device\\Mup\\server\\share\\t.dotm',
    '\\??\\Global\\UNC\\server\\share\\t.dotm',
    '\\??\\globalroot\\??\\UNC\\server\\share',
    'file:///??/GLOBALROOT/Device/Mup/x',
    'file:///\\??\\GLOBALROOT\\Device\\Mup\\x',
    'file://localhost/??/Global/UNC/server/x',
  ];
  const controls = [
    '%00\\\\server\\share\\t.dotm',
    '%01\\\\server\\share\\t.dotm',
    '\\%09\\server\\share\\t.dotm',
    'file:///%09/server/share/t.dotm',
    'file:///C:/Templates/t%1F.dotm',
    'Normal%0D.dotm',
  ];

  for (const type of ['attachedTemplate', 'image']) {
    it.each([...ntShares, ...controls])(`refuses an external ${type} at %j`, async (target) => {
      expect(await codeOf('a.docx', MIME.docx, docxWith(type, target))).toBe('external_content');
    });
    it.each(['\\??\\C:\\x.dotm', '\\??\\c:\\Templates\\Normal.dotm', 'file:///??/D:/x.dotm'])(
      `passes an external ${type} at the local NT drive path %j`,
      async (target) => {
        expect(await codeOf('a.docx', MIME.docx, docxWith(type, target))).toBe('ok');
      },
    );
  }

  it.each([...ntShares, ...controls])('leaves a hyperlink to %j alone', async (target) => {
    expect(await codeOf('a.docx', MIME.docx, docxWith('hyperlink', target))).toBe('ok');
  });
});
