'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/routing';
import { triggerProcessChangeEvents, triggerStageFromChangeEvents } from './actions';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

type ChangeEvent = {
  id: string;
  session_id: string;
  change_type: string;
  detected_at: string;
  sessions: { id: string; session_code: string; title_en: string } | null;
};

type ProcessedEvent = {
  id: string;
  session_id: string;
  change_type: string;
  detected_at: string;
};

type PublicationRef = { id: string; application_id: string; status: string };

type StaleItem = {
  id: string;
  session_id: string | null;
  item_status: string;
  session_title_en: string | null;
  room_name_en: string | null;
  start_time: string | null;
  end_time: string | null;
  schedule_publication_id: string;
  schedule_publications: PublicationRef | PublicationRef[] | null;
};

function formatDate(value: string) {
  return new Date(value).toLocaleString('en-US', { timeZone: 'Europe/Istanbul' });
}

// schedule_change_events has no FK to schedule_publication_items — the only
// correlation available is session_id. By the time an item shows as
// stale/pending_review, the change event(s) that caused it have already
// been marked processed_at (processChangeEvents marks items stale THEN
// marks the causing events processed, in the same pass). So "most recently
// processed events for this session_id" is the best available proxy for
// "the events that caused this group's staleness" — there is no run-id or
// batch marker to pin it down exactly. This is safe to pass to
// triggerStageFromChangeEvents because stage_publication_transactional
// (see resolve_change_event_session_ids) only ever uses the event ids to
// resolve session_id (and, for blocking, change_type = 'cancelled') — it
// never inspects processed_at. So passing a superset/most-recent-per-type
// selection of processed events for the session is functionally
// equivalent to passing the exact causing events, as long as it resolves
// to the same session_id and preserves any 'cancelled' change_type.
function selectRelevantEventIds(sessionId: string, processedEvents: ProcessedEvent[]): string[] {
  const forSession = processedEvents.filter((e) => e.session_id === sessionId);
  const bestByType = new Map<string, ProcessedEvent>();
  for (const event of forSession) {
    const existing = bestByType.get(event.change_type);
    if (!existing || new Date(event.detected_at) > new Date(existing.detected_at)) {
      bestByType.set(event.change_type, event);
    }
  }
  return [...bestByType.values()].map((e) => e.id);
}

export default function ChangedQueue({
  unprocessedEvents,
  staleItems,
  processedEvents,
}: {
  unprocessedEvents: ChangeEvent[];
  staleItems: StaleItem[];
  processedEvents: ProcessedEvent[];
}) {
  const t = useTranslations('allocation.schedulePublication.changed');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [stagingSessionId, setStagingSessionId] = useState<string | null>(null);
  const [stagedDraftId, setStagedDraftId] = useState<string | null>(null);

  async function handleProcess() {
    setError(null);
    setProcessing(true);
    try {
      await triggerProcessChangeEvents();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.processFailed'));
    } finally {
      setProcessing(false);
    }
  }

  async function handleStage(sessionId: string) {
    setError(null);
    setStagedDraftId(null);
    const eventIds = selectRelevantEventIds(sessionId, processedEvents);
    if (eventIds.length === 0) {
      setError(t('errors.noEventsForSession', { sessionId }));
      return;
    }
    setStagingSessionId(sessionId);
    try {
      const result = await triggerStageFromChangeEvents(eventIds);
      setStagedDraftId(result.id);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.stageFailed'));
    } finally {
      setStagingSessionId(null);
    }
  }

  // Group stale/pending_review items by session_id for the "Stage Draft"
  // per-group action.
  const groups = new Map<string, StaleItem[]>();
  for (const item of staleItems) {
    if (!item.session_id) continue;
    const list = groups.get(item.session_id) ?? [];
    list.push(item);
    groups.set(item.session_id, list);
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p role="alert" className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}
      {stagedDraftId && (
        <p className="rounded-md border border-turquoise/40 bg-turquoise/5 px-3 py-2 text-sm text-charcoal dark:border-turquoise/30 dark:bg-turquoise/10 dark:text-gray-100">
          {t('stagedNotice', { id: stagedDraftId })}{' '}
          <Link href={`/allocation/schedules/stage/draft/${stagedDraftId}`} className="text-turquoise hover:underline">
            {t('reviewStagedDraft', { id: stagedDraftId })}
          </Link>
        </p>
      )}

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-charcoal dark:text-gray-100">{t('unprocessedTitle')}</h2>
          <Button
            type="button"
            size="sm"
            disabled={processing || unprocessedEvents.length === 0}
            onClick={handleProcess}
          >
            {processing ? t('processing') : t('processButton')}
          </Button>
        </div>

        {unprocessedEvents.length === 0 ? (
          <EmptyState title={t('noUnprocessedEvents')} description={t('noUnprocessedEventsDescription')} />
        ) : (
          <>
            {/* Mobile: card-per-event list. Desktop (md+): table. Both trees
                render the same `unprocessedEvents` data and must be kept in
                sync — any column added to one must be added to the other. */}
            <div className="flex flex-col gap-2 md:hidden">
              {unprocessedEvents.map((event) => (
                <Card key={event.id}>
                  <p className="text-sm font-medium text-charcoal dark:text-gray-100">
                    {event.sessions ? `${event.sessions.session_code} — ${event.sessions.title_en}` : event.session_id}
                  </p>
                  <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
                    {t('changeType')}: {event.change_type}
                  </p>
                  <p className="text-sm text-charcoal/70 dark:text-gray-400">
                    {t('detectedAt')}: {formatDate(event.detected_at)}
                  </p>
                </Card>
              ))}
            </div>
            <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('session')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('changeType')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('detectedAt')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                  {unprocessedEvents.map((event) => (
                    <tr key={event.id}>
                      <td className="px-4 py-2 text-charcoal dark:text-gray-100">
                        {event.sessions ? `${event.sessions.session_code} — ${event.sessions.title_en}` : event.session_id}
                      </td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{event.change_type}</td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{formatDate(event.detected_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-charcoal dark:text-gray-100">{t('affectedSessionsTitle')}</h2>
        {groups.size === 0 ? (
          <EmptyState title={t('noStaleItems')} description={t('noStaleItemsDescription')} />
        ) : (
          <div className="flex flex-col gap-4">
            {[...groups.entries()].map(([sessionId, items]) => {
              const hasPendingReview = items.some((item) => item.item_status === 'pending_review');
              const first = items[0];
              return (
                <Card key={sessionId}>
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-charcoal dark:text-gray-100">
                      {first.session_title_en ?? sessionId}
                    </h3>
                    {hasPendingReview && <Badge variant="cancelled">{t('cancellationBadge')}</Badge>}
                  </div>

                  {/* Mobile: card-per-item list. Desktop (md+): table. Both
                      trees render the same `items` data for this session
                      group and must be kept in sync. */}
                  <div className="flex flex-col gap-2 md:hidden">
                    {items.map((item) => {
                      const publication = Array.isArray(item.schedule_publications)
                        ? item.schedule_publications[0]
                        : item.schedule_publications;
                      return (
                        <div key={item.id} className="rounded-md border border-charcoal/10 p-3 dark:border-gray-700">
                          <p className="text-sm font-medium text-charcoal dark:text-gray-100">
                            {item.item_status === 'pending_review'
                              ? t('itemStatusCancellation', { status: item.item_status })
                              : item.item_status}
                          </p>
                          <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
                            {t('room')}: {item.room_name_en ?? '—'}
                          </p>
                          <p className="text-sm text-charcoal/70 dark:text-gray-400">
                            {t('start')}: {item.start_time ? formatDate(item.start_time) : '—'}
                          </p>
                          <p className="text-sm text-charcoal/70 dark:text-gray-400">
                            {t('end')}: {item.end_time ? formatDate(item.end_time) : '—'}
                          </p>
                          <p className="text-sm text-charcoal/70 dark:text-gray-400">
                            {t('publication')}:{' '}
                            {publication ? (
                              <Link
                                href={`/allocation/schedules/participants/${publication.application_id}`}
                                className="text-turquoise hover:underline"
                              >
                                {publication.application_id}
                              </Link>
                            ) : (
                              '—'
                            )}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                  <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
                    <table className="w-full text-start text-sm">
                      <thead>
                        <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                          <th scope="col" className="px-4 py-2 text-start font-medium">{t('itemStatus')}</th>
                          <th scope="col" className="px-4 py-2 text-start font-medium">{t('room')}</th>
                          <th scope="col" className="px-4 py-2 text-start font-medium">{t('start')}</th>
                          <th scope="col" className="px-4 py-2 text-start font-medium">{t('end')}</th>
                          <th scope="col" className="px-4 py-2 text-start font-medium">{t('publication')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                        {items.map((item) => {
                          const publication = Array.isArray(item.schedule_publications)
                            ? item.schedule_publications[0]
                            : item.schedule_publications;
                          return (
                            <tr key={item.id}>
                              <td className="px-4 py-2 text-charcoal dark:text-gray-100">
                                {item.item_status === 'pending_review'
                                  ? t('itemStatusCancellation', { status: item.item_status })
                                  : item.item_status}
                              </td>
                              <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{item.room_name_en ?? '—'}</td>
                              <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                                {item.start_time ? formatDate(item.start_time) : '—'}
                              </td>
                              <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                                {item.end_time ? formatDate(item.end_time) : '—'}
                              </td>
                              <td className="px-4 py-2">
                                {publication ? (
                                  <Link
                                    href={`/allocation/schedules/participants/${publication.application_id}`}
                                    className="text-turquoise hover:underline"
                                  >
                                    {publication.application_id}
                                  </Link>
                                ) : (
                                  '—'
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/*
                    This section flags an unresolved cancellation inside a
                    session that is queued to be staged into a new draft. It
                    is NOT itself an irreversible action — "Stage Draft" only
                    creates a draft for later review (same
                    stagePublication()/stage_publication_transactional path
                    used by run-list.tsx and the "Stage Publication" button on
                    the overview page), and the actual irreversible step
                    (confirming/publishing a draft) happens later on the
                    staging screen, which already carries the strongest
                    (red-bordered) visual treatment per Part 1. So this gets
                    the gold Card — the same escalation tier used for
                    blocker-resolution.tsx's reassign/override actions —
                    rather than the red treatment reserved for the one truly
                    irreversible publish-confirmation action in the app.
                  */}
                  {hasPendingReview && (
                    <Card className="mt-3 border-gold/60 bg-gold/5 dark:border-amber-700/60 dark:bg-amber-950/10">
                      <p className="text-sm text-charcoal dark:text-gray-100">{t('cancellationNotice')}</p>
                    </Card>
                  )}

                  <div className="mt-3">
                    <Button
                      type="button"
                      size="sm"
                      disabled={stagingSessionId === sessionId}
                      onClick={() => handleStage(sessionId)}
                    >
                      {stagingSessionId === sessionId ? t('staging') : t('stageDraft')}
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
