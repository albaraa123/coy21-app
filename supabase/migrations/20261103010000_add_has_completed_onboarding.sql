begin;

-- One-time participant onboarding gate, same pattern as must_change_password
-- (20260801100000_phase_c_provisioning_table.sql): a single boolean flag on
-- profiles, checked server-side in (participant)/(shell)/layout.tsx -- the
-- one layout every route under (shell)/ (my-dashboard, my-agenda, etc.)
-- renders through -- so a false value redirects to /welcome before any
-- other participant page ever loads, with no way to reach a shell route by
-- typing its URL directly. Defaults false so every EXISTING participant
-- also sees the new /welcome walkthrough once, not just newly-claimed ones.
alter table profiles add column has_completed_onboarding boolean not null default false;

commit;
