// src/app/[locale]/(admin)/attendance/staff-thanks/actions.ts
//
// One-off: send the personal thank-you email to the COY21 team (staff,
// liaisons, team leaders, volunteers). The recipient list is pasted into the
// admin page and never stored in the repository. Hard rule enforced HERE (not
// just in the UI): an address that belongs to a participant (any application
// whose participant_type is set and is not 'volunteer') is never emailed.
// Each address is sent at most once (ledger in audit_logs), one email per
// person, a few at a time so each call stays inside the serverless limit.
'use server';

import { requireAgendaStaffCaller } from '@/lib/agenda/server-helpers';
import { sendTeamThankYouEmail } from '@/lib/email/resend';
import { TEAM_THANKS_LEDGER_TYPE, teamThanksLedgerId } from '@/lib/email/team-thanks';
import { THANKS_SUBJECT, THANKS_PARAGRAPHS } from './thanks-content';

const LEDGER_TYPE = TEAM_THANKS_LEDGER_TYPE;
const ledgerId = teamThanksLedgerId;
const BATCH_SIZE = 5;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

type Service = Awaited<ReturnType<typeof requireAgendaStaffCaller>>['service'];

export type ThanksAnalysis = {
  valid: number;
  invalid: string[];
  blockedParticipants: string[];
  alreadySent: number;
  toSend: string[];
};

function parseEmails(raw: string): { valid: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const token of raw.split(/[\s,;]+/)) {
    const e = token.trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e)) {
      invalid.push(token.trim());
      continue;
    }
    if (!seen.has(e)) {
      seen.add(e);
      valid.push(e);
    }
  }
  return { valid, invalid };
}

async function fetchAllRows<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await page(from, from + 999);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function analyze(service: Service, raw: string, allowParticipants = false): Promise<ThanksAnalysis> {
  const { valid, invalid } = parseEmails(raw);

  const profiles = await fetchAllRows((a, b) => service.from('profiles').select('id, email').range(a, b));
  const apps = await fetchAllRows((a, b) => service.from('applications').select('applicant_id, imported_email, participant_type').range(a, b));
  const profileByEmail = new Map(profiles.map((p) => [(p.email ?? '').toLowerCase(), p.id]));
  const appByApplicant = new Map(apps.filter((a) => a.applicant_id).map((a) => [a.applicant_id as string, a]));
  const appByImported = new Map(apps.filter((a) => a.imported_email).map((a) => [(a.imported_email as string).toLowerCase(), a]));

  const isParticipant = (email: string) => {
    const pid = profileByEmail.get(email);
    const app = (pid ? appByApplicant.get(pid) : undefined) ?? appByImported.get(email);
    return !!app && !!app.participant_type && app.participant_type !== 'volunteer';
  };

  // Participants are blocked unless the admin explicitly confirmed that the
  // addresses shown on the page are team members.
  const participantAddresses = valid.filter(isParticipant);
  const blockedParticipants = allowParticipants ? [] : participantAddresses;
  const candidates = allowParticipants ? valid : valid.filter((e) => !isParticipant(e));

  const sent = new Set<string>();
  if (candidates.length > 0) {
    const { data } = await service
      .from('audit_logs')
      .select('entity_id')
      .eq('entity_type', LEDGER_TYPE)
      .eq('action', 'sent')
      .in('entity_id', candidates.map(ledgerId));
    for (const r of data ?? []) sent.add(r.entity_id as string);
  }
  const toSend = candidates.filter((e) => !sent.has(ledgerId(e)));
  return { valid: valid.length, invalid, blockedParticipants, alreadySent: candidates.length - toSend.length, toSend };
}

export async function analyzeThanksListAction(raw: string, allowParticipants = false): Promise<ThanksAnalysis> {
  const { service } = await requireAgendaStaffCaller();
  return analyze(service, raw, allowParticipants);
}

/** Sends the real email to the signed-in admin only, to preview it. */
export async function sendThanksTestAction(): Promise<{ to: string | null; error: string | null }> {
  const { userId, service } = await requireAgendaStaffCaller();
  const { data: profile } = await service.from('profiles').select('email').eq('id', userId).single();
  if (!profile?.email) return { to: null, error: 'Your account has no email address' };
  const r = await sendTeamThankYouEmail({ to: profile.email, subject: THANKS_SUBJECT, paragraphs: THANKS_PARAGRAPHS });
  return { to: profile.email, error: r.error };
}

export async function sendThanksBatchAction(raw: string, allowParticipants = false): Promise<{ sent: number; failed: number; remaining: number; error: string | null }> {
  const { userId, service } = await requireAgendaStaffCaller();
  const analysis = await analyze(service, raw, allowParticipants);
  const batch = analysis.toSend.slice(0, BATCH_SIZE);
  let sent = 0;
  let failed = 0;
  let firstError: string | null = null;
  for (const email of batch) {
    const r = await sendTeamThankYouEmail({ to: email, subject: THANKS_SUBJECT, paragraphs: THANKS_PARAGRAPHS });
    if (r.error) {
      failed++;
      firstError ??= r.error;
    } else {
      sent++;
      await service.from('audit_logs').insert({
        entity_type: LEDGER_TYPE,
        entity_id: ledgerId(email),
        action: 'sent',
        actor_id: userId,
        metadata: { email },
      });
    }
    await new Promise((res) => setTimeout(res, 700));
  }
  return { sent, failed, remaining: analysis.toSend.length - sent, error: firstError };
}
