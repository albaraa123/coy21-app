// src/lib/import/workbook-parser.ts
import ExcelJS from 'exceljs';

export interface SheetInfo {
  name: string;
  rowCount: number;
}

export async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  try {
    // exceljs's own index.d.ts declares a broken ambient shim
    // (`declare interface Buffer extends ArrayBuffer {}`) that shadows
    // Node's real generic `Buffer<ArrayBufferLike>` type, making a
    // structurally-identical Buffer look incompatible to tsc at this call
    // boundary. Cast through `unknown` here rather than weakening this
    // function's public signature — the runtime value is a real Node
    // Buffer either way, exceljs just can't type it correctly.
    await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  } catch (err) {
    throw new Error(`Failed to parse workbook: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
  return wb;
}

export async function detectSheets(buffer: Buffer): Promise<SheetInfo[]> {
  const wb = await loadWorkbook(buffer);
  const sheets: SheetInfo[] = [];
  wb.eachSheet((worksheet) => {
    // actualRowCount (non-empty row count) is the right check for "is this
    // sheet genuinely empty" — a sheet with zero non-empty rows has no data
    // regardless of gaps. But rowCount (highest row index with any content)
    // is the right value to report/rank by, for the same reason
    // extractDataRows uses it below: actualRowCount undercounts a sheet with
    // internal blank-row gaps (e.g. [data], [], [data]), which would make
    // suggestPrimarySheet rank a gapped sheet below a smaller, gap-free one.
    if (worksheet.actualRowCount > 0) sheets.push({ name: worksheet.name, rowCount: worksheet.rowCount });
  });
  return sheets;
}

export function suggestPrimarySheet(sheets: SheetInfo[]): string | null {
  if (sheets.length === 0) return null;
  return sheets.reduce((best, s) => (s.rowCount > best.rowCount ? s : best), sheets[0]).name;
}

function cellToValue(cell: ExcelJS.Cell): string | null {
  if (cell.value === null || cell.value === undefined) return null;
  if (cell.value instanceof Date) {
    // Preserve as an ISO date (not datetime) — sufficient for the
    // birth_date/registration-date fields this importer handles; a caller
    // needing time-of-day precision is out of scope for this phase's
    // participant-registration data.
    return cell.value.toISOString().slice(0, 10);
  }
  if (typeof cell.value === 'object' && 'result' in cell.value) {
    // Formula cell — use its computed result, never the formula text.
    const result = (cell.value as { result: unknown }).result;
    return result === null || result === undefined ? null : String(result);
  }
  if (typeof cell.value === 'object' && 'text' in cell.value) {
    // Rich-text cell (also covers hyperlink cells, which carry a `text`
    // field alongside `hyperlink`).
    return String((cell.value as { text: unknown }).text);
  }
  // Known blind spot: an object cell value with neither `result` nor `text`
  // (e.g. an error cell like `{ error: '#DIV/0!' }`, or a shared-formula
  // cell with no cached result) falls through to here and stringifies to
  // "[object Object]" rather than raising. Accepted for this phase's scope
  // — participant-registration spreadsheets are not expected to carry
  // formulas/errors — but flagged so a future caller hitting this doesn't
  // have to rediscover it from scratch.
  return String(cell.value);
}

export async function extractHeaderRow(buffer: Buffer, sheetName: string): Promise<string[]> {
  const wb = await loadWorkbook(buffer);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new Error(`Sheet "${sheetName}" not found`);
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber - 1] = cellToValue(cell) ?? '';
  });
  return headers;
}

export async function extractDataRows(buffer: Buffer, sheetName: string, headerRowNumber: number): Promise<(string | null)[][]> {
  const wb = await loadWorkbook(buffer);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new Error(`Sheet "${sheetName}" not found`);
  const columnCount = ws.getRow(headerRowNumber).cellCount;
  const rows: (string | null)[][] = [];
  // Use rowCount (highest row index with any content), not actualRowCount
  // (count of non-empty rows) — actualRowCount undercounts when a sheet has
  // gaps, causing the loop to stop before reaching later, non-blank rows
  // (e.g. rows: [data], [], [data] — actualRowCount is 2, but row 3 exists
  // at index 3 and must still be reached).
  for (let r = headerRowNumber + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    // Include every row within the sheet's row range, even ones with zero
    // cells written (a fully blank row within the data range) — the caller
    // (validation layer, Task 9/10) decides what to do with blank rows;
    // this layer must not silently drop them, since a blank row is still
    // meaningful positional information (e.g. "row 5 in the original file
    // was empty") that a later error message may need to reference.
    const values: (string | null)[] = [];
    for (let c = 1; c <= columnCount; c++) {
      values[c - 1] = cellToValue(row.getCell(c));
    }
    rows.push(values);
  }
  return rows;
}
