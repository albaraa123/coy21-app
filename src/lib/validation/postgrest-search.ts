// src/lib/validation/postgrest-search.ts
//
// Shared sanitizer for free-text search terms interpolated into a
// PostgREST `.or()` filter string. `.or()` takes no escaping of its own —
// comma and parens are the filter grammar's own delimiters (column
// separator and value grouping), so they're stripped before interpolating
// rather than rejecting the whole search. `%` and `_` are ilike wildcards;
// they're left as-is deliberately (same behavior every call site already
// had) since a stray wildcard only widens/narrows the caller's own visible
// results, never a row-level bypass.
//
// Extracted from five near-identical copies (admission-lookup.ts,
// funding-management.ts, health-info-management.ts,
// travel-info-management.ts, applications/page.tsx) so the grammar-escaping
// logic has one source of truth instead of five.
export function buildIlikeOrFilter(term: string, columns: readonly string[]): string | null {
  const trimmed = term.trim();
  if (trimmed === '') return null;
  const sanitized = trimmed.replace(/[,()]/g, '');
  if (sanitized === '') return null;
  return columns.map((column) => `${column}.ilike.%${sanitized}%`).join(',');
}
