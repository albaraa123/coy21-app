-- 20260816070000_correct_cluster_memberships_select_grant.sql
--
-- SEVENTH corrective follow-up to 20260816000000_canonical_authenticated_and_
-- service_role_grants.sql, found while running the full repository test
-- suite (Phase 7G-K).
--
-- ROOT CAUSE: fetchApplicationIdsWithDownstreamReference
-- (src/app/[locale]/(admin)/participants/import/[batchId]/preview/actions.ts:
-- 111-115) checks 5 tables via service_role SELECT for downstream references
-- before allowing an import batch rollback: participant_feature_snapshots,
-- cluster_memberships, allocation_assignments, schedule_publications,
-- schedule_publication_draft_items. The original canonical migration granted
-- service_role SELECT on 4 of these 5 but only INSERT on cluster_memberships
-- (classified as an insert-only trail — missing that this same real code path
-- also reads it directly).

grant select on public.cluster_memberships to service_role;
