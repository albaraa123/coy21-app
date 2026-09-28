-- apply_import_row_sensitive_keys_comment.sql
--
-- Code-quality review of Task 15 flagged that the is_sensitive key list
-- inlined in apply_import_row_transactional's application_answers insert
-- (accessibility_requirements, dietary_requirements, emergency_contact_name,
-- emergency_contact_phone, special_needs) is now a THIRD copy of the same
-- set already declared once in src/lib/validation/import.ts as
-- SENSITIVE_QUESTION_KEYS ("single source of truth... so the two never
-- drift") and once in tests/rls/import.test.ts's fixture. SQL cannot import
-- a TypeScript constant, so this cannot be de-duplicated outright — but
-- since RLS keys off is_sensitive to gate a genuinely sensitive-data column
-- (see application_answers_sensitive_staff_all in
-- 20260726105000_import_rls_policies.sql), silent drift between these three
-- copies would be a privacy leak, not just a bug. This migration adds an
-- explicit cross-reference comment directly above the list so any future
-- edit to SENSITIVE_QUESTION_KEYS is more likely to be noticed here too.
comment on function apply_import_row_transactional(uuid, uuid, uuid) is
  'Per-row transactional import apply (Task 15). The is_sensitive key list '
  'inlined in this function''s application_answers insert must be kept in '
  'sync with SENSITIVE_QUESTION_KEYS in src/lib/validation/import.ts and the '
  'fixture in tests/rls/import.test.ts — all three currently list '
  'accessibility_requirements, dietary_requirements, emergency_contact_name, '
  'emergency_contact_phone, special_needs. If you change one, change all '
  'three.';
