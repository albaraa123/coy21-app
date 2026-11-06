// Shared by the admin "thank-you email" page and the scheduled sender in the
// notifications cron, so both use exactly the same once-per-address ledger.
import { createHash } from 'node:crypto';

export const TEAM_THANKS_LEDGER_TYPE = 'team_thank_you';
export const TEAM_THANKS_QUEUE_TYPE = 'team_thanks_queue';

export function teamThanksLedgerId(email: string): string {
  const h = createHash('md5').update(`team-thanks:${email}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
