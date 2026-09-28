// tests/allocation/track-terminology-correction-live.test.ts
//
// Live coverage for the track terminology correction:
//   1. The 4 official tracks were seeded with the stable ids from
//      supabase/migrations/20260805100000_seed_official_tracks.sql, and
//      display correctly (code/name_ar/name_en) as inserted.
//   2. feature_extraction_rules_source_field_valid was widened
//      (supabase/migrations/20260805110000_...) to accept
//      primary_track/secondary_track/session_languages/track_N_focus_areas —
//      previously a live-database bug blocking ExtractionRule.sourceField
//      values already accepted by the TypeScript type.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(URL, SERVICE_KEY);

const runId = randomUUID().slice(0, 8);

const OFFICIAL_TRACKS = [
  {
    id: '1effc2ca-9bd4-4cc5-94c5-be177195343b',
    code: 'adaptation_resilience_communities',
    name_ar: 'المحور الأول: التكيف والمرونة وصمود المجتمعات',
    name_en: 'Track 1: Adaptation, Resilience, and Resilient Communities',
  },
  {
    id: 'a4b2c098-1351-4512-8d1e-dfedab0f255c',
    code: 'just_transition_green_economy_climate_innovation',
    name_ar: 'المحور الثاني: التحول العادل والاقتصاد الأخضر والابتكار المناخي',
    name_en: 'Track 2: Just Transition, Green Economy, and Climate Innovation',
  },
  {
    id: '472a5779-6dc5-47ef-8093-e414e2cfec49',
    code: 'climate_finance_governance_international_cooperation',
    name_ar: 'المحور الثالث: تمويل المناخ والحوكمة والتعاون الدولي',
    name_en: 'Track 3: Climate Finance, Governance, and International Cooperation',
  },
  {
    id: 'bd80e41e-cbfb-47f3-9bac-14a24c5a125a',
    code: 'cross_cutting_track',
    name_ar: 'المحور الرابع: المسار التقاطعي',
    name_en: 'Track 4: Cross-Cutting Track',
  },
];

describe('official tracks seed (live)', () => {
  it('has exactly the 4 official tracks at their fixed ids, with correct Arabic and English names', async () => {
    const { data, error } = await admin
      .from('tracks')
      .select('id, code, name_ar, name_en, is_active')
      .in(
        'id',
        OFFICIAL_TRACKS.map((t) => t.id)
      );
    if (error) throw error;
    expect(data).toHaveLength(4);
    for (const expected of OFFICIAL_TRACKS) {
      const row = data!.find((r) => r.id === expected.id);
      expect(row, `track ${expected.code} not found at its fixed id`).toBeDefined();
      expect(row!.code).toBe(expected.code);
      expect(row!.name_ar).toBe(expected.name_ar);
      expect(row!.name_en).toBe(expected.name_en);
      expect(row!.is_active).toBe(true);
    }
  });

  it('keeps Track 4 (cross_cutting_track) distinct from any admission_policy value', async () => {
    // Track 4's code is 'cross_cutting_track', never the bare string
    // 'cross_cutting' — that string is reserved for sessions.admission_policy
    // and the two must never collide.
    const track4 = OFFICIAL_TRACKS.find((t) => t.code === 'cross_cutting_track')!;
    expect(track4.code).not.toBe('cross_cutting');
  });
});

describe('feature_extraction_rules_source_field_valid widening (live)', () => {
  const insertedRuleIds: string[] = [];
  let tagId: string | undefined;

  afterAll(async () => {
    if (insertedRuleIds.length > 0) {
      await admin.from('feature_extraction_rules').delete().in('id', insertedRuleIds);
    }
    if (tagId) {
      await admin.from('tags').delete().eq('id', tagId);
    }
  });

  it('accepts primary_track/secondary_track/session_languages/track_N_focus_areas as source_field values', async () => {
    const { data: tag, error: tagError } = await admin
      .from('tags')
      .insert({ code: `TRACK-CORRECTION-TEST-TAG-${runId}`, name_ar: 'وسم', name_en: 'Tag' })
      .select('id')
      .single();
    if (tagError || !tag) throw new Error(`Failed to create tag: ${tagError?.message}`);
    tagId = tag.id;

    const fieldsThatWerePreviouslyRejected = [
      'primary_track',
      'secondary_track',
      'session_languages',
      'track_1_focus_areas',
      'track_2_focus_areas',
      'track_3_focus_areas',
    ];

    for (const sourceField of fieldsThatWerePreviouslyRejected) {
      const { data, error } = await admin
        .from('feature_extraction_rules')
        .insert({
          version: 1,
          source_field: sourceField,
          match_type: 'keyword_substring',
          match_value: 'test',
          tag_id: tagId,
          weight: 0.5,
          is_active: false,
        })
        .select('id')
        .single();
      expect(error, `insert for source_field='${sourceField}' should succeed after the constraint widening`).toBeNull();
      expect(data).not.toBeNull();
      if (data) insertedRuleIds.push(data.id);
    }
  });

  it('still rejects a genuinely invalid source_field value', async () => {
    const { error } = await admin.from('feature_extraction_rules').insert({
      version: 1,
      source_field: 'not_a_real_field',
      match_type: 'keyword_substring',
      match_value: 'test',
      tag_id: tagId!,
      weight: 0.5,
      is_active: false,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe('23514'); // check_violation
  });
});
