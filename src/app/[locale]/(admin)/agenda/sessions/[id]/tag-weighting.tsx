'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { setSessionTags } from './actions';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type SessionTagRow = {
  id: string;
  tag_id: string;
  weight: number;
  tags: { id: string; name_ar: string; name_en: string } | null;
};

type RefOption = { id: string; [key: string]: unknown };

export default function TagWeighting({
  sessionId,
  sessionTags,
  tags,
}: {
  sessionId: string;
  sessionTags: SessionTagRow[];
  tags: RefOption[];
}) {
  const t = useTranslations('agenda.sessions.detail.tags');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [tagWeights, setTagWeights] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const st of sessionTags) {
      initial[st.tag_id] = String(st.weight);
    }
    return initial;
  });
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(
    () => new Set(sessionTags.map((st) => st.tag_id))
  );

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) {
        next.delete(tagId);
      } else {
        next.add(tagId);
        if (!(tagId in tagWeights)) {
          setTagWeights((w) => ({ ...w, [tagId]: '0.5' }));
        }
      }
      return next;
    });
  }

  async function handleSubmitTags(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload = [...selectedTagIds].map((tagId) => ({
        tagId,
        weight: Number(tagWeights[tagId] ?? '0'),
      }));
      await setSessionTags(sessionId, payload);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      {error && (
        <p role="alert" className="mb-4 rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <h2 className="mb-2 text-sm font-semibold text-charcoal dark:text-gray-100">{t('title')}</h2>
      <Card>
        <form onSubmit={handleSubmitTags} className="flex flex-col gap-3">
          <ul className="flex flex-col gap-2">
            {tags.map((tag) => (
              <li key={tag.id} className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-charcoal dark:text-gray-100">
                  <input
                    type="checkbox"
                    checked={selectedTagIds.has(tag.id)}
                    onChange={() => toggleTag(tag.id)}
                    className="h-4 w-4 rounded border-charcoal/30 text-turquoise focus:ring-turquoise dark:border-gray-600"
                  />
                  {String(tag.name_en)}
                </label>
                {selectedTagIds.has(tag.id) && (
                  <label className="flex items-center gap-1 text-xs text-charcoal/70 dark:text-gray-400">
                    {t('weight')}
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                      value={tagWeights[tag.id] ?? '0.5'}
                      onChange={(e) => setTagWeights((w) => ({ ...w, [tag.id]: e.target.value }))}
                      className="w-20 rounded-md border border-charcoal/20 bg-warm-white px-2 py-1 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                    />
                  </label>
                )}
              </li>
            ))}
          </ul>
          <div>
            <Button type="submit" size="sm" disabled={submitting}>{t('save')}</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
