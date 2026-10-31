// tests/schedule/agenda-view-storage.test.ts
import { describe, expect, it, vi } from 'vitest';
import { readAgendaView, writeAgendaView, type AgendaView } from '@/components/schedule/agenda-view-storage';

describe('agenda-view-storage', () => {
  it('returns "grid" when nothing is stored', () => {
    const storage = { getItem: () => null };
    expect(readAgendaView(storage, 'k')).toBe('grid');
  });

  it('returns the stored value when it is a valid AgendaView', () => {
    const storage = { getItem: () => 'timeline' };
    expect(readAgendaView(storage, 'k')).toBe('timeline');
  });

  it('returns "grid" for a malformed/unexpected stored value', () => {
    const storage = { getItem: () => 'garbage' };
    expect(readAgendaView(storage, 'k')).toBe('grid');
  });

  it('returns "grid" when storage.getItem throws (private browsing etc.)', () => {
    const storage = { getItem: () => { throw new Error('blocked'); } };
    expect(readAgendaView(storage, 'k')).toBe('grid');
  });

  it('writes the given value under the given key', () => {
    const setItem = vi.fn();
    writeAgendaView({ setItem }, 'k', 'timeline' as AgendaView);
    expect(setItem).toHaveBeenCalledWith('k', 'timeline');
  });

  it('swallows a write failure silently', () => {
    const storage = { setItem: () => { throw new Error('quota'); } };
    expect(() => writeAgendaView(storage, 'k', 'grid')).not.toThrow();
  });
});
