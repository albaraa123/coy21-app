import { describe, expect, it } from 'vitest';
import { toSafeCsv } from '@/lib/import/csv-export';

describe('toSafeCsv', () => {
  it('neutralizes formula-injection-prone leading characters', () => {
    const rows = [['=SUM(A1)', '+1', '-1', '@cmd', 'normal']];
    const csv = toSafeCsv(['Col'], rows);
    expect(csv).toContain("'=SUM(A1)");
    expect(csv).toContain("'+1");
    expect(csv).toContain("'-1");
    expect(csv).toContain("'@cmd");
    expect(csv).not.toContain("'normal");
  });

  it('quotes fields containing commas, quotes, or newlines', () => {
    const csv = toSafeCsv(['Col'], [['a,b']]);
    expect(csv).toContain('"a,b"');
  });

  it('escapes embedded double quotes', () => {
    const csv = toSafeCsv(['Col'], [['a"b']]);
    expect(csv).toContain('"a""b"');
  });

  it('includes the header row', () => {
    const csv = toSafeCsv(['Row', 'Error'], [['1', 'Missing email']]);
    expect(csv.split('\n')[0]).toBe('Row,Error');
  });

  it('quotes a formula-injection cell that also contains a comma, doubling the leading-char prefix inside the quotes', () => {
    const csv = toSafeCsv(['Col'], [['=SUM(A1,B1)']]);
    const dataLine = csv.split('\n')[1];
    expect(dataLine).toBe('"\'=SUM(A1,B1)"');
  });

  it('produces the fully escaped output for embedded quotes, not a partial escape', () => {
    const csv = toSafeCsv(['Col'], [['he said "hi"']]);
    const dataLine = csv.split('\n')[1];
    expect(dataLine).toBe('"he said ""hi"""');
  });

  it('quote-wraps a cell containing a bare carriage return, not just newline', () => {
    const csv = toSafeCsv(['Col'], [['line1\rline2']]);
    const dataLine = csv.split('\n')[1];
    expect(dataLine).toBe('"line1\rline2"');
  });

  it('neutralizes a dangerous leading character even after leading whitespace/tab', () => {
    const csv = toSafeCsv(['Col'], [[' =SUM(A1)'], ['\t=SUM(A2)']]);
    const dataLines = csv.split('\n').slice(1);
    expect(dataLines[0]).toBe("' =SUM(A1)");
    expect(dataLines[1]).toBe("'\t=SUM(A2)");
  });
});
