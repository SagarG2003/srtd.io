import { describe, expect, it } from 'vitest';
import {
  BLOCKED_EXTENSIONS,
  FILE_SAFETY_MESSAGES,
  ZIP_LIMITS,
  checkFilename,
  inspectUpload,
  isEncryptedPdf,
  type FileSafetyCode,
} from './file-safety';
import {
  MIME,
  buildZip,
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
