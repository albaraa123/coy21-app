// Per OWASP's CSV Injection guidance, the dangerous set is =, +, -, @ plus
// tab and CR — the latter two because some spreadsheet applications still
// treat a leading tab/CR-then-formula as live, and because Excel treats a
// leading whitespace/tab-then-dangerous-char the same as the dangerous char
// appearing first. Checked against the value with leading whitespace
// stripped for the *test*, but the prefix is still applied to the
// ORIGINAL (untrimmed) value — we're deciding whether to neutralize, not
// reformatting the cell's actual content.
const DANGEROUS_LEADING_CHARS = ['=', '+', '-', '@', '\t', '\r'];

function escapeCell(value: string): string {
  let v = value;
  const leadingTrimmed = v.replace(/^\s+/, '');
  if (DANGEROUS_LEADING_CHARS.some((c) => leadingTrimmed.startsWith(c))) {
    v = `'${v}`; // prefix with a literal apostrophe, matching the spec's exact prescription
  }
  // \r (bare carriage return, not just \n) also needs quote-wrapping — an
  // unquoted bare \r could be misread as a record boundary by a consumer
  // that splits on \r as well as \n (e.g. old Mac-style line endings).
  if (v.includes(',') || v.includes('"') || v.includes('\n') || v.includes('\r')) {
    v = `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

export function toSafeCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.join(','), ...rows.map((row) => row.map(escapeCell).join(','))];
  return lines.join('\n');
}
