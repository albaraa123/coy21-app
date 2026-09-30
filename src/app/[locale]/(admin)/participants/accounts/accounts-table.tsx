'use client';

// src/app/[locale]/(admin)/participants/accounts/accounts-table.tsx
//
// Phase C (design doc section 14.6-14.8): admin account-management table.
// Selection state is a client-side Set<applicationId> — deliberately NOT
// URL state (an unbounded selection would blow up the URL) — so it
// survives filter/pagination changes within this page's lifetime, exactly
// as the design requires ("selection must work safely across pagination").
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  createAccountsForSelected,
  createAccountsAndSendLoginDetails,
  sendLoginDetailsForSelected,
  resendLoginDetails,
  retryFailedForSelected,
  retryFailedEmailsForSelected,
  resetSelectedToTemporaryPassword,
  changeClassificationForSelected,
  type ProvisioningItemResult,
  type ClassificationChangeResult,
} from './actions';
import ClassificationDialog from './classification-dialog';
import type { Database } from '@/types/database';

type ParticipantType = Database['public']['Enums']['participant_type'];

export type AccountStatus =
  | 'no_account' | 'account_created' | 'password_change_required'
  | 'active' | 'existing_account' | 'creation_failed' | 'conflict';
export type EmailStatus = 'not_sent' | 'sending' | 'sent' | 'delivered' | 'bounced' | 'failed';

export interface AccountRow {
  applicationId: string;
  fullName: string;
  username: string;
  importBatchId: string | null;
  importBatchName: string | null;
  accountStatus: AccountStatus;
  emailStatus: EmailStatus;
  mustChangePassword: boolean;
  lastLoginEmailSentAt: string | null;
  loginEmailSendCount: number;
  lastErrorMessage: string | null;
  participantType: string | null;
}

type BulkActionKind = 'create' | 'createAndSend' | 'send' | 'resend' | 'retryFailed' | 'retryFailedEmails' | 'reset' | 'changeClassification';

// Threshold above which the confirmation dialog carries an extra, more
// prominent warning before sending — design doc section 14/15, §9's
// "You are about to send login details to [number] participants." notice.
const LARGE_SEND_WARNING_THRESHOLD = 50;

const EMAIL_STATUS_BADGE: Record<EmailStatus, 'mandatory' | 'elective' | 'cancelled' | 'changed' | 'pending' | 'neutral'> = {
  not_sent: 'neutral',
  sending: 'pending',
  sent: 'elective',
  delivered: 'changed',
  bounced: 'cancelled',
  failed: 'cancelled',
};

const ACCOUNT_STATUS_BADGE: Record<AccountStatus, 'mandatory' | 'elective' | 'cancelled' | 'changed' | 'pending' | 'neutral'> = {
  no_account: 'neutral',
  account_created: 'pending',
  password_change_required: 'mandatory',
  active: 'changed',
  existing_account: 'elective',
  creation_failed: 'cancelled',
  conflict: 'cancelled',
};

function temporaryPasswordDisplay(status: AccountStatus, mustChangePassword: boolean): string {
  if (status === 'no_account') return 'No account';
  if (status === 'existing_account') return 'Existing password';
  if (mustChangePassword) return 'password@123';
  return 'Password changed';
}

export default function AccountsTable({
  rows,
  batches,
}: {
  rows: AccountRow[];
  batches: { id: string; name: string }[];
}) {
  const t = useTranslations('participants.accounts');
  // Reuses the same types.* keys as participants/[applicationId]/
  // classification-controls.tsx (Task 5) rather than duplicating the 5
  // participant_type labels under a second namespace.
  const tTypes = useTranslations('participants.classification');
  const [search, setSearch] = useState('');
  const [batchFilter, setBatchFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [emailFilter, setEmailFilter] = useState<string>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<BulkActionKind | null>(null);
  const [resetConfirmText, setResetConfirmText] = useState('');
  const [processing, setProcessing] = useState(false);
  const [results, setResults] = useState<ProvisioningItemResult[] | null>(null);
  // Separate from `results` above: changeClassificationForSelected returns
  // ClassificationChangeResult[], a different outcome union than every
  // other bulk action here (ProvisioningItemResult[]) — kept in its own
  // state rather than forcing a combined union onto `results` and
  // `progressSummary`, which are typed specifically around
  // ProvisioningItemResult's outcome values.
  const [classificationResults, setClassificationResults] = useState<ClassificationChangeResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (search.trim() !== '') {
        const q = search.trim().toLowerCase();
        if (!row.fullName.toLowerCase().includes(q) && !row.username.toLowerCase().includes(q)) return false;
      }
      if (batchFilter !== 'all' && row.importBatchId !== batchFilter) return false;
      if (statusFilter !== 'all' && row.accountStatus !== statusFilter) return false;
      if (emailFilter !== 'all' && row.emailStatus !== emailFilter) return false;
      return true;
    });
  }, [rows, search, batchFilter, statusFilter, emailFilter]);

  function toggleRow(applicationId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(applicationId)) next.delete(applicationId);
      else next.add(applicationId);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const row of filteredRows) next.add(row.applicationId);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.applicationId)), [rows, selected]);

  const dialogCounts = useMemo(() => {
    const newAccounts = selectedRows.filter((r) => r.accountStatus === 'no_account').length;
    const existingToLink = selectedRows.filter((r) => r.accountStatus === 'no_account').length; // resolved precisely only after processing — see design doc 14.7
    const emailsToSend = selectedRows.filter((r) => r.accountStatus === 'account_created' || r.accountStatus === 'password_change_required').length;
    const conflicts = selectedRows.filter((r) => r.accountStatus === 'conflict').length;
    const skipped = selectedRows.filter((r) => r.accountStatus === 'existing_account').length;
    return { total: selectedRows.length, newAccounts, existingToLink, emailsToSend, conflicts, skipped };
  }, [selectedRows]);

  async function runAction(kind: BulkActionKind) {
    setProcessing(true);
    setError(null);
    setResults(null);
    try {
      const ids = [...selected];
      let outcome: ProvisioningItemResult[];
      switch (kind) {
        case 'create':
          outcome = await createAccountsForSelected(ids);
          break;
        case 'createAndSend':
          outcome = await createAccountsAndSendLoginDetails(ids);
          break;
        case 'send':
          outcome = await sendLoginDetailsForSelected(ids);
          break;
        case 'resend':
          outcome = await resendLoginDetails(ids);
          break;
        case 'retryFailed':
          outcome = await retryFailedForSelected(ids);
          break;
        case 'retryFailedEmails':
          outcome = await retryFailedEmailsForSelected(ids);
          break;
        case 'reset':
          outcome = await resetSelectedToTemporaryPassword(ids);
          break;
        case 'changeClassification':
          // Never reached: the classification dialog calls
          // runClassificationChange directly (it needs the selected
          // participant_type, which this kind-only signature doesn't
          // carry) instead of going through runAction. This case exists
          // only so the switch stays exhaustive over BulkActionKind.
          throw new Error('changeClassification must be run via runClassificationChange');
      }
      setResults(outcome);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('genericError'));
    } finally {
      setProcessing(false);
      setPendingAction(null);
      setResetConfirmText('');
    }
  }

  async function runClassificationChange(newType: ParticipantType) {
    setProcessing(true);
    setError(null);
    setClassificationResults(null);
    try {
      const ids = [...selected];
      const outcome = await changeClassificationForSelected(ids, newType);
      setClassificationResults(outcome);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('genericError'));
    } finally {
      setProcessing(false);
      setPendingAction(null);
    }
  }

  const classificationProgressSummary = useMemo(() => {
    if (!classificationResults) return null;
    const count = (outcome: ClassificationChangeResult['outcome']) => classificationResults.filter((r) => r.outcome === outcome).length;
    return {
      selected: selected.size,
      updatedOnly: count('updated_only'),
      numberRegenerated: count('number_regenerated'),
      reissued: count('reissued'),
      failed: count('error'),
    };
  }, [classificationResults, selected.size]);

  const progressSummary = useMemo(() => {
    if (!results) return null;
    const count = (outcome: ProvisioningItemResult['outcome']) => results.filter((r) => r.outcome === outcome).length;
    const skipped = count('not_eligible') + count('email_skipped');
    const failed = count('error') + count('email_failed');
    const conflicts = count('conflict');
    const succeeded = count('account_created') + count('existing_account_linked') + count('email_sent') + count('password_reset');
    return {
      selected: selected.size,
      eligible: results.length,
      created: count('account_created'),
      linked: count('existing_account_linked'),
      emailsSent: count('email_sent'),
      failed,
      conflicts,
      skipped,
      // "Remaining" reflects selected ids the last action never even
      // attempted (e.g. a server-side pre-filter like retryFailedForSelected
      // excluding already-successful rows before dispatching) — a
      // non-negative floor guards against a filtered dispatch legitimately
      // processing fewer than the full selection without implying a
      // negative remainder.
      remaining: Math.max(0, selected.size - (succeeded + failed + conflicts + skipped)),
    };
  }, [results, selected.size]);

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('searchPlaceholder')}
          className="rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-sm text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-turquoise dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        />
        <select
          value={batchFilter}
          onChange={(e) => setBatchFilter(e.target.value)}
          className="rounded-md border border-charcoal/20 bg-warm-white px-2 py-1 text-sm text-charcoal dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        >
          <option value="all">{t('filterAllBatches')}</option>
          {batches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-charcoal/20 bg-warm-white px-2 py-1 text-sm text-charcoal dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        >
          <option value="all">{t('filterAllStatuses')}</option>
          <option value="no_account">{t('presetNoAccount')}</option>
          <option value="password_change_required">{t('presetPasswordChangeRequired')}</option>
          <option value="active">{t('presetActive')}</option>
          <option value="existing_account">{t('noAccount')}</option>
          <option value="creation_failed">{t('presetFailedOrConflict')}</option>
          <option value="conflict">{t('presetFailedOrConflict')}</option>
        </select>
        <select
          value={emailFilter}
          onChange={(e) => setEmailFilter(e.target.value)}
          className="rounded-md border border-charcoal/20 bg-warm-white px-2 py-1 text-sm text-charcoal dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
        >
          <option value="all">{t('filterAllStatuses')}</option>
          <option value="not_sent">{t('presetNoEmail')}</option>
          <option value="sent">{t('filterEmailStatus')}</option>
          <option value="failed">{t('presetFailedOrConflict')}</option>
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" variant="secondary" onClick={selectAllVisible}>
          {t('selectAll')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={clearSelection}>
          {t('clearSelection')}
        </Button>
        <span className="text-sm text-charcoal/70 dark:text-gray-400">{t('selectedCount', { count: selected.size })}</span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700">
        <table className="w-full text-start text-sm">
          <thead>
            <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
              <th scope="col" className="px-4 py-2" />
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('colName')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('colUsername')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('colTempPassword')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('colBatch')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('colParticipantType')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('colAccountStatus')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('colEmailStatus')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('colLastEmail')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('colSendCount')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('colFailureReason')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
            {filteredRows.map((row) => (
              <tr key={row.applicationId}>
                <td className="px-4 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(row.applicationId)}
                    onChange={() => toggleRow(row.applicationId)}
                  />
                </td>
                <td className="px-4 py-2 text-charcoal dark:text-gray-100">{row.fullName}</td>
                <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{row.username}</td>
                <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                  {temporaryPasswordDisplay(row.accountStatus, row.mustChangePassword)}
                </td>
                <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{row.importBatchName ?? ''}</td>
                <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                  {row.participantType ? tTypes(`types.${row.participantType}`) : ''}
                </td>
                <td className="px-4 py-2">
                  <Badge variant={ACCOUNT_STATUS_BADGE[row.accountStatus]}>{row.accountStatus}</Badge>
                </td>
                <td className="px-4 py-2">
                  <Badge variant={EMAIL_STATUS_BADGE[row.emailStatus]}>{row.emailStatus}</Badge>
                </td>
                <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                  {row.lastLoginEmailSentAt ? new Date(row.lastLoginEmailSentAt).toLocaleString() : ''}
                </td>
                <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{row.loginEmailSendCount}</td>
                <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{row.lastErrorMessage ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={selected.size === 0} onClick={() => setPendingAction('create')}>
          {t('actionCreate')}
        </Button>
        <Button type="button" size="sm" disabled={selected.size === 0} onClick={() => setPendingAction('createAndSend')}>
          {t('actionCreateAndSend')}
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={selected.size === 0} onClick={() => setPendingAction('send')}>
          {t('actionSendLogin')}
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={selected.size === 0} onClick={() => setPendingAction('resend')}>
          {t('actionResend')}
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={selected.size === 0} onClick={() => setPendingAction('retryFailed')}>
          {t('actionRetryFailed')}
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={selected.size === 0} onClick={() => setPendingAction('retryFailedEmails')}>
          {t('actionRetryFailedEmails')}
        </Button>
        <Button type="button" size="sm" variant="destructive" disabled={selected.size === 0} onClick={() => setPendingAction('reset')}>
          {t('actionResetPassword')}
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={selected.size === 0} onClick={() => setPendingAction('changeClassification')}>
          {t('actionChangeClassification')}
        </Button>
      </div>

      {pendingAction === 'changeClassification' && (
        <ClassificationDialog
          selectedCount={selected.size}
          processing={processing}
          onConfirm={(newType) => void runClassificationChange(newType)}
          onCancel={() => setPendingAction(null)}
        />
      )}

      {pendingAction && pendingAction !== 'changeClassification' && (
        <div role="dialog" className="flex flex-col gap-3 rounded-lg border border-gold bg-gold/10 p-4 dark:border-amber-700 dark:bg-amber-900/20">
          <h2 className="text-sm font-semibold text-charcoal dark:text-gray-100">{t('confirmTitle')}</h2>
          <p className="text-sm text-charcoal dark:text-gray-100">{t('confirmSelected', { count: dialogCounts.total })}</p>
          {(pendingAction === 'createAndSend' || pendingAction === 'send' || pendingAction === 'resend') &&
            dialogCounts.total >= LARGE_SEND_WARNING_THRESHOLD && (
              <p className="text-sm font-medium text-red-700 dark:text-red-300">
                {t('largeSendWarning', { count: dialogCounts.total })}
              </p>
            )}
          {(pendingAction === 'create' || pendingAction === 'createAndSend') && (
            <>
              <p className="text-sm text-charcoal dark:text-gray-100">{t('confirmNewAccounts', { count: dialogCounts.newAccounts })}</p>
              <p className="text-sm text-charcoal dark:text-gray-100">{t('confirmExisting', { count: dialogCounts.existingToLink })}</p>
            </>
          )}
          {(pendingAction === 'createAndSend' || pendingAction === 'send' || pendingAction === 'resend') && (
            <p className="text-sm text-charcoal dark:text-gray-100">{t('confirmEmails', { count: dialogCounts.emailsToSend })}</p>
          )}
          <p className="text-sm text-charcoal dark:text-gray-100">{t('confirmConflicts', { count: dialogCounts.conflicts })}</p>
          <p className="text-sm text-charcoal dark:text-gray-100">{t('confirmSkipped', { count: dialogCounts.skipped })}</p>
          {pendingAction === 'reset' && (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-red-700 dark:text-red-300">{t('confirmResetWarning', { count: dialogCounts.total })}</p>
              <input
                type="text"
                value={resetConfirmText}
                onChange={(e) => setResetConfirmText(e.target.value)}
                placeholder={t('confirmResetInputPlaceholder')}
                className="w-full max-w-xs rounded-md border border-charcoal/20 bg-warm-white px-3 py-2 text-sm text-charcoal dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={processing || (pendingAction === 'reset' && resetConfirmText !== 'CONFIRM')}
              onClick={() => void runAction(pendingAction)}
            >
              {processing ? t('processing') : t('confirmButton')}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={processing} onClick={() => setPendingAction(null)}>
              {t('cancelButton')}
            </Button>
          </div>
        </div>
      )}

      {progressSummary && (
        <div className="flex flex-col gap-1 rounded-lg border border-charcoal/10 p-4 dark:border-gray-700">
          <p className="text-sm text-charcoal dark:text-gray-100">{t('progressSelected', { count: progressSummary.selected })}</p>
          <p className="text-sm text-charcoal dark:text-gray-100">{t('progressEligible', { count: progressSummary.eligible })}</p>
          <p className="text-sm text-charcoal dark:text-gray-100">{t('progressCreated', { count: progressSummary.created })}</p>
          <p className="text-sm text-charcoal dark:text-gray-100">{t('progressLinked', { count: progressSummary.linked })}</p>
          <p className="text-sm text-charcoal dark:text-gray-100">{t('progressEmailsSent', { count: progressSummary.emailsSent })}</p>
          <p className="text-sm text-charcoal dark:text-gray-100">{t('progressFailed', { count: progressSummary.failed })}</p>
          <p className="text-sm text-charcoal dark:text-gray-100">{t('progressConflicts', { count: progressSummary.conflicts })}</p>
          <p className="text-sm text-charcoal dark:text-gray-100">{t('progressSkipped', { count: progressSummary.skipped })}</p>
          <p className="text-sm text-charcoal dark:text-gray-100">{t('progressRemaining', { count: progressSummary.remaining })}</p>
        </div>
      )}

      {classificationProgressSummary && (
        <div className="flex flex-col gap-1 rounded-lg border border-charcoal/10 p-4 dark:border-gray-700">
          <p className="text-sm text-charcoal dark:text-gray-100">{t('progressSelected', { count: classificationProgressSummary.selected })}</p>
          <p className="text-sm text-charcoal dark:text-gray-100">{t('changeClassificationUpdatedOnly', { count: classificationProgressSummary.updatedOnly })}</p>
          <p className="text-sm text-charcoal dark:text-gray-100">{t('changeClassificationNumberRegenerated', { count: classificationProgressSummary.numberRegenerated })}</p>
          <p className="text-sm text-charcoal dark:text-gray-100">{t('changeClassificationReissued', { count: classificationProgressSummary.reissued })}</p>
          <p className="text-sm text-charcoal dark:text-gray-100">{t('progressFailed', { count: classificationProgressSummary.failed })}</p>
        </div>
      )}
    </div>
  );
}
