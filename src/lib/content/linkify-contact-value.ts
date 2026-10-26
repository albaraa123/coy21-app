// Local Info Hub items store `value` as plain text. 3 rows (the
// Safeguarding Contact, and the 2 new Key Contacts email items) need an
// embedded tel:/mailto: URI rendered as a real clickable link, without
// turning the data model into a link-parsing minefield for every other
// row (Water, Currency, Prayer times, Police, etc., which all stay plain
// text, untouched). Convention: the admin pastes a literal tel:+994...
// or mailto:foo@bar URI anywhere in the value string; this function
// finds it via regex and splits the string into plain-text and link
// segments around it. No special data-entry convention beyond that.
export type ContactValueSegment =
  | { type: 'text'; value: string }
  | { type: 'link'; href: string; value: string };

const CONTACT_URI_PATTERN = /\b(tel:\+?\d+|mailto:[^\s]+)\b/;

export function linkifyContactValue(value: string): ContactValueSegment[] {
  const match = value.match(CONTACT_URI_PATTERN);
  if (!match) {
    return [{ type: 'text', value }];
  }
  const segments: ContactValueSegment[] = [];
  const before = value.slice(0, match.index);
  const after = value.slice((match.index ?? 0) + match[0].length);
  if (before) segments.push({ type: 'text', value: before });
  segments.push({ type: 'link', href: match[0], value: match[0] });
  if (after) segments.push({ type: 'text', value: after });
  return segments;
}
