-- phase_b_travel_health_extra_columns.sql
--
-- Phase B (design doc section 13.3, points 2-3): three columns approved for
-- application_travel_info/application_health_info that were documented but
-- not yet added to the schema. Additive and non-destructive.
alter table application_travel_info add column passport_full_name_ar text;
alter table application_travel_info add column passport_birth_date date;
alter table application_health_info add column emergency_contact_relationship text;

comment on column application_travel_info.passport_full_name_ar is
  'Full passport name in Arabic, distinct from passport_full_name (English) '
  '-- both may be required by different visa/travel processes.';

comment on column application_travel_info.passport_birth_date is
  'Date of birth as it appears on the passport, distinct from '
  'applications.birth_date (self-reported elsewhere on the form) -- kept '
  'separate so the authoritative travel-document value is never silently '
  'overwritten by a possibly-differing self-reported age-group answer.';
