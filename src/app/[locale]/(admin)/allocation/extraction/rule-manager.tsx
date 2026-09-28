'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import {
  EXTRACTABLE_SOURCE_FIELDS,
  MATCH_TYPES,
} from '@/lib/validation/allocation';
import { createExtractionRule, deactivateExtractionRule, triggerFeatureExtraction } from './actions';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

type Rule = {
  id: string;
  version: number;
  source_field: string;
  match_type: string;
  match_value: string;
  weight: number;
  is_active: boolean;
  tag_id: string;
  tags: { id: string; name_en: string } | null;
};

type Run = {
  id: string;
  rules_version: number;
  application_count: number;
  run_at: string;
};

type Tag = {
  id: string;
  name_en: string;
};

type FormState = {
  sourceField: string;
  matchType: string;
  matchValue: string;
  tagId: string;
  weight: string;
};

const EMPTY_FORM: FormState = {
  sourceField: EXTRACTABLE_SOURCE_FIELDS[0],
  matchType: MATCH_TYPES[0],
  matchValue: '',
  tagId: '',
  weight: '',
};

const inputClasses =
  'rounded-md border border-charcoal/20 bg-warm-white px-3 py-1.5 text-sm text-charcoal focus:border-turquoise focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100';

export default function RuleManager({ rules, runs, tags }: { rules: Rule[]; runs: Run[]; tags: Tag[] }) {
  const t = useTranslations('allocation.extraction');
  const router = useRouter();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [running, setRunning] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const weight = Number(form.weight);
      if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
        throw new Error(t('errors.weightRange'));
      }
      if (!form.tagId) {
        throw new Error(t('errors.tagRequired'));
      }
      await createExtractionRule({
        sourceField: form.sourceField,
        matchType: form.matchType,
        matchValue: form.matchValue,
        tagId: form.tagId,
        weight,
      });
      setForm(EMPTY_FORM);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.createFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeactivate(id: string) {
    setError(null);
    try {
      await deactivateExtractionRule(id);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.deactivateFailed'));
    }
  }

  async function handleTriggerRun() {
    setError(null);
    setRunning(true);
    try {
      await triggerFeatureExtraction();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.runFailed'));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <p role="alert" className="rounded-md border border-red-700 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold text-charcoal dark:text-gray-100">{t('rulesTitle')}</h2>

        {rules.length === 0 ? (
          <EmptyState title={t('emptyRulesTitle')} description={t('emptyRulesDescription')} />
        ) : (
          <>
            {/* Mobile: card-per-rule list. Desktop (md+): table. Both trees
                render the same `rules` data and must be kept in sync — any
                column added to one must be added to the other. */}
            <div className="flex flex-col gap-2 md:hidden">
              {rules.map((rule) => (
                <Card key={rule.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-charcoal dark:text-gray-100">
                      {t('versionLabel', { version: rule.version })}
                    </p>
                    <Badge variant={rule.is_active ? 'changed' : 'neutral'}>
                      {rule.is_active ? t('active') : t('inactive')}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
                    {t('sourceField')}: {rule.source_field}
                  </p>
                  <p className="text-sm text-charcoal/70 dark:text-gray-400">
                    {t('matchType')}: {rule.match_type}
                  </p>
                  <p className="text-sm text-charcoal/70 dark:text-gray-400">
                    {t('matchValue')}: {rule.match_value}
                  </p>
                  <p className="text-sm text-charcoal/70 dark:text-gray-400">
                    {t('tag')}: {rule.tags?.name_en ?? rule.tag_id}
                  </p>
                  <p className="text-sm text-charcoal/70 dark:text-gray-400">
                    {t('weight')}: {rule.weight}
                  </p>
                  {rule.is_active && (
                    <div className="mt-3">
                      <Button size="sm" variant="destructive" onClick={() => handleDeactivate(rule.id)}>
                        {t('deactivate')}
                      </Button>
                    </div>
                  )}
                </Card>
              ))}
            </div>
            <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('version')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('sourceField')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('matchType')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('matchValue')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('tag')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('weight')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('status')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                  {rules.map((rule) => (
                    <tr key={rule.id}>
                      <td className="px-4 py-2 text-charcoal dark:text-gray-100">{rule.version}</td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{rule.source_field}</td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{rule.match_type}</td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{rule.match_value}</td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{rule.tags?.name_en ?? rule.tag_id}</td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{rule.weight}</td>
                      <td className="px-4 py-2">
                        <Badge variant={rule.is_active ? 'changed' : 'neutral'}>
                          {rule.is_active ? t('active') : t('inactive')}
                        </Badge>
                      </td>
                      <td className="px-4 py-2">
                        {rule.is_active && (
                          <Button size="sm" variant="destructive" onClick={() => handleDeactivate(rule.id)}>
                            {t('deactivate')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-lg border border-charcoal/10 bg-warm-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <h3 className="text-sm font-semibold text-charcoal dark:text-gray-100">{t('newRuleTitle')}</h3>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('sourceField')}
          <select
            value={form.sourceField}
            onChange={(e) => setForm({ ...form, sourceField: e.target.value })}
            className={inputClasses}
          >
            {EXTRACTABLE_SOURCE_FIELDS.map((field) => (
              <option key={field} value={field}>{field}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('matchType')}
          <select
            value={form.matchType}
            onChange={(e) => setForm({ ...form, matchType: e.target.value })}
            className={inputClasses}
          >
            {MATCH_TYPES.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('matchValue')}
          <input
            value={form.matchValue}
            onChange={(e) => setForm({ ...form, matchValue: e.target.value })}
            required
            className={inputClasses}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('tag')}
          <select
            value={form.tagId}
            onChange={(e) => setForm({ ...form, tagId: e.target.value })}
            required
            className={inputClasses}
          >
            <option value="">{t('selectTag')}</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>{tag.name_en}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-charcoal dark:text-gray-100">
          {t('weight')}
          <input
            type="number"
            min={0}
            max={1}
            step="any"
            value={form.weight}
            onChange={(e) => setForm({ ...form, weight: e.target.value })}
            required
            className={inputClasses}
          />
        </label>
        <div className="mt-2">
          <Button type="submit" disabled={submitting}>{t('create')}</Button>
        </div>
      </form>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-charcoal dark:text-gray-100">{t('runsTitle')}</h2>
          <Button type="button" onClick={handleTriggerRun} disabled={running}>
            {running ? t('triggering') : t('triggerRun')}
          </Button>
        </div>

        {runs.length === 0 ? (
          <EmptyState title={t('emptyRunsTitle')} description={t('emptyRunsDescription')} />
        ) : (
          <>
            {/* Mobile: card-per-run list. Desktop (md+): table. Both trees
                render the same `runs` data and must be kept in sync — any
                column added to one must be added to the other. */}
            <div className="flex flex-col gap-2 md:hidden">
              {runs.map((run) => (
                <Card key={run.id}>
                  <p className="text-sm font-medium text-charcoal dark:text-gray-100">{run.id}</p>
                  <p className="mt-1 text-sm text-charcoal/70 dark:text-gray-400">
                    {t('rulesVersion')}: {run.rules_version}
                  </p>
                  <p className="text-sm text-charcoal/70 dark:text-gray-400">
                    {t('applicationCount')}: {run.application_count}
                  </p>
                  <p className="text-sm text-charcoal/70 dark:text-gray-400">
                    {t('runAt')}: {new Date(run.run_at).toLocaleString('en-US', { timeZone: 'Asia/Muscat' })}
                  </p>
                </Card>
              ))}
            </div>
            <div className="hidden overflow-x-auto rounded-lg border border-charcoal/10 dark:border-gray-700 md:block">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-charcoal/10 bg-warm-white text-xs text-charcoal/60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('runId')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('rulesVersion')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('applicationCount')}</th>
                    <th scope="col" className="px-4 py-2 text-start font-medium">{t('runAt')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-charcoal/10 dark:divide-gray-700">
                  {runs.map((run) => (
                    <tr key={run.id}>
                      <td className="px-4 py-2 text-charcoal dark:text-gray-100">{run.id}</td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{run.rules_version}</td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">{run.application_count}</td>
                      <td className="px-4 py-2 text-charcoal/70 dark:text-gray-400">
                        {new Date(run.run_at).toLocaleString('en-US', { timeZone: 'Asia/Muscat' })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
