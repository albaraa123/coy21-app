// src/lib/dashboard/dashboard-types.ts
//
// Shared view-model contract for every dashboard query in this module
// (admin-dashboard-queries.ts, participant-dashboard-queries.ts). Task 11's
// dashboard pages consume ONLY CardResult<T> values — never a raw query
// result — so every card on the page can render one of exactly 4 states
// without the page itself having to re-derive "is this actually a real
// zero, or did the query just fail silently?" from ambiguous data.
//
// The 4 states are semantically distinct and MUST NOT be collapsed into
// each other:
//   - 'data'          a real value was read successfully, including a
//                      genuine zero/empty-array. A count of 0 accepted
//                      applications is `{ kind: 'data', value: 0 }`, NEVER
//                      `{ kind: 'empty' }` — those mean different things to
//                      an admin (zero accepted so far vs. "we couldn't even
//                      check").
//   - 'empty'         the entity itself has never existed for this caller
//                      (e.g. no allocation run has ever been kicked off; a
//                      participant with no invitation and no application at
//                      all). Distinct from a real zero: there is nothing to
//                      count, not a count of nothing.
//   - 'unauthorized'  the caller failed this function's own internal
//                      authorization re-check (see each query's doc
//                      comment for what it re-verifies). Never reached by
//                      a legitimate authorized caller in normal operation
//                      — this exists so a bug elsewhere (e.g. a page
//                      forgetting its own gate) fails closed instead of
//                      leaking data.
//   - 'error'         the query itself failed (network/DB error, malformed
//                      response). MUST NEVER be silently coerced into a
//                      displayed 0 or empty state — that would misinform
//                      an admin that "there are none" when the truth is
//                      "we don't know".
export type CardResult<T> =
  | { kind: 'data'; value: T }
  | { kind: 'empty' }
  | { kind: 'unauthorized' }
  | { kind: 'error'; message: string };
