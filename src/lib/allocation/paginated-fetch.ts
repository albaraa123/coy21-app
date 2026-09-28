// src/lib/allocation/paginated-fetch.ts
import type { PostgrestError } from '@supabase/supabase-js';

// PostgREST caps an unpaginated select() response at a server-configured
// max (1000 rows on this project, confirmed directly against the live
// project) — a single `.select().eq(...)` call silently returns only the
// first page with no error, which silently dropped up to 170 real accepted
// applications from every allocation run once the disposable project's
// accepted-application count crossed 1000 (Phase 7G-K finding).
//
// KEYSET, not offset/range: an earlier version of this helper used
// `.range(from, to)`. That is vulnerable to a real correctness hazard —
// `.range()` page boundaries are positions in a live, currently-matching
// row count, and neither runAllocation's caller (triggerAllocationRun) nor
// the admission-review status-change action (updateApplicationStatus,
// src/app/[locale]/(admin)/applications/[id]/actions.ts) nor the bulk
// import RPC (apply_import_row_transactional) coordinate with each other —
// any of them can change which applications match `status = 'accepted'`
// between this helper's separate page requests. If a row is inserted into
// or removed from the matched set ahead of an already-fetched page
// boundary, every row after it shifts position, and `.range()` can skip a
// row entirely (confirmed reproducible against the live disposable
// project: tests/allocation/run-behavioral.test.ts intermittently showed a
// hard-eligible seeded participant completely absent from every scored
// pair, with no error, when this raced against concurrent test activity).
//
// Keyset pagination — `id > lastSeenId` instead of a numeric offset — has
// no positional dependency on how many rows currently precede the cursor,
// so a row inserted or removed elsewhere in the ordering cannot shift an
// already-fixed absolute cursor value out from under an in-flight scan.
// This closes the specific page-shift skip/duplicate hazard.
//
// This is NOT a point-in-time snapshot. A row that transitions into the
// filtered set (e.g. an application becoming `accepted`) after this scan
// has already passed its `id`-ordered position will not be picked up by a
// later page — the same "read committed as of when each page executed"
// semantics any live multi-request read has. That residual property is
// accepted by design for the current allocation workflow (see Phase 7G-K
// investigation): fixing it would require an actual frozen participant
// snapshot (an allocation-run-scoped snapshot table, an admission freeze,
// or a single long-running transaction), which is a separate, larger
// business decision this fix does not make.
export async function fetchAllRowsPaginated<T extends { id: string }>(
  queryFactory: (lastSeenId: string | null, pageSize: number) => PromiseLike<{ data: T[] | null; error: PostgrestError | null }>,
  pageSize = 1000
): Promise<T[]> {
  const allRows: T[] = [];
  const seenIds = new Set<string>();
  let lastSeenId: string | null = null;

  while (true) {
    const { data, error } = await queryFactory(lastSeenId, pageSize);
    if (error) throw new Error(`Paginated fetch failed after cursor ${lastSeenId ?? '(start)'}: ${error.message}`);
    const page = data ?? [];
    for (const row of page) {
      // A duplicate here would mean the same id was returned twice, which
      // a strictly-greater-than cursor on a unique key makes impossible
      // under normal operation. Fail loudly rather than silently
      // double-counting a participant in allocation.
      if (seenIds.has(row.id)) throw new Error(`Paginated fetch encountered duplicate id ${row.id} — result set is not stable under pagination`);
      seenIds.add(row.id);
      allRows.push(row);
    }
    if (page.length < pageSize) break;
    lastSeenId = page[page.length - 1].id;
  }

  return allRows;
}
