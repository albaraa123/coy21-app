// src/lib/allocation/run-extraction.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { extractFeatures, type ApplicationForExtraction, type ExtractionRule } from './feature-extraction';
import { fetchAllRowsPaginated } from './paginated-fetch';

type ServiceClient = SupabaseClient<Database>;

export async function runFeatureExtraction(service: ServiceClient, runBy: string): Promise<{ id: string; applicationCount: number }> {
  const { data: ruleRows, error: rulesError } = await service
    .from('feature_extraction_rules')
    .select('id, version, source_field, match_type, match_value, tag_id, weight, is_active')
    .eq('is_active', true);
  if (rulesError) throw new Error(`Failed to load extraction rules: ${rulesError.message}`);

  const rules: ExtractionRule[] = (ruleRows ?? []).map((r) => ({
    id: r.id,
    sourceField: r.source_field as ExtractionRule['sourceField'],
    matchType: r.match_type as ExtractionRule['matchType'],
    matchValue: r.match_value,
    tagId: r.tag_id,
    weight: r.weight,
  }));
  const rulesVersion = ruleRows && ruleRows.length > 0 ? Math.max(...ruleRows.map((r) => r.version)) : 0;

  // Phase B: session_languages/track_1-3_focus_areas/primary_track/
  // secondary_track are the only additional columns read here — a fixed,
  // named set (design doc section 13.4), never an open-ended
  // application_answers read. Feature extraction still touches nothing on
  // application_travel_info/application_health_info.
  //
  // Keyset-paginated (see paginated-fetch.ts): PostgREST caps an
  // unpaginated select() at a server-configured max (1000 rows on this
  // project) — beyond that, accepted applications were being silently
  // dropped from extraction with no error (Phase 7G-K finding). `id asc`
  // with a `> lastSeenId` cursor is stable under concurrent writes from
  // admission-review/import, unlike offset-based pagination.
  const applications = await fetchAllRowsPaginated((lastSeenId, pageSize) => {
    let query = service
      .from('applications')
      .select('id, interests, track_interests, topics_to_learn, participation_goals, past_initiatives, session_languages, track_1_focus_areas, track_2_focus_areas, track_3_focus_areas, primary_track, secondary_track')
      .eq('status', 'accepted')
      .order('id', { ascending: true })
      .limit(pageSize);
    if (lastSeenId !== null) query = query.gt('id', lastSeenId);
    return query;
  });

  const { data: run, error: runError } = await service
    .from('feature_extraction_runs')
    .insert({ rules_version: rulesVersion, application_count: applications.length, run_by: runBy })
    .select('id')
    .single();
  if (runError || !run) throw new Error(`Failed to create feature_extraction_runs row: ${runError?.message}`);

  const snapshotRows: { feature_extraction_run_id: string; application_id: string; tag_id: string; weight: number }[] = [];
  for (const app of applications) {
    const forExtraction: ApplicationForExtraction = {
      interests: app.interests,
      trackInterests: app.track_interests,
      topicsToLearn: app.topics_to_learn,
      participationGoals: app.participation_goals,
      pastInitiatives: app.past_initiatives,
      sessionLanguages: app.session_languages,
      track1FocusAreas: app.track_1_focus_areas,
      track2FocusAreas: app.track_2_focus_areas,
      track3FocusAreas: app.track_3_focus_areas,
      primaryTrack: app.primary_track,
      secondaryTrack: app.secondary_track,
    };
    const features = extractFeatures(forExtraction, rules);
    for (const f of features) {
      snapshotRows.push({ feature_extraction_run_id: run.id, application_id: app.id, tag_id: f.tagId, weight: f.weight });
    }
  }

  if (snapshotRows.length > 0) {
    const { error: snapshotError } = await service.from('participant_feature_snapshots').insert(snapshotRows);
    if (snapshotError) throw new Error(`Failed to write feature snapshots: ${snapshotError.message}`);
  }

  return { id: run.id, applicationCount: applications.length };
}
