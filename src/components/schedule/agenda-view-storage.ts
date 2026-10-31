//
// Pure, framework-free localStorage read/write helpers for the agenda
// Grid/Timeline view-toggle preference. Split out from the toggle
// component for unit-testability, mirroring
// src/components/shell/sidebar-nav-storage.ts's exact convention
// (functions taking a Pick<Storage, ...>-shaped object, not the real
// Storage type, so tests don't need jsdom; try/catch, silent on failure --
// view preference is a pure UX nicety, never worth crashing the page over).
//
// Storage key is caller-supplied (not hardcoded here) because the admin
// Sessions page and participant Browse page need separate keys -- see
// each page's own view-toggle usage for its exact key
// (coy21-admin-sessions-view-v1 / coy21-browse-sessions-view-v1), matching
// sidebar-nav-storage.ts's STORAGE_KEY_ADMIN/STORAGE_KEY_PARTICIPANT
// hyphenated, versioned naming convention.

export type AgendaView = 'grid' | 'timeline';

export function readAgendaView(storage: Pick<Storage, 'getItem'>, storageKey: string): AgendaView {
  try {
    const raw = storage.getItem(storageKey);
    return raw === 'timeline' ? 'timeline' : 'grid';
  } catch {
    return 'grid';
  }
}

export function writeAgendaView(storage: Pick<Storage, 'setItem'>, storageKey: string, view: AgendaView): void {
  try {
    storage.setItem(storageKey, view);
  } catch {
    // Ignore -- see module doc.
  }
}
