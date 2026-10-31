'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/routing';
import { createParticipantApplication } from './actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Card } from '@/components/ui/card';

const PARTICIPANT_TYPES = [
  { value: 'delegate', label: 'Delegate' },
  { value: 'volunteer', label: 'Volunteer' },
  { value: 'knowledge_partner', label: 'Knowledge Partner' },
  { value: 'youngo', label: 'YOUNGO' },
  { value: 'speaker', label: 'Speaker' },
] as const;

const EMPTY_FORM = {
  fullName: '',
  email: '',
  participantType: 'delegate' as string,
  phone: '',
  country: '',
  nationality: '',
  organization: '',
};

export default function NewApplicationForm() {
  const router = useRouter();
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { id } = await createParticipantApplication(form as Parameters<typeof createParticipantApplication>[0]);
      toast.success('Participant application created');
      // /participants/{id} (NOT /applications/{id}) -- two separate detail
      // pages exist for the same applications table. /applications/[id] is
      // the legacy review-workflow page (status transitions, reviewer
      // assignment) and excludes status='draft', but critically does NOT
      // mount InvitationControls at all. /participants/[applicationId] is
      // the newer page built specifically for imported/unclaimed rows --
      // read-only data plus the Send/Resend/Revoke Invitation controls this
      // whole flow depends on. Confirmed live (manual QA, 2026-11-01): a
      // freshly created application redirected to /applications/{id}
      // rendered with blank Name/Email and no invitation button anywhere.
      router.push(`/participants/${id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create application';
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && (
          <p role="alert" className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}

        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          Full name
          <Input
            type="text"
            required
            value={form.fullName}
            onChange={(e) => setForm({ ...form, fullName: e.target.value })}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          Email
          <Input
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          Participant type
          <Select
            required
            value={form.participantType}
            onChange={(e) => setForm({ ...form, participantType: e.target.value })}
          >
            {PARTICIPANT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </Select>
        </label>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            Phone
            <Input
              type="tel"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            Country
            <Input
              type="text"
              value={form.country}
              onChange={(e) => setForm({ ...form, country: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            Nationality
            <Input
              type="text"
              value={form.nationality}
              onChange={(e) => setForm({ ...form, nationality: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
            Organization
            <Input
              type="text"
              value={form.organization}
              onChange={(e) => setForm({ ...form, organization: e.target.value })}
            />
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create application'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
