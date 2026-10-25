import { describe, expect, it } from 'vitest';
import { linkifyContactValue } from './linkify-contact-value';

describe('linkifyContactValue', () => {
  it('wraps an embedded tel: URI in a link, leaving surrounding text plain', () => {
    const result = linkifyContactValue('Safeguarding Contact: Ayan Valizada — tel:+994997368333');
    expect(result).toEqual([
      { type: 'text', value: 'Safeguarding Contact: Ayan Valizada — ' },
      { type: 'link', href: 'tel:+994997368333', value: 'tel:+994997368333' },
    ]);
  });

  it('wraps an embedded mailto: URI in a link', () => {
    const result = linkifyContactValue('Official Liaison Email: mailto:liaisons@climatecoy.com');
    expect(result).toEqual([
      { type: 'text', value: 'Official Liaison Email: ' },
      { type: 'link', href: 'mailto:liaisons@climatecoy.com', value: 'mailto:liaisons@climatecoy.com' },
    ]);
  });

  it('returns a single plain text segment when there is no tel:/mailto: URI', () => {
    const result = linkifyContactValue('Available 9am-5pm daily');
    expect(result).toEqual([{ type: 'text', value: 'Available 9am-5pm daily' }]);
  });
});
