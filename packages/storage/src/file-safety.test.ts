import { describe, expect, it } from 'vitest';
import {
  BLOCKED_EXTENSIONS,
  FILE_SAFETY_MESSAGES,
  MAX_INSPECTED_PART_BYTES,
  ZIP_LIMITS,
  checkFilename,
  inspectUpload,
  isEncryptedPdf,
  type FileSafetyCode,
} from './file-safety';
import {
  MIME,
  buildZip,
  contentTypesFor,
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
});
