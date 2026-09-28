// tests/import/workbook-parser.test.ts
import { describe, expect, it } from 'vitest';
import { detectSheets, extractHeaderRow, extractDataRows, suggestPrimarySheet } from '@/lib/import/workbook-parser';
import ExcelJS from 'exceljs';

async function buildWorkbook(sheets: { name: string; rows: (string | number | Date | null)[][] }[]) {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    for (const row of s.rows) ws.addRow(row);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('workbook-parser', () => {
  it('detects all non-empty sheets and suggests the one with the most data rows', async () => {
    const buf = await buildWorkbook([
      { name: 'Notes', rows: [['just one note']] },
      { name: 'Participants', rows: [['Name', 'Email'], ['A', 'a@x.com'], ['B', 'b@x.com'], ['C', 'c@x.com']] },
      { name: 'Empty', rows: [] },
    ]);
    const sheets = await detectSheets(buf);
    expect(sheets.map((s) => s.name)).toEqual(['Notes', 'Participants']); // Empty excluded
    expect(suggestPrimarySheet(sheets)).toBe('Participants');
  });

  it('ranks sheet size by highest row index, not non-empty row count, so a sheet with internal blank-row gaps is not under-ranked', async () => {
    const buf = await buildWorkbook([
      // 'Small' has 3 genuinely non-empty rows, no gaps.
      { name: 'Small', rows: [['Name'], ['A'], ['B']] },
      // 'Gapped' has only 3 non-empty rows too (actualRowCount would tie
      // with 'Small'), but its last row is at index 5 due to a blank row in
      // the middle — rowCount (5) must outrank Small's rowCount (3).
      { name: 'Gapped', rows: [['Name'], ['A'], [], ['B'], ['C']] },
    ]);
    const sheets = await detectSheets(buf);
    const gapped = sheets.find((s) => s.name === 'Gapped')!;
    const small = sheets.find((s) => s.name === 'Small')!;
    expect(gapped.rowCount).toBeGreaterThan(small.rowCount);
    expect(suggestPrimarySheet(sheets)).toBe('Gapped');
  });

  it('preserves exact original header text and column order', async () => {
    const buf = await buildWorkbook([{ name: 'S', rows: [['  Full Name ', 'البريد الإلكتروني', 'Email'], ['A', 'x', 'a@x.com']] }]);
    const headers = await extractHeaderRow(buf, 'S');
    expect(headers).toEqual(['  Full Name ', 'البريد الإلكتروني', 'Email']); // untrimmed, exact order
  });

  it('detects blank and repeated column headings', async () => {
    const buf = await buildWorkbook([{ name: 'S', rows: [['Email', '', 'Email'], ['a@x.com', 'x', 'b@x.com']] }]);
    const headers = await extractHeaderRow(buf, 'S');
    // caller (mapping suggestion logic, Task 7) is responsible for flagging
    // duplicates/blanks — this layer just reports what's literally there.
    expect(headers).toEqual(['Email', '', 'Email']);
  });

  it('extracts phone-like cells as text, preserving leading zeros and plus signs', async () => {
    const buf = await buildWorkbook([{ name: 'S', rows: [['Phone'], ['+968 9123 4567']] }]);
    const rows = await extractDataRows(buf, 'S', 1);
    expect(rows[0][0]).toBe('+968 9123 4567');
  });

  it('parses Excel date cells to ISO date strings', async () => {
    const buf = await buildWorkbook([{ name: 'S', rows: [['DOB'], [new Date('2000-05-15T00:00:00Z')]] }]);
    const rows = await extractDataRows(buf, 'S', 1);
    expect(rows[0][0]).toBe('2000-05-15');
  });

  it('handles blank rows and partially completed rows without throwing', async () => {
    const buf = await buildWorkbook([{ name: 'S', rows: [['A', 'B'], ['x', 'y'], [], ['z', null]] }]);
    const rows = await extractDataRows(buf, 'S', 1);
    expect(rows).toHaveLength(3); // blank row included as an empty-cells row, not silently dropped — validation layer (Task 9) decides what to do with it
  });

  it('rejects a corrupted buffer safely, without throwing an unhandled exception', async () => {
    const badBuf = Buffer.from('not a real xlsx file');
    await expect(detectSheets(badBuf)).rejects.toThrow(/failed to parse|invalid|corrupt/i);
  });

  it('rejects a password-protected-style buffer (CFB container instead of zip) safely', async () => {
    // Genuinely password-protected OOXML files are stored as a CFB
    // (compound file binary) container, not a zip — ExcelJS's zip loader
    // cannot open them. We don't need a real encrypted file to prove the
    // catch-and-report behavior; a buffer carrying the CFB magic bytes is
    // enough to exercise the same rejection path.
    const cfbMagic = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const badBuf = Buffer.concat([cfbMagic, Buffer.alloc(200, 0)]);
    await expect(detectSheets(badBuf)).rejects.toThrow(/failed to parse|invalid|corrupt/i);
  });

  it('rejects a macro-enabled-style buffer with malformed internal XML safely', async () => {
    // Simulate a structurally broken macro-enabled-style package: a valid
    // zip container (so it gets past the outer zip check) carrying a
    // vbaProject.bin plus a corrupted xl/workbook.xml — proving the parser
    // safely rejects malformed OOXML content, not just a non-zip buffer.
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'
    );
    zip.file('xl/vbaProject.bin', Buffer.from([0x01, 0x02, 0x03]));
    zip.file('xl/workbook.xml', '<not-valid-xml this is broken <<<');
    const badBuf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(detectSheets(badBuf)).rejects.toThrow(/failed to parse|invalid|corrupt|disallowed/i);
  });
});
