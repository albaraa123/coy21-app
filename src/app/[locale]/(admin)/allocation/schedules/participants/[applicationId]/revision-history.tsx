'use client';

import { Fragment, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

type Publication = {
  id: string;
  application_id: string;
  allocation_run_id: string;
  revision_number: number;
  status: string;
  source_fingerprint: string;
  published_at: string;
  published_by: string;
};

type PublicationItem = {
  id: string;
  schedule_publication_id: string;
  session_id: string | null;
  session_title_ar: string | null;
  session_title_en: string | null;
  room_name_ar: string | null;
  room_name_en: string | null;
  start_time: string | null;
  end_time: string | null;
  is_mandatory: boolean;
  item_status: string;
  suitability_score: number | null;
  explanation_summary: string | null;
  gap_reason: string | null;
  speakers: unknown;
};

function formatDate(value: string) {
  return new Date(value).toLocaleString('en-US', { timeZone: 'Asia/Muscat' });
}

// This view is read-only: it only ever reads `publications` and `items`
// (both fetched server-side in page.tsx) and toggles local `expanded` UI
// state. No server action, mutation, or Supabase write is triggered from
// this component.
export default function RevisionHistory({
  publications,
  items,
}: {
  publications: Publication[];
  items: PublicationItem[];
}) {
  const t = useTranslations('allocation.schedulePublication.participantDetail');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Mobile: card-per-revision list, with items shown inline when
          expanded. Desktop (md+): table with an expandable items row. Both
          trees render the same `publications`/`items` data and must be kept
          in sync — any field added to one must be added to the other. */}
      <div className="flex flex-col gap-3 md:hidden">
        {publications.map((pub) => {
          const isExpanded = expanded.has(pub.id);
          const pubItems = items.filter((item) => item.schedule_publication_id === pub.id);
          return (
            <Card key={pub.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-charcoal dark:text-gray-100">
                  {t('revision')} {pub.revision_number}
                </p>
                <Badge variant={pub.status === 'active' ? 'changed' : 'neutral'}>{pub.status}</Badge>
              </div>
              <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
                {t('publishedAt')}: {formatDate(pub.published_at)}
              </p>
              <p className="text-sm text-charcoal/70 dark:text-gray-400">
                {t('publishedBy')}: {pub.published_by}
              </p>
              <p className="text-sm text-charcoal/70 dark:text-gray-400">
                {t('allocationRun')}: {pub.allocation_run_id}
              </p>
              <p className="break-all text-sm text-charcoal/70 dark:text-gray-400">
                {t('sourceFingerprint')}: {pub.source_fingerprint}
              </p>
              <div className="mt-2">
                <Button type="button" size="sm" variant="secondary" aria-expanded={isExpanded} onClick={() => toggle(pub.id)}>
                  {isExpanded ? t('hideItems') : t('showItems', { count: pubItems.length })}
                </Button>
              </div>
              {isExpanded && (
                <div className="mt-3 flex flex-col gap-2 border-t border-charcoal/10 pt-3 dark:border-gray-700">
                  {pubItems.length === 0 ? (
                    <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('noItems')}</p>
                  ) : (
                    pubItems.map((item) => (
                      <div key={item.id} className="rounded-md border border-charcoal/10 p-3 dark:border-gray-700">
                        <p className="text-sm font-medium text-charcoal dark:text-gray-100">
                          {item.session_title_en ?? item.session_title_ar ?? item.session_id ?? '—'}
                        </p>
                        <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
                          {t('room')}: {item.room_name_en ?? item.room_name_ar ?? '—'}
                        </p>
                        <p className="text-sm text-charcoal/70 dark:text-gray-400">
                          {t('start')}: {item.start_time ? formatDate(item.start_time) : '—'}
                        </p>
                        <p className="text-sm text-charcoal/70 dark:text-gray-400">
                          {t('end')}: {item.end_time ? formatDate(item.end_time) : '—'}
                        </p>
                        <p className="text-sm text-charcoal/70 dark:text-gray-400">
                          {t('mandatory')}: {item.is_mandatory ? t('mandatoryYes') : t('mandatoryNo')}
                        </p>
                        <p className="text-sm text-charcoal/70 dark:text-gray-400">
                          {t('itemStatus')}: {item.item_status}
                        </p>
                        <p className="text-sm text-charcoal/70 dark:text-gray-400">
                          {t('suitability')}: {item.suitability_score ?? '—'}
                        </p>
                        <p className="text-sm text-charcoal/70 dark:text-gray-400">
                          {t('explanation')}: {item.explanation_summary ?? '—'}
                        </p>
                        <p className="text-sm text-charcoal/70 dark:text-gray-400">
                          {t('gapReason')}: {item.gap_reason ?? '—'}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
        <table className="w-full text-start text-sm">
          <thead>
            <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('revision')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('status')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('publishedAt')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('publishedBy')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('allocationRun')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('sourceFingerprint')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
            {publications.map((pub) => {
              const isExpanded = expanded.has(pub.id);
              const pubItems = items.filter((item) => item.schedule_publication_id === pub.id);
              return (
                <Fragment key={pub.id}>
                  <tr>
                    <td className="px-4 py-2 text-charcoal dark:text-gray-100">{pub.revision_number}</td>
                    <td className="px-4 py-2">
                      <Badge variant={pub.status === 'active' ? 'changed' : 'neutral'}>{pub.status}</Badge>
                    </td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{formatDate(pub.published_at)}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{pub.published_by}</td>
                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{pub.allocation_run_id}</td>
                    <td className="max-w-xs truncate px-4 py-2 text-charcoal/70 dark:text-gray-400" title={pub.source_fingerprint}>
                      {pub.source_fingerprint}
                    </td>
                    <td className="px-4 py-2">
                      <Button type="button" size="sm" variant="secondary" aria-expanded={isExpanded} onClick={() => toggle(pub.id)}>
                        {isExpanded ? t('hideItems') : t('showItems', { count: pubItems.length })}
                      </Button>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={7} className="bg-warm-white/60 px-4 py-3 dark:bg-gray-900/60">
                        {pubItems.length === 0 ? (
                          <p className="text-sm text-charcoal/70 dark:text-gray-400">{t('noItems')}</p>
                        ) : (
                          <div className="overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700">
                            <table className="w-full text-start text-sm">
                              <thead>
                                <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('session')}</th>
                                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('room')}</th>
                                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('start')}</th>
                                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('end')}</th>
                                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('mandatory')}</th>
                                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('itemStatus')}</th>
                                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('suitability')}</th>
                                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('explanation')}</th>
                                  <th scope="col" className="px-4 py-2 text-start font-medium">{t('gapReason')}</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                                {pubItems.map((item) => (
                                  <tr key={item.id}>
                                    <td className="px-4 py-2 text-charcoal dark:text-gray-100">
                                      {item.session_title_en ?? item.session_title_ar ?? item.session_id ?? '—'}
                                    </td>
                                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                                      {item.room_name_en ?? item.room_name_ar ?? '—'}
                                    </td>
                                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                                      {item.start_time ? formatDate(item.start_time) : '—'}
                                    </td>
                                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                                      {item.end_time ? formatDate(item.end_time) : '—'}
                                    </td>
                                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                                      {item.is_mandatory ? t('mandatoryYes') : t('mandatoryNo')}
                                    </td>
                                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{item.item_status}</td>
                                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                                      {item.suitability_score ?? '—'}
                                    </td>
                                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                                      {item.explanation_summary ?? '—'}
                                    </td>
                                    <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                                      {item.gap_reason ?? '—'}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
