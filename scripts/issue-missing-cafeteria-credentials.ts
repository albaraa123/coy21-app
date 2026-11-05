// One-off: issue cafeteria credentials for every lunch-eligible participant
// who does not have one yet, using the app's own idempotent issuance
// function (so eligibility is re-checked and existing credentials are kept).
// Run: npx tsx scripts/issue-missing-cafeteria-credentials.ts
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import { issueCafeteriaCredentialForCaller } from '../src/lib/cafeteria/credential-issuance';

const env = Object.fromEntries(
  fs
    .readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')];
    })
);

async function main() {
  const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY) as never;
  const db = service as ReturnType<typeof createClient>;
  const { data: apps } = await db
    .from('applications')
    .select('id, applicant_id')
    .eq('status', 'accepted')
    .eq('attendance_confirmation', 'confirmed')
    .in('participant_type', ['delegate', 'volunteer']);
  const { data: creds } = await db.from('cafeteria_credentials').select('application_id');
  const have = new Set((creds ?? []).map((c: { application_id: string | null }) => c.application_id));
  const todo = (apps ?? []).filter((a: { id: string; applicant_id: string | null }) => a.applicant_id && !have.has(a.id));
  console.log('eligible missing:', todo.length);
  const tally: Record<string, number> = {};
  for (const a of todo as { id: string; applicant_id: string }[]) {
    const r = await issueCafeteriaCredentialForCaller({ userId: a.applicant_id, service });
    tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;
    if (r.outcome === 'error') console.log('error', a.id, r.message);
  }
  console.log(tally);
}
main();
