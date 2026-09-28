-- widen_feature_extraction_source_field_constraint.sql
--
-- feature_extraction_rules_source_field_valid was never widened when Phase B
-- added session_languages/track_1_focus_areas/track_2_focus_areas/
-- track_3_focus_areas/primary_track/secondary_track to
-- ExtractionRule['sourceField'] (src/lib/allocation/feature-extraction.ts) —
-- inserting a rule with any of those source_field values has been failing
-- live with a check-constraint violation ever since. This brings the
-- constraint in line with the TypeScript type it's meant to mirror.
alter table feature_extraction_rules drop constraint feature_extraction_rules_source_field_valid;
alter table feature_extraction_rules add constraint feature_extraction_rules_source_field_valid check (
  source_field in (
    'interests', 'track_interests', 'topics_to_learn', 'participation_goals', 'past_initiatives',
    'session_languages', 'track_1_focus_areas', 'track_2_focus_areas', 'track_3_focus_areas',
    'primary_track', 'secondary_track'
  )
);
