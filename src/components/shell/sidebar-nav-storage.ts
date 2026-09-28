/**
 * Pure, framework-free localStorage read/write helpers for sidebar
 * group-expansion persistence. Split out from sidebar-nav.tsx so the
 * logic can be unit-tested directly (jsdom/DOM-free, since these
 * functions only need a `Storage`-shaped object, not a real browser) per
 * Task 5's test-infrastructure decision — see sidebar-nav.test.ts for the
 * rationale.
 *
 * Storage key varies by which nav config is in use (admin vs.
 * participant) — see STORAGE_KEY_ADMIN / STORAGE_KEY_PARTICIPANT below —
 * because the two sidebars have entirely different group sets and must
 * not share persisted state.
 */

export const STORAGE_KEY_ADMIN = 'rcoy-admin-nav-v1';
export const STORAGE_KEY_PARTICIPANT = 'rcoy-participant-nav-v1';

/**
 * Reads the persisted set of expanded group labelKeys for the given
 * storage key. Returns an empty array on any failure (missing key,
 * malformed JSON, storage unavailable) — expansion state is a pure UX
 * nicety, never something worth throwing over.
 */
export function readExpandedGroups(storage: Pick<Storage, 'getItem'>, storageKey: string): string[] {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

/**
 * Persists the given set of expanded group labelKeys. Swallows failures
 * (e.g. storage quota, private-browsing restrictions) — same reasoning
 * as readExpandedGroups.
 */
export function writeExpandedGroups(
  storage: Pick<Storage, 'setItem'>,
  storageKey: string,
  expandedGroupKeys: readonly string[]
): void {
  try {
    storage.setItem(storageKey, JSON.stringify(expandedGroupKeys));
  } catch {
    // Ignore — see module doc.
  }
}
