import { describe, it, expect } from 'vitest';
import en from '@/messages/en.json';
import ar from '@/messages/ar.json';

describe('participant nav labels: My Program / Conference Program', () => {
  it('English: agenda label is "My Program", schedule label is "Conference Program"', () => {
    expect(en.nav.participant.agenda).toBe('My Program');
    expect(en.nav.participant.schedule).toBe('Conference Program');
  });

  it('Arabic: agenda label is "برنامجي", schedule label is "برنامج المؤتمر"', () => {
    expect(ar.nav.participant.agenda).toBe('برنامجي');
    expect(ar.nav.participant.schedule).toBe('برنامج المؤتمر');
  });
});
