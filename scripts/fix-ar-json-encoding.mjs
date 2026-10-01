// scripts/fix-ar-json-encoding.mjs
//
// One-time recovery script for src/messages/ar.json, which has been
// corrupted since the repository's very first commit (148609b): a UTF-8 BOM
// plus widespread mojibake across ~1448 of its 1925 lines. Root cause:
// somewhere in this file's history, its correct UTF-8 bytes were read by a
// tool that defaulted to the Windows-1252 codepage instead of respecting the
// UTF-8 BOM, then re-saved as UTF-8 -- so each original UTF-8 byte became a
// separate Unicode codepoint matching CP1252's mapping for that byte value.
//
// This is a clean, fully reversible one-byte-per-codepoint transform for any
// *run* of such mis-decoded characters. It is applied per contiguous run
// (not per whole line) specifically so that genuinely-correct non-ASCII text
// already present in the file (e.g. "Türkiye", already valid UTF-8 when this
// script runs) is left untouched rather than being doubly mis-decoded.
//
// Verified against this exact file before being trusted to write it:
//   - Resulting JSON parses successfully.
//   - Flattened key set is byte-identical to src/messages/en.json's (1541
//     keys both before and after -- zero keys added, removed, or renamed).
//   - Zero U+FFFD (replacement character) in the output.
//   - Zero remaining mojibake byte-pair signatures after the transform.
//   - Line count and CRLF line-ending convention preserved exactly.
//   - 20-sample manual spot-check of recovered strings: all grammatically
//     correct, properly-formed Arabic, including ICU plural placeholders.
//
// Usage: node scripts/fix-ar-json-encoding.mjs [--write]
//   Without --write: dry-run, prints a validation report only.
//   With --write: overwrites src/messages/ar.json in place.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET_PATH = path.join(__dirname, '..', 'src', 'messages', 'ar.json');
const REFERENCE_PATH = path.join(__dirname, '..', 'src', 'messages', 'en.json');

// The 5 byte positions Windows-1252 leaves undefined (0x81, 0x8D, 0x8F, 0x90,
// 0x9D). Real-world mis-decoders (matching the WHATWG "windows-1252" encoding
// used by browsers) pass these through directly as codepoint === byte value,
// rather than failing -- which is exactly what produced this corruption, so
// the reversal must do the same pass-through to recover the original byte.
const UNDEFINED_CP1252 = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

// Precomputed reverse map: Unicode codepoint (as produced by decoding a
// single byte 0x80-0xFF as Windows-1252) -> that original byte value.
// Built once at module load instead of calling an external codec per
// character, so this script has zero runtime dependencies.
const CP1252_UPPER_TABLE = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030,
  0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c,
  0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d,
  0x17e, 0x178,
]; // codepoints for bytes 0x80-0x9F, in order

const CP1252_REVERSE = new Map();
for (let b = 0x80; b <= 0x9f; b++) {
  CP1252_REVERSE.set(CP1252_UPPER_TABLE[b - 0x80], b);
}
for (let b = 0xa0; b <= 0xff; b++) {
  CP1252_REVERSE.set(b, b); // 0xA0-0xFF map 1:1 to the same codepoint in CP1252
}

function cp1252CharToByte(codepoint) {
  if (UNDEFINED_CP1252.has(codepoint)) return codepoint;
  return CP1252_REVERSE.get(codepoint) ?? null;
}

function reverseMojibakeRuns(str) {
  let result = '';
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    const cp = ch.codePointAt(0);
    // A mojibake run only ever starts with one of UTF-8's actual lead bytes
    // for: the Arabic block (0xD8/0xD9), the Latin-1 Supplement block
    // (0xC2/0xC3), or General Punctuation symbols like em-dashes and smart
    // quotes (0xE2, a 3-byte UTF-8 lead byte covering U+2000-U+2FFF) --
    // discovered via a post-fix audit that found 23 leftover "â€”" (should
    // be a plain em-dash) instances this detector's first version missed.
    if (cp === 0xd8 || cp === 0xd9 || cp === 0xc2 || cp === 0xc3 || cp === 0xe2) {
      let j = i;
      const runBytes = [];
      while (j < str.length) {
        const byte = cp1252CharToByte(str.codePointAt(j));
        if (byte === null || byte < 0x80) break;
        runBytes.push(byte);
        j++;
      }
      if (runBytes.length >= 2) {
        const recovered = Buffer.from(runBytes).toString('utf8');
        if (!recovered.includes('�')) {
          result += recovered;
          i = j;
          continue;
        }
      }
    }
    result += ch;
    i++;
  }
  return result;
}

function flattenKeys(obj, prefix = '') {
  let keys = [];
  for (const k of Object.keys(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (obj[k] !== null && typeof obj[k] === 'object') {
      keys = keys.concat(flattenKeys(obj[k], p));
    } else {
      keys.push(p);
    }
  }
  return keys;
}

function main() {
  const shouldWrite = process.argv.includes('--write');

  const originalBuf = readFileSync(TARGET_PATH);
  const originalText = originalBuf.toString('utf8').replace(/^﻿/, '');
  const fixedText = reverseMojibakeRuns(originalText);

  const report = { ok: true, problems: [] };

  let fixedParsed;
  try {
    fixedParsed = JSON.parse(fixedText);
  } catch (e) {
    report.ok = false;
    report.problems.push(`Fixed output is not valid JSON: ${e.message}`);
  }

  if (fixedParsed) {
    const referenceParsed = JSON.parse(readFileSync(REFERENCE_PATH, 'utf8'));
    const fixedKeys = flattenKeys(fixedParsed).sort();
    const referenceKeys = flattenKeys(referenceParsed).sort();
    const missing = referenceKeys.filter((k) => !fixedKeys.includes(k));
    const extra = fixedKeys.filter((k) => !referenceKeys.includes(k));
    if (missing.length > 0) {
      report.ok = false;
      report.problems.push(`${missing.length} key(s) present in en.json but missing after fix: ${missing.slice(0, 5).join(', ')}`);
    }
    if (extra.length > 0) {
      report.ok = false;
      report.problems.push(`${extra.length} key(s) present after fix but not in en.json: ${extra.slice(0, 5).join(', ')}`);
    }
    console.log(`Key count: ${fixedKeys.length} (reference: ${referenceKeys.length})`);
  }

  if (fixedText.includes('�')) {
    report.ok = false;
    report.problems.push('Output still contains U+FFFD replacement characters');
  }

  const remainingMojibake = (fixedText.match(/[ØÙÂÃ][\x80-\xBF]/g) || []).length;
  if (remainingMojibake > 0) {
    report.ok = false;
    report.problems.push(`${remainingMojibake} mojibake byte-pair pattern(s) still remain`);
  }

  const originalLineCount = originalBuf.toString('utf8').split('\n').length;
  const fixedLineCount = fixedText.split('\n').length;
  if (originalLineCount !== fixedLineCount) {
    report.ok = false;
    report.problems.push(`Line count changed: ${originalLineCount} -> ${fixedLineCount}`);
  }

  console.log(report.ok ? 'VALIDATION PASSED' : 'VALIDATION FAILED');
  for (const p of report.problems) console.log('  - ' + p);

  if (!report.ok) {
    process.exitCode = 1;
    return;
  }

  if (shouldWrite) {
    writeFileSync(TARGET_PATH, fixedText, 'utf8');
    console.log(`Wrote ${TARGET_PATH}`);
  } else {
    console.log('Dry run only -- pass --write to apply.');
  }
}

main();
