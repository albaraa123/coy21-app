import { describe, expect, it } from 'vitest';
import {
  readExpandedGroups,
  writeExpandedGroups,
  STORAGE_KEY_ADMIN,
  STORAGE_KEY_PARTICIPANT,
} from '@/components/shell/sidebar-nav-storage';

function fakeStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe('sidebar-nav-storage', () => {
  it('storage keys differ between admin and participant configs', () => {
    expect(STORAGE_KEY_ADMIN).not.toBe(STORAGE_KEY_PARTICIPANT);
  });

  it('readExpandedGroups returns [] when nothing is stored', () => {
    const storage = fakeStorage();
    expect(readExpandedGroups(storage, STORAGE_KEY_ADMIN)).toEqual([]);
  });

  it('readExpandedGroups returns [] on malformed JSON instead of throwing', () => {
    const storage = fakeStorage({ [STORAGE_KEY_ADMIN]: '{not json' });
    expect(readExpandedGroups(storage, STORAGE_KEY_ADMIN)).toEqual([]);
  });

  it('readExpandedGroups returns [] when the stored value is not an array', () => {
    const storage = fakeStorage({ [STORAGE_KEY_ADMIN]: JSON.stringify({ foo: 'bar' }) });
    expect(readExpandedGroups(storage, STORAGE_KEY_ADMIN)).toEqual([]);
  });

  it('readExpandedGroups filters out non-string entries', () => {
    const storage = fakeStorage({ [STORAGE_KEY_ADMIN]: JSON.stringify(['a', 1, 'b', null]) });
    expect(readExpandedGroups(storage, STORAGE_KEY_ADMIN)).toEqual(['a', 'b']);
  });

  it('round-trips a written value through readExpandedGroups', () => {
    const storage = fakeStorage();
    writeExpandedGroups(storage, STORAGE_KEY_ADMIN, ['nav.groups.agenda', 'nav.groups.allocation']);
    expect(readExpandedGroups(storage, STORAGE_KEY_ADMIN)).toEqual(['nav.groups.agenda', 'nav.groups.allocation']);
  });

  it('writeExpandedGroups does not throw when setItem throws (quota/private mode)', () => {
    const storage: Storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as unknown as Storage;
    expect(() => writeExpandedGroups(storage, STORAGE_KEY_ADMIN, ['x'])).not.toThrow();
  });

  it('reads are isolated per storage key (admin vs participant)', () => {
    const storage = fakeStorage();
    writeExpandedGroups(storage, STORAGE_KEY_ADMIN, ['admin-group']);
    expect(readExpandedGroups(storage, STORAGE_KEY_PARTICIPANT)).toEqual([]);
    expect(readExpandedGroups(storage, STORAGE_KEY_ADMIN)).toEqual(['admin-group']);
  });
});
