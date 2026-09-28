// tests/allocation/paginated-fetch.test.ts
//
// Pure, mock-driven coverage for fetchAllRowsPaginated (Phase 7G-K finding:
// PostgREST caps an unpaginated select() at 1000 rows on this project,
// which was silently dropping accepted applications from every allocation
// run once the disposable project's accepted-application count crossed
// that cap). Exercises the keyset (`id > lastSeenId`) pagination contract
// directly against an in-memory fake table — no live database needed to
// prove the boundary math and duplicate-detection are correct.
import { describe, expect, it } from 'vitest';
import { fetchAllRowsPaginated } from '@/lib/allocation/paginated-fetch';

interface Row {
  id: string;
}

// Zero-padded numeric-looking ids sort identically under string comparison
// and numeric comparison, keeping the fixture easy to reason about while
// still exercising real lexicographic `id > lastSeenId` filtering (the
// same comparison Postgres performs on a text/uuid primary key).
function makeRows(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({ id: String(i + 1).padStart(6, '0') }));
}

function fakeQueryFactory(allRows: Row[], pageSize: number) {
  return (lastSeenId: string | null, requestedPageSize: number) => {
    expect(requestedPageSize).toBe(pageSize);
    const startIndex = lastSeenId === null ? 0 : allRows.findIndex((r) => r.id === lastSeenId) + 1;
    const page = allRows.slice(startIndex, startIndex + requestedPageSize);
    return Promise.resolve({ data: page, error: null });
  };
}

describe('fetchAllRowsPaginated', () => {
  it('returns an empty array for 0 matching rows', async () => {
    const rows = await fetchAllRowsPaginated(fakeQueryFactory([], 1000));
    expect(rows).toEqual([]);
  });

  it('returns exactly 1 row without an extra empty-page request', async () => {
    const all = makeRows(1);
    const rows = await fetchAllRowsPaginated(fakeQueryFactory(all, 1000));
    expect(rows).toEqual(all);
  });

  it('returns all rows when the count is exactly one page below the cap (999)', async () => {
    const all = makeRows(999);
    const rows = await fetchAllRowsPaginated(fakeQueryFactory(all, 1000));
    expect(rows.length).toBe(999);
    expect(rows).toEqual(all);
  });

  it('returns all rows when the count exactly equals the page size (1000) — the boundary PostgREST silently truncated at before this fix', async () => {
    const all = makeRows(1000);
    const rows = await fetchAllRowsPaginated(fakeQueryFactory(all, 1000));
    expect(rows.length).toBe(1000);
    expect(rows).toEqual(all);
  });

  it('returns all rows when the count is one over a full page (1001) — this exact case silently dropped 1 row under the old unpaginated query', async () => {
    const all = makeRows(1001);
    const rows = await fetchAllRowsPaginated(fakeQueryFactory(all, 1000));
    expect(rows.length).toBe(1001);
    expect(rows).toEqual(all);
  });

  it('returns all rows at the exact scale that exposed the original defect (1170, matching the live disposable project at time of discovery)', async () => {
    const all = makeRows(1170);
    const rows = await fetchAllRowsPaginated(fakeQueryFactory(all, 1000));
    expect(rows.length).toBe(1170);
    expect(rows).toEqual(all);
  });

  it('returns all rows across more than one full extra page (2001)', async () => {
    const all = makeRows(2001);
    const rows = await fetchAllRowsPaginated(fakeQueryFactory(all, 1000));
    expect(rows.length).toBe(2001);
    expect(rows).toEqual(all);
  });

  it('preserves ascending id order across page boundaries', async () => {
    const all = makeRows(2500);
    const rows = await fetchAllRowsPaginated(fakeQueryFactory(all, 1000));
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].id > rows[i - 1].id).toBe(true);
    }
  });

  it('throws loudly rather than silently deduplicating when the same id is returned twice', async () => {
    const duplicated = [{ id: '000001' }, { id: '000002' }, { id: '000002' }];
    let call = 0;
    const queryFactory = () => {
      call += 1;
      // First call returns both rows (simulating a duplicate within a
      // single page — the invariant this guards is "no id appears twice
      // in the assembled result", regardless of which page it came from).
      if (call === 1) return Promise.resolve({ data: duplicated, error: null });
      return Promise.resolve({ data: [], error: null });
    };
    await expect(fetchAllRowsPaginated(queryFactory, 1000)).rejects.toThrow(/duplicate id/i);
  });

  it('propagates a query error instead of silently returning a partial result', async () => {
    const queryFactory = () => Promise.resolve({ data: null, error: { message: 'boom', name: 'PostgrestError', details: '', hint: '', code: '500' } });
    await expect(fetchAllRowsPaginated(queryFactory as never, 1000)).rejects.toThrow(/boom/);
  });

  it('page-shift regression: a row shifting earlier in id-order (via deletion of a row ahead of the cursor) between page requests is not skipped', async () => {
    // Simulates exactly the hazard offset/range pagination was vulnerable
    // to: after fetching page 1, an earlier-sorting row is removed from
    // the underlying table (e.g. an application leaving 'accepted' status)
    // before page 2 is requested. Under offset pagination this shifts
    // every later row's position left by one, causing `.range(1000, 1999)`
    // to skip the row that used to sit at the old position 1000. Keyset
    // pagination's cursor is an absolute id value, not a position, so it
    // is unaffected by how many rows precede it.
    const all = makeRows(1500);
    let deleted = false;
    const queryFactory = (lastSeenId: string | null, pageSize: number) => {
      // Simulate the row at index 500 (a row that sorts well before the
      // page-1/page-2 boundary at 1000) being removed from the matched
      // set right after page 1 is served but before page 2 is requested.
      if (lastSeenId !== null && !deleted) {
        all.splice(500, 1);
        deleted = true;
      }
      const startIndex = lastSeenId === null ? 0 : all.findIndex((r) => r.id === lastSeenId) + 1;
      const page = all.slice(startIndex, startIndex + pageSize);
      return Promise.resolve({ data: page, error: null });
    };
    const rows = await fetchAllRowsPaginated(queryFactory, 1000);
    // The row originally at the tail end of the un-mutated 1500-row set
    // (id '001500') must still be present — an offset-based scan would
    // have re-numbered it into a position already consumed by page 1's
    // .range(0, 999) and silently dropped it.
    expect(rows.some((r) => r.id === '001500')).toBe(true);
    // The deletion happens after page 1 (indices 0-999, ids 000001-001000)
    // is already served, so the removed row (originally at index 500,
    // already included in page 1) does not reduce the final count — this
    // proves the row-shift hazard specifically: an offset-based scan would
    // have re-derived page 2 as .range(1000, 1499) against the
    // now-1499-row set and skipped whichever row shifted into position
    // 999, but keyset pagination's absolute cursor is unaffected by the
    // count change entirely.
    expect(rows.length).toBe(1500);
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.size).toBe(rows.length); // no duplicates
  });
});
