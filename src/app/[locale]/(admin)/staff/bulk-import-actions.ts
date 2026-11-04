'use server';

// src/app/[locale]/(admin)/staff/bulk-import-actions.ts
//
// Bulk-creates scanner_device (or any STAFF_ROLES) accounts from an .xlsx
// file, for the real case that motivated this file: ~40 conference
// volunteers, each needing a login, with no practical way to click
// "Create Staff Account" 40 times by hand before the event. Deliberately
// NOT built on the participants import pipeline (import_batches, Storage
// upload, column-mapping UI, preview/confirm/rollback) -- that pipeline
// exists for a re-run-able, undo-able, audited bulk PARTICIPANT import;
// this is a one-shot, immediate "create N accounts now" action with no
// need for staging, mapping, or rollback. Reuses workbook-parser.ts's
// exceljs helpers (already proven on real spreadsheets) rather than
// hand-rolling a second xlsx reader.
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { requireSuperAdmin } from '@/lib/auth/require-super-admin';
import { loadWorkbook } from '@/lib/import/workbook-parser';
import { sendRoleWelcomeEmail, type RoleWelcomeEmailRole } from '@/lib/email/resend';

const XLSX_MAGIC_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // ZIP local-file-header signature -- .xlsx is a ZIP container
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB -- generous for a ~40-row, 2-column sheet
const STAFF_ROLES = ['super_admin', 'staff', 'scanner_device'] as const;

const rowSchema = z.object({
  fullName: z.string().trim().min(2),
  email: z.string().trim().toLowerCase().email(),
});

export type BulkImportRowResult =
  | { row: number; fullName: string; email: string; status: 'created' }
  | { row: number; fullName: string; email: string; status: 'failed'; error: string };

export async function bulkCreateStaffAccounts(
  formData: FormData
): Promise<{ results: BulkImportRowResult[]; createdCount: number; failedCount: number }> {
  const { service } = await requireSuperAdmin();

  const rawRole = formData.get('role');
  if (typeof rawRole !== 'string' || !STAFF_ROLES.includes(rawRole as (typeof STAFF_ROLES)[number])) {
    throw new Error('Invalid role');
  }
  const role = rawRole as (typeof STAFF_ROLES)[number];
  const password = formData.get('password');
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  const file = formData.get('file');
  if (!(file instanceof File)) throw new Error('No file provided');
  if (file.size === 0) throw new Error('File is empty');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(`File exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit`);

  const buffer = Buffer.from(await file.arrayBuffer());
  // Same magic-byte check as the participants importer (uploadImportFile) --
  // never trust a client-declared extension/MIME alone.
  if (!buffer.subarray(0, 4).equals(XLSX_MAGIC_BYTES)) {
    throw new Error('File does not appear to be a valid .xlsx workbook');
  }

  // Sheet name is fixed to "Staff Accounts" -- the exact tab name in the
  // tracker template this feature was built to accept (coy21-scanner-
  // volunteers-tracker.xlsx). No sheet-picker UI, unlike the participants
  // importer -- this feature has exactly one expected input shape.
  const SHEET_NAME = 'Staff Accounts';
  const wb = await loadWorkbook(buffer);
  const ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) throw new Error(`This workbook has no sheet named "${SHEET_NAME}". Use the provided template.`);

  function cellText(cell: ExcelJS.Cell): string {
    if (cell.value === null || cell.value === undefined) return '';
    if (typeof cell.value === 'object' && 'text' in cell.value) return String((cell.value as { text: unknown }).text);
    if (typeof cell.value === 'object' && 'result' in cell.value) return String((cell.value as { result: unknown }).result ?? '');
    return String(cell.value);
  }

  // The template's header row is row 4 (row 1 is a merged title, row 2 a
  // subtitle), but scan for it by content rather than hardcoding "4" --
  // tolerates a volunteer inserting/deleting a row above the header.
  let headerRowNumber = -1;
  let fullNameCol = -1;
  let emailCol = -1;
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const values: string[] = [];
    for (let c = 1; c <= row.cellCount; c++) values[c - 1] = cellText(row.getCell(c)).trim().toLowerCase();
    const fnIdx = values.indexOf('full name');
    const emIdx = values.indexOf('email');
    if (fnIdx !== -1 && emIdx !== -1) {
      headerRowNumber = r;
      fullNameCol = fnIdx + 1; // exceljs columns are 1-indexed
      emailCol = emIdx + 1;
      break;
    }
  }
  if (headerRowNumber === -1) {
    throw new Error('Could not locate the header row (expected "Full Name" and "Email" columns) in the "Staff Accounts" sheet.');
  }

  const results: BulkImportRowResult[] = [];
  let createdCount = 0;
  let failedCount = 0;

  for (let r = headerRowNumber + 1; r <= ws.rowCount; r++) {
    const rowNumber = r;
    const row = ws.getRow(r);
    const rawFullName = cellText(row.getCell(fullNameCol));
    const rawEmail = cellText(row.getCell(emailCol));

    // The template's row immediately after the header is a greyed-out,
    // italic EXAMPLE row ("e.g. Ahmed Al-Fahad" / ahmed.scanner1@...),
    // meant to show the expected format, never a real volunteer to
    // import. Skip it by its known literal placeholder name/email rather
    // than by styling (italic/color isn't read here) or by row position
    // alone (fragile if a row is ever inserted/deleted above it).
    const isTemplateExampleRow = rawFullName.trim() === 'e.g. Ahmed Al-Fahad' || rawEmail.trim() === 'ahmed.scanner1@climatecoy.com';
    if (isTemplateExampleRow) continue;

    // A fully blank row (both columns empty) is not an error -- the
    // template ships with 10 pre-styled blank rows the volunteer count
    // may not fill entirely. Skip silently rather than reporting it as a
    // failed row.
    if (!rawFullName.trim() && !rawEmail.trim()) continue;

    const parsed = rowSchema.safeParse({ fullName: rawFullName, email: rawEmail });
    if (!parsed.success) {
      results.push({
        row: rowNumber,
        fullName: rawFullName,
        email: rawEmail,
        status: 'failed',
        error: parsed.error.issues[0]?.message ?? 'Invalid row',
      });
      failedCount++;
      continue;
    }

    const { data: created, error: createError } = await service.auth.admin.createUser({
      email: parsed.data.email,
      password,
      email_confirm: true,
      user_metadata: { full_name: parsed.data.fullName },
    });

    if (createError || !created.user) {
      results.push({
        row: rowNumber,
        fullName: parsed.data.fullName,
        email: parsed.data.email,
        status: 'failed',
        error: createError?.message ?? 'Failed to create user',
      });
      failedCount++;
      continue;
    }

    const { error: profileError } = await service
      .from('profiles')
      .update({ role, full_name: parsed.data.fullName })
      .eq('id', created.user.id);

    if (profileError) {
      // The auth user now exists but with the wrong role -- surfaced as a
      // failed row so the admin can fix it via "Change Role" in the staff
      // table rather than this silently leaving an orphaned/misconfigured
      // account with no visible error.
      results.push({
        row: rowNumber,
        fullName: parsed.data.fullName,
        email: parsed.data.email,
        status: 'failed',
        error: `Account created but role assignment failed: ${profileError.message}`,
      });
      failedCount++;
      continue;
    }

    results.push({ row: rowNumber, fullName: parsed.data.fullName, email: parsed.data.email, status: 'created' });
    createdCount++;
  }

  return { results, createdCount, failedCount };
}

export type WelcomeEmailSendResult =
  | { email: string; status: 'sent' }
  | { email: string; status: 'failed'; error: string };

// Sends the role-aware welcome email (sendRoleWelcomeEmail) to each
// just-created account from a bulkCreateStaffAccounts batch. Deliberately
// NOT auto-triggered by bulkCreateStaffAccounts itself -- the admin
// reviews the created-accounts table first and clicks a separate "Send
// Welcome Emails" button, same explicit-confirmation requirement as every
// other outbound email batch in this codebase (sandbox mode, confirmation
// phrases, etc.).
const sendWelcomeEmailsRowSchema = z.object({
  fullName: z.string().trim().min(2),
  email: z.string().trim().toLowerCase().email(),
});

export async function sendWelcomeEmailsForBatch(
  rows: { fullName: string; email: string }[],
  role: (typeof STAFF_ROLES)[number],
  temporaryPassword: string
): Promise<{ results: WelcomeEmailSendResult[]; sentCount: number; failedCount: number }> {
  await requireSuperAdmin();

  if (temporaryPassword.length < 8) throw new Error('Password must be at least 8 characters');

  const welcomeRole = role as RoleWelcomeEmailRole;

  const results: WelcomeEmailSendResult[] = [];
  let sentCount = 0;
  let failedCount = 0;

  for (const row of rows) {
    const parsed = sendWelcomeEmailsRowSchema.safeParse(row);
    if (!parsed.success) {
      results.push({ email: row.email, status: 'failed', error: parsed.error.issues[0]?.message ?? 'Invalid row' });
      failedCount++;
      continue;
    }

    const { error } = await sendRoleWelcomeEmail({
      to: parsed.data.email,
      fullName: parsed.data.fullName,
      temporaryPassword,
      role: welcomeRole,
    });

    if (error) {
      results.push({ email: parsed.data.email, status: 'failed', error });
      failedCount++;
      continue;
    }

    results.push({ email: parsed.data.email, status: 'sent' });
    sentCount++;
  }

  return { results, sentCount, failedCount };
}
