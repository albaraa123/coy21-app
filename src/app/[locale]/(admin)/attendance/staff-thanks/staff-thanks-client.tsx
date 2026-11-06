'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { analyzeThanksListAction, sendThanksBatchAction, sendThanksTestAction, type ThanksAnalysis } from './actions';

export default function StaffThanksClient({ subject, paragraphs }: { subject: string; paragraphs: string[] }) {
  const [raw, setRaw] = useState('');
  const [analysis, setAnalysis] = useState<ThanksAnalysis | null>(null);
  const [allowTeam, setAllowTeam] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sentTotal, setSentTotal] = useState(0);
  const [failedTotal, setFailedTotal] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  async function analyze(allow = allowTeam) {
    setBusy(true);
    setMessage(null);
    try {
      setAnalysis(await analyzeThanksListAction(raw, allow));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await sendThanksTestAction();
      setMessage(r.error ? `Test failed: ${r.error}` : `Test email sent to ${r.to}. Check your inbox.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function sendAll() {
    setBusy(true);
    setMessage(null);
    let sent = 0;
    let failed = 0;
    try {
      for (let i = 0; i < 60; i++) {
        const r = await sendThanksBatchAction(raw, allowTeam);
        sent += r.sent;
        failed += r.failed;
        setSentTotal(sent);
        setFailedTotal(failed);
        if (r.remaining <= 0) break;
        if (r.sent === 0) {
          setMessage(r.error ?? 'No progress was made.');
          break;
        }
      }
      setAnalysis(await analyzeThanksListAction(raw, allowTeam));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-charcoal/10 p-4 dark:border-gray-700">
        <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">Subject</h2>
        <p className="mb-4 text-sm text-charcoal dark:text-gray-200">{subject}</p>
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto text-sm text-charcoal/80 dark:text-gray-300">
          {paragraphs.map((p, i) => (
            <p key={i} className="whitespace-pre-line">{p}</p>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <label htmlFor="recipients" className="text-sm font-semibold text-charcoal dark:text-gray-100">
          Paste the email addresses (one per line, or separated by commas)
        </label>
        <textarea
          id="recipients"
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setAnalysis(null);
            setConfirmSend(false);
          }}
          rows={8}
          className="w-full rounded-md border border-charcoal/20 bg-white p-2 text-sm text-charcoal dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => analyze()} disabled={busy || raw.trim() === ''}>Check the list</Button>
          <Button variant="secondary" onClick={sendTest} disabled={busy}>Send me a test email first</Button>
        </div>
      </section>

      {analysis ? (
        <section className="flex flex-col gap-3 rounded-lg border border-charcoal/10 p-4 text-sm text-charcoal dark:border-gray-700 dark:text-gray-100">
          <p>
            Valid addresses: <strong>{analysis.valid}</strong> · Already sent before: <strong>{analysis.alreadySent}</strong> · Will be sent:{' '}
            <strong>{analysis.toSend.length}</strong>
          </p>
          {analysis.invalid.length > 0 ? <p className="text-red-700">Invalid (ignored): {analysis.invalid.join(', ')}</p> : null}
          {analysis.blockedParticipants.length > 0 ? (
            <div className="rounded-md border border-amber-500/60 bg-amber-50 p-3 dark:bg-gray-800">
              <p className="mb-1 font-medium">Registered on the platform as participants (blocked, not sent):</p>
              <ul className="mb-2 list-disc pl-5">
                {analysis.blockedParticipants.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={allowTeam}
                  onChange={(e) => {
                    setAllowTeam(e.target.checked);
                    void analyze(e.target.checked);
                  }}
                />
                <span>I confirm these people are COY21 team members, include them.</span>
              </label>
            </div>
          ) : allowTeam ? (
            <p className="text-amber-700">Team members registered as participants are included.</p>
          ) : null}
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={confirmSend} onChange={(e) => setConfirmSend(e.target.checked)} />
            <span>I checked the test email and I want to send it to these {analysis.toSend.length} people.</span>
          </label>
          <Button onClick={sendAll} disabled={busy || !confirmSend || analysis.toSend.length === 0}>
            {busy ? 'Sending…' : `Send to ${analysis.toSend.length} people`}
          </Button>
        </section>
      ) : null}

      {sentTotal > 0 || failedTotal > 0 ? (
        <p className="text-sm text-charcoal dark:text-gray-100">
          Sent in this run: <strong>{sentTotal}</strong> · Failed: <strong>{failedTotal}</strong>
        </p>
      ) : null}
      {message ? <p className="text-sm text-charcoal dark:text-gray-100">{message}</p> : null}
    </div>
  );
}
