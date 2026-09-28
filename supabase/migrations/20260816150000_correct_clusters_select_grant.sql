-- 20260816150000_correct_clusters_select_grant.sql
--
-- FIFTEENTH corrective follow-up to 20260816000000_canonical_authenticated_
-- and_service_role_grants.sql, found while running the full repository test
-- suite (Phase 7G-K, via tests/import/schedule-integration-live.test.ts's
-- real Phase 5 clustering pass).
--
-- ROOT CAUSE: runClustering (src/lib/allocation/run-clustering.ts:56-68)
-- performs `.from('clusters').insert({...}).select('id').single()` as a real
-- part of the production clustering pipeline (runDownstreamProcessingForCaller
-- -> runClustering) -- the .select('id') after insert requires SELECT
-- privilege to return the inserted row, not just INSERT. The canonical
-- migration granted service_role INSERT on clusters but never SELECT,
-- unlike its sibling cluster_memberships/clustering_runs, both of which
-- already carry SELECT (see 20260816070000 for cluster_memberships).

grant select on public.clusters to service_role;
