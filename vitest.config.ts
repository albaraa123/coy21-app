import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Load .env.local (and other .env* files) into process.env so tests
  // can read NEXT_PUBLIC_SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY
  // the same way the Next.js app does.
  const env = loadEnv(mode, process.cwd(), '');
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return {
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    test: {
      environment: 'node',
      // Exclude sibling worktrees (created by superpowers:using-git-worktrees for
      // isolated feature work) in addition to Vitest's own defaults — otherwise a
      // worktree containing a copy of this same test suite gets picked up too,
      // running every test twice against the same live Supabase project.
      // Worktrees actually land under .claude/worktrees/ in this repo, not
      // .worktrees/ — both patterns are kept since the latter is harmless if
      // unmatched and guards against a future worktree location change.
      exclude: ['**/node_modules/**', '**/.worktrees/**', '**/.claude/worktrees/**'],
      projects: [
        {
          extends: true,
          test: {
            name: 'default',
            exclude: [
              '**/node_modules/**',
              '**/.worktrees/**',
              '**/.claude/worktrees/**',
              '**/tests/allocation/run-behavioral.test.ts',
              '**/tests/allocation/reproducibility.test.ts',
              '**/tests/import/schedule-integration-live.test.ts',
              '**/tests/import/scale-500.test.ts',
              '**/tests/import/scale-5000.test.ts',
              '**/tests/dashboard/admin-dashboard-queries-live.test.ts',
              '**/tests/dashboard/participant-dashboard-queries-live.test.ts',
              '**/tests/schedule/authorization.test.ts',
              '**/tests/schedule/change-propagation.test.ts',
              '**/tests/schedule/concurrency.test.ts',
              '**/tests/schedule/confirm-publication-behavioral.test.ts',
              '**/tests/schedule/publication-lifecycle.test.ts',
              '**/tests/schedule/reassign-blocked-participant-behavioral.test.ts',
            ],
          },
        },
        {
          extends: true,
          test: {
            name: 'schedule-live',
            include: [
              '**/tests/schedule/authorization.test.ts',
              '**/tests/schedule/change-propagation.test.ts',
              '**/tests/schedule/concurrency.test.ts',
              '**/tests/schedule/confirm-publication-behavioral.test.ts',
              '**/tests/schedule/publication-lifecycle.test.ts',
              '**/tests/schedule/reassign-blocked-participant-behavioral.test.ts',
            ],
            // These 6 files (the live/behavioral suites under tests/schedule/
            // — not the pure-unit/component tests also in that directory,
            // e.g. fingerprint.test.ts, verdict-classification.test.ts,
            // publish-confirmation-*.test.ts(x), timezone.test.ts,
            // draft-review-publish-wiring.test.tsx, which stay in 'default')
            // each drive real multi-step live Supabase flows (stage →
            // reassign/override → confirm, each its own RPC round trip,
            // plus fixture setup/teardown) — observed real (non-flaky,
            // reproducible) durations of 5008-5018ms against the live
            // disposable project, consistently just over Vitest's 5000ms
            // default across three independent tests in three different
            // files. This is Cloud round-trip latency for genuinely
            // multi-step operations, not a hang or a production timeout —
            // confirmed by the RPCs themselves completing successfully
            // every time, just slightly past the default window under real
            // load. Scoped here (not raised globally) so fast unit tests
            // elsewhere keep failing quickly on a genuine hang.
            testTimeout: 15000,
            // Every file's beforeAll/afterAll does 8-15+ live-DB round trips
            // of its own (multiple createUser calls plus fixture inserts/
            // cleanup deletes) — Vitest's hookTimeout is a SEPARATE default
            // (10000ms) from testTimeout and was never covered by the fix
            // above. This was the real cause of several apparently-random
            // "Cannot read properties of null" failures observed earlier in
            // this file family's beforeAll blocks (a hook that times out
            // leaves its `const { data } = await ...` unresolved/undefined,
            // producing exactly that symptom one line later) — misdiagnosed
            // at the time as transient/non-reproducible session-load noise,
            // since the failing beforeAll always passed when re-run alone
            // under lighter load. Same fix, same rationale as testTimeout.
            hookTimeout: 15000,
            // concurrency.test.ts's advisory-lock race test passed 3/3
            // reliably when run alone, but failed twice (in two different
            // ways) when the full 6-file batch ran with Vitest's default
            // parallel-across-files behavior — cross-file contention on the
            // same live disposable project, not a defect in the advisory
            // lock itself. Same root cause and same fix as this file's
            // existing dashboard-live-sequential/allocation-live-sequential/
            // import-scale-sequential projects. Serializes files, not the
            // concurrent operations inside any single test.
            fileParallelism: false,
          },
        },
        {
          extends: true,
          test: {
            name: 'dashboard-live-sequential',
            include: [
              '**/tests/dashboard/admin-dashboard-queries-live.test.ts',
              '**/tests/dashboard/participant-dashboard-queries-live.test.ts',
            ],
            // Both files call admin.auth.admin.createUser() many times
            // (a fresh throwaway staff/participant user per test case,
            // matching this repo's established live-test convention) and
            // read/write shared tables (applications, import_batches,
            // participant_invitations, schedule_publications) with
            // before/after count comparisons. Running the two files
            // concurrently (Vitest's default across files) was observed to
            // produce real, reproducible flakes unrelated to either
            // implementation's own correctness: Supabase Auth Admin API
            // rate/consistency limits under the combined call volume
            // (occasional transient 'unauthorized'/'Invalid login
            // credentials' from a role-update or sign-in racing a
            // just-created user's own propagation), plus count-based
            // assertions observing the other file's concurrent inserts.
            // Isolated here with fileParallelism disabled, mirroring
            // allocation-live-sequential/import-scale-sequential above;
            // every other test file keeps running in parallel via the
            // 'default' project.
            fileParallelism: false,
          },
        },
        {
          extends: true,
          test: {
            name: 'allocation-live-sequential',
            include: ['**/tests/allocation/run-behavioral.test.ts', '**/tests/allocation/reproducibility.test.ts', '**/tests/import/schedule-integration-live.test.ts'],
            // These three files all call the global runFeatureExtraction/
            // runAllocation orchestrators (schedule-integration-live.test.ts
            // does so indirectly via runDownstreamProcessingForCaller), which
            // read every applications row with status='accepted' with no
            // per-test scoping (by design — a real run processes whatever is
            // currently accepted). Running them concurrently (Vitest's
            // default across files) races them against the same shared pool:
            // one file's seeded applicant leaks into another's extraction
            // snapshot mid-run, breaking reproducibility and slowing the
            // immutability test past its timeout via resource contention.
            // Isolated into their own project with fileParallelism disabled
            // so only these three run sequentially; every other test file
            // keeps running in parallel via the 'default' project above.
            fileParallelism: false,
          },
        },
        {
          extends: true,
          test: {
            name: 'import-scale-sequential',
            include: ['**/tests/import/scale-500.test.ts', '**/tests/import/scale-5000.test.ts'],
            // Same contention concern as allocation-live-sequential above:
            // these two files drive a real multi-hundred/multi-thousand-row
            // import through the live shared Supabase project and measure
            // wall-clock timing as part of the test's actual assertions
            // (Task 25's "measure and document import performance"
            // requirement). Racing them against each other — or against any
            // other live-DB test file — would contaminate both the timing
            // numbers and risk resource contention slowing either past its
            // generous-but-finite timeout. Isolated here with
            // fileParallelism disabled so only these two run sequentially;
            // every other test file keeps running in parallel via the
            // 'default' project above.
            fileParallelism: false,
          },
        },
      ],
    },
  };
});
