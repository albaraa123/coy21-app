// tests/fixtures/import/build-fixtures.ts
//
// Generates synthetic Excel fixtures for the accepted-participants import
// test suite (Tasks 24/25/26). Per the design spec: "do not use real
// participant information in repository fixtures" — every row here is
// produced by the deterministic generator below, never hand-crafted or
// copied from a real spreadsheet.
//
// Run with: npx tsx tests/fixtures/import/build-fixtures.ts
// (or `npm run build:fixtures`, see package.json)
//
// Output goes to tests/fixtures/import/generated/, which is gitignored —
// regenerate on demand rather than committing multi-MB binaries. Only this
// script is committed.
//
// No `faker` dependency: a tiny inline deterministic name/email generator
// (below) is enough for structured synthetic rows, and guarantees
// value-identical cell content across regenerations — every worksheet's
// data (xl/worksheets/sheet1.xml) is identical run to run. The .xlsx files
// themselves are NOT byte-identical: exceljs stamps docProps/core.xml's
// created/modified timestamps with the real wall-clock time at write time
// (wb.created/wb.modified are never set here), so a raw file-hash/checksum
// comparison across two generator runs will differ even though every cell
// value is the same. If a future test needs true byte-for-byte stability,
// set wb.created = wb.modified = new Date(0) before writeBuffer().

import ExcelJS from 'exceljs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = join(__dirname, 'generated');

// ---------------------------------------------------------------------------
// Deterministic synthetic-data generator
// ---------------------------------------------------------------------------

const FIRST_NAMES_EN = [
  'Amina', 'Yusuf', 'Layla', 'Omar', 'Farah', 'Tariq', 'Noura', 'Karim',
  'Salma', 'Hassan', 'Rana', 'Bilal', 'Dina', 'Zaid', 'Huda', 'Fadi',
  'Mariam', 'Sami', 'Reem', 'Adam',
];
const LAST_NAMES_EN = [
  'Al-Farsi', 'Haddad', 'Khoury', 'Saleh', 'Nasser', 'Mansour', 'Rashid',
  'Qasimi', 'Zayed', 'Barakat',
];
const FIRST_NAMES_AR = [
  'أمينة', 'يوسف', 'ليلى', 'عمر', 'فرح', 'طارق', 'نورة', 'كريم', 'سلمى', 'حسن',
];
const LAST_NAMES_AR = [
  'الفارسي', 'حداد', 'الخوري', 'صالح', 'ناصر', 'منصور', 'راشد', 'القاسمي', 'زايد', 'بركات',
];
const COUNTRIES = ['Oman', 'UAE', 'Qatar', 'Bahrain', 'Kuwait', 'Saudi Arabia', 'Jordan', 'Egypt'];
const CITIES = ['Muscat', 'Dubai', 'Doha', 'Manama', 'Kuwait City', 'Riyadh', 'Amman', 'Cairo'];
const ORGANIZATIONS = ['Green Future NGO', 'EcoTech Solutions', 'Climate Youth Network', 'Sustainability Corp', 'Al Bidayah Foundation'];
const INTEREST_OPTIONS = ['Renewable Energy', 'Climate Policy', 'Youth Advocacy', 'Waste Management', 'Water Conservation', 'Biodiversity'];
const EXPERIENCE_LEVELS = ['Beginner', 'Intermediate', 'Advanced'];

/** Deterministic pseudo-random pick using row index — no Math.random. */
function pick<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length];
}

interface SyntheticPerson {
  fullName: string;
  email: string;
  phone: string;
  country: string;
  city: string;
  organization: string;
  interests: string[];
  experienceLevel: string;
  birthDate: Date;
}

/** Deterministically generates the Nth synthetic person (0-indexed). */
function syntheticPerson(n: number, opts: { arabic?: boolean; emailDomain?: string } = {}): SyntheticPerson {
  const first = opts.arabic ? pick(FIRST_NAMES_AR, n) : pick(FIRST_NAMES_EN, n);
  const last = opts.arabic ? pick(LAST_NAMES_AR, n + 3) : pick(LAST_NAMES_EN, n + 3);
  const emailFirst = pick(FIRST_NAMES_EN, n).toLowerCase().replace(/[^a-z]/g, '');
  const emailLast = pick(LAST_NAMES_EN, n + 3).toLowerCase().replace(/[^a-z]/g, '');
  const domain = opts.emailDomain ?? 'example.com';
  const email = `${emailFirst}.${emailLast}${n}@${domain}`;
  const phone = `+968${String(90000000 + (n * 137) % 9999999).padStart(8, '0')}`;
  const interestCount = 1 + (n % 3);
  const interests: string[] = [];
  for (let i = 0; i < interestCount; i++) interests.push(pick(INTEREST_OPTIONS, n + i * 2));
  // Deterministic birth date: ages roughly 18-45, spread across the year.
  const year = 1980 + (n % 27);
  const month = 1 + (n % 12);
  const day = 1 + (n % 28);
  return {
    fullName: `${first} ${last}`,
    email,
    phone,
    country: pick(COUNTRIES, n),
    city: pick(CITIES, n),
    organization: pick(ORGANIZATIONS, n),
    interests,
    experienceLevel: pick(EXPERIENCE_LEVELS, n),
    birthDate: new Date(Date.UTC(year, month - 1, day)),
  };
}

// ---------------------------------------------------------------------------
// Header sets
// ---------------------------------------------------------------------------

// English headers use exact KNOWN_FIELDS EN aliases (field-dictionary.ts)
// so the mapping-suggestion engine matches them with confidence 1.0.
const HEADERS_EN = [
  'Full Name', 'Email', 'Phone', 'Country', 'City', 'Organization',
  'Interests', 'Experience Level', 'Date of Birth',
];
// Arabic headers use exact KNOWN_FIELDS AR aliases.
const HEADERS_AR = [
  'الاسم الكامل', 'البريد الإلكتروني', 'رقم الهاتف', 'الدولة', 'المدينة', 'الجهة',
  'الاهتمامات', 'مستوى الخبرة', 'تاريخ الميلاد',
];
// Mixed: some columns EN, some AR, same underlying fields.
const HEADERS_MIXED = [
  'Full Name', 'البريد الإلكتروني', 'Phone', 'الدولة', 'City', 'الجهة',
  'Interests', 'مستوى الخبرة', 'Date of Birth',
];

function personToRow(p: SyntheticPerson, opts: { multiSelectDelimiter?: 'comma' | 'semicolon' | 'newline'; birthAsDate?: boolean } = {}): (string | number | Date)[] {
  const delim = opts.multiSelectDelimiter ?? 'comma';
  const sep = delim === 'comma' ? ', ' : delim === 'semicolon' ? '; ' : '\n';
  const birth: string | Date = opts.birthAsDate ? p.birthDate : p.birthDate.toISOString().slice(0, 10);
  return [
    p.fullName,
    p.email,
    p.phone,
    p.country,
    p.city,
    p.organization,
    p.interests.join(sep),
    p.experienceLevel,
    birth,
  ];
}

// ---------------------------------------------------------------------------
// Workbook helpers
// ---------------------------------------------------------------------------

async function writeWorkbook(filename: string, sheetName: string, headers: (string)[], rows: (string | number | Date)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(headers);
  for (const row of rows) ws.addRow(row);
  const buffer = await wb.xlsx.writeBuffer();
  writeFileSync(join(OUT_DIR, filename), Buffer.from(buffer));
}

// ---------------------------------------------------------------------------
// Fixture generators
// ---------------------------------------------------------------------------

async function buildValidEnglish() {
  const rows = Array.from({ length: 50 }, (_, i) => personToRow(syntheticPerson(i)));
  await writeWorkbook('valid-english.xlsx', 'Participants', HEADERS_EN, rows);
}

async function buildValidArabic() {
  const rows = Array.from({ length: 50 }, (_, i) => personToRow(syntheticPerson(i, { arabic: true })));
  await writeWorkbook('valid-arabic.xlsx', 'المشاركون', HEADERS_AR, rows);
}

async function buildMixedHeadings() {
  const rows = Array.from({ length: 50 }, (_, i) => personToRow(syntheticPerson(i, { arabic: i % 2 === 0 })));
  await writeWorkbook('mixed-headings.xlsx', 'Participants', HEADERS_MIXED, rows);
}

async function buildMissingRequired() {
  // Mix of valid rows and rows with blank name/email — validateRow (Task 10)
  // treats blank full_name/email as an 'invalid' status with an error.
  const rows: (string | number | Date)[][] = [];
  for (let i = 0; i < 20; i++) {
    const p = syntheticPerson(i);
    if (i % 5 === 1) {
      // blank full name
      rows.push(personToRow({ ...p, fullName: '' }));
    } else if (i % 5 === 3) {
      // blank email
      rows.push(personToRow({ ...p, email: '' }));
    } else {
      rows.push(personToRow(p));
    }
  }
  await writeWorkbook('missing-required.xlsx', 'Participants', HEADERS_EN, rows);
}

async function buildInvalidEmails() {
  // isValidEmail (normalization.ts) requires /^[^\s@]+@[^\s@]+\.[^\s@]+$/ —
  // these variants each fail that shape check in a different way.
  const malformedEmails = [
    'not-an-email',            // no @ at all
    'missing-domain@',         // nothing after @
    '@missing-local.com',      // nothing before @
    'double@@at.com',          // malformed @ usage (still fails the regex due to no dot after second local part)
    'no-dot@domaincom',        // no dot in domain
    'has space@example.com',   // whitespace inside local part
  ];
  const rows = malformedEmails.map((email, i) => personToRow({ ...syntheticPerson(i), email }));
  await writeWorkbook('invalid-emails.xlsx', 'Participants', HEADERS_EN, rows);
}

async function buildDuplicateEmails() {
  // Repeats 3 emails across multiple rows to exercise
  // classifyDuplicateStatus's 'duplicate_in_file' path.
  const dupeEmails = ['dupe1@example.com', 'dupe2@example.com', 'dupe3@example.com'];
  const rows: (string | number | Date)[][] = [];
  for (let i = 0; i < 15; i++) {
    const p = syntheticPerson(i);
    if (i < 6) {
      // each of the 3 dupe emails appears twice in rows 0-5
      rows.push(personToRow({ ...p, email: dupeEmails[i % 3] }));
    } else {
      rows.push(personToRow(p));
    }
  }
  await writeWorkbook('duplicate-emails.xlsx', 'Participants', HEADERS_EN, rows);
}

async function buildExistingParticipants() {
  // CONTRACT for paired live tests: a live test using this fixture must
  // seed `applications` rows with imported_email = 'existing1@example.com'
  // and imported_email = 'existing2@example.com' BEFORE importing this
  // file, to exercise the existing_unclaimed / existing_claimed
  // duplicate-classification paths in classifyDuplicateStatus
  // (row-validation.ts). Specifically:
  //   - 'existing1@example.com' should be seeded with applicant_id = NULL
  //     (unclaimed) -> expected classification: existing_unclaimed
  //   - 'existing2@example.com' should be seeded with a non-null
  //     applicant_id (claimed) -> expected classification: existing_claimed
  // The remaining rows in this fixture use fresh emails not present in the
  // seed, so they exercise the "no existing match" (null classification)
  // path for contrast.
  const rows: (string | number | Date)[][] = [];
  rows.push(personToRow({ ...syntheticPerson(0), email: 'existing1@example.com' }));
  rows.push(personToRow({ ...syntheticPerson(1), email: 'existing2@example.com' }));
  for (let i = 2; i < 10; i++) rows.push(personToRow(syntheticPerson(i)));
  await writeWorkbook('existing-participants.xlsx', 'Participants', HEADERS_EN, rows);
}

async function buildMultiSelectAnswers() {
  // Exercises splitMultiSelect's delimiter set (/[,;\n]+/, normalization.ts)
  // by rotating comma / semicolon / newline separators across rows.
  const delimiters: ('comma' | 'semicolon' | 'newline')[] = ['comma', 'semicolon', 'newline'];
  const rows = Array.from({ length: 12 }, (_, i) =>
    personToRow(syntheticPerson(i), { multiSelectDelimiter: delimiters[i % delimiters.length] })
  );
  await writeWorkbook('multiselect-answers.xlsx', 'Participants', HEADERS_EN, rows);
}

async function buildExcelNativeDates() {
  // Real Date objects (not strings) for birth_date — exceljs writes these as
  // native Excel date cells; extractDataRows converts them back to ISO date
  // strings via cellToValue's `instanceof Date` branch.
  const rows = Array.from({ length: 10 }, (_, i) => personToRow(syntheticPerson(i), { birthAsDate: true }));
  await writeWorkbook('excel-native-dates.xlsx', 'Participants', HEADERS_EN, rows);
}

async function buildPhoneFormats() {
  // normalizePhone preserves the value exactly as entered (leading zeros,
  // plus signs, spacing) — these variants exercise that preservation.
  const phones = [
    '0791234567',       // leading zero, no country code
    '+968 9123 4567',   // plus sign with spaces
    '+96891234567',     // plus sign, no spaces
    '00968 91234567',   // international dial prefix
    '(079) 123-4567',   // punctuated
    '079-123-4567',
  ];
  const rows = phones.map((phone, i) => personToRow({ ...syntheticPerson(i), phone }));
  await writeWorkbook('phone-formats.xlsx', 'Participants', HEADERS_EN, rows);
}

async function buildBlankRepeatedHeaders() {
  // Blank header cell (col 3) and a repeated 'Email' header (col 5) —
  // extractHeaderRow reports these literally; mapping-suggestion/UI layer
  // is responsible for flagging duplicates/blanks.
  const headers = ['Full Name', 'Email', '', 'Country', 'Email'];
  const rows = Array.from({ length: 8 }, (_, i) => {
    const p = syntheticPerson(i);
    return [p.fullName, p.email, p.city, p.country, p.email];
  });
  await writeWorkbook('blank-repeated-headers.xlsx', 'Participants', headers, rows);
}

async function buildChangedAnswersReimport() {
  // Two versions of the same file sharing 5 overlapping emails whose
  // answers differ between v1 and v2 — for testing re-import/update
  // behavior. v1 has 8 rows (5 overlapping + 3 v1-only); v2 has 8 rows (the
  // same 5 overlapping emails with CHANGED answers + 3 different v2-only
  // rows), so a re-import test can assert the overlapping rows are updated
  // rather than duplicated.
  const overlapEmails = Array.from({ length: 5 }, (_, i) => `reimport${i}@example.com`);

  const v1Rows: (string | number | Date)[][] = overlapEmails.map((email, i) =>
    personToRow({ ...syntheticPerson(i), email, city: 'Muscat', experienceLevel: 'Beginner' })
  );
  for (let i = 5; i < 8; i++) v1Rows.push(personToRow(syntheticPerson(i, { emailDomain: 'v1only.example.com' })));
  await writeWorkbook('reimport-v1.xlsx', 'Participants', HEADERS_EN, v1Rows);

  const v2Rows: (string | number | Date)[][] = overlapEmails.map((email, i) =>
    // Changed answers: different city/experience level/organization for the
    // same email, simulating an admin updating the source sheet.
    personToRow({ ...syntheticPerson(i), email, city: 'Dubai', experienceLevel: 'Advanced', organization: 'Updated Org LLC' })
  );
  for (let i = 8; i < 11; i++) v2Rows.push(personToRow(syntheticPerson(i)));
  await writeWorkbook('reimport-v2.xlsx', 'Participants', HEADERS_EN, v2Rows);
}

async function buildScale(rowCount: number, filename: string) {
  const rows = Array.from({ length: rowCount }, (_, i) => personToRow(syntheticPerson(i)));
  await writeWorkbook(filename, 'Participants', HEADERS_EN, rows);
}

// ---------------------------------------------------------------------------
// Phase B fixtures (design doc section 13.10): travel/health sensitive data,
// structured allocation fields, mixed sensitive-data completeness at scale.
// ---------------------------------------------------------------------------

// Phase B headers use the exact bilingual wording supplied for the real
// RCOY MENA Google Form (design doc section 13.2/13.12 point 3 — the exact
// Arabic aliases will need refinement once a real exported response sheet
// is available; these already match field-dictionary.ts's aliases exactly,
// so they score confidence 1.0 today regardless).
const HEADERS_PHASE_B_EN = [
  'Full Name', 'Email', 'Session Languages', 'Track 1 focus areas',
  'Departure Airport', 'Allergies',
];
const HEADERS_PHASE_B_AR = [
  'اسمك الكامل', 'البريد الإلكتروني', 'اللغات التي يمكنك استخدامها خلال جلسات المؤتمر',
  'المحور الأول: التكيف والمرونة والرفاه الإنساني', 'مطار المغادرة', 'الحساسية وتفاصيلها',
];

type PhaseBRowOpts = {
  sessionLanguages?: string[];
  track1FocusAreas?: string[];
  departureAirport?: string;
  allergies?: string;
};

function phaseBPersonRow(p: SyntheticPerson, opts: PhaseBRowOpts = {}): (string | number)[] {
  return [
    p.fullName,
    p.email,
    (opts.sessionLanguages ?? []).join(', '),
    (opts.track1FocusAreas ?? []).join(', '),
    opts.departureAirport ?? '',
    opts.allergies ?? '',
  ];
}

// Design doc section 13.10, scenarios 6-9: travel-only / health-only / both
// / neither, in one file so a single import batch exercises all four
// conditional-upsert branches of apply_import_row_transactional together.
async function buildSensitiveDataMix() {
  const rows: (string | number)[][] = [
    phaseBPersonRow(syntheticPerson(0, { emailDomain: 'travel-only.example.com' }), {
      sessionLanguages: ['Arabic', 'English'],
      track1FocusAreas: ['Adaptation'],
      departureAirport: 'RUH',
      // no allergies -> travel row only, no health row
    }),
    phaseBPersonRow(syntheticPerson(1, { emailDomain: 'health-only.example.com' }), {
      sessionLanguages: ['English'],
      allergies: 'Peanuts, shellfish',
      // no departureAirport -> health row only, no travel row
    }),
    phaseBPersonRow(syntheticPerson(2, { emailDomain: 'both.example.com' }), {
      sessionLanguages: ['Arabic'],
      track1FocusAreas: ['Resilience', 'Human Well-being'],
      departureAirport: 'DXB',
      allergies: 'None',
    }),
    phaseBPersonRow(syntheticPerson(3, { emailDomain: 'neither.example.com' }), {
      sessionLanguages: ['English', 'Arabic'],
      // no travel/health fields at all -> neither row created
    }),
  ];
  await writeWorkbook('sensitive-data-mix.xlsx', 'Participants', HEADERS_PHASE_B_EN, rows);
}

// Design doc section 13.10, scenario 3: bilingual/multiline heading mapping
// for the new Phase B fields specifically (distinct from the pre-existing
// buildValidArabic/buildMixedHeadings, which only cover the original 9
// fields).
async function buildPhaseBBilingualHeadings() {
  const rows = Array.from({ length: 10 }, (_, i) =>
    phaseBPersonRow(syntheticPerson(i, { arabic: true, emailDomain: 'phaseb-ar.example.com' }), {
      sessionLanguages: ['Arabic', 'English'],
      track1FocusAreas: ['Adaptation'],
    })
  );
  await writeWorkbook('phase-b-bilingual-headings.xlsx', 'المشاركون', HEADERS_PHASE_B_AR, rows);
}

// Design doc section 13.10, scenario 10: invalid passport dates — a
// deliberately malformed date string in a travel_field-mapped column, to be
// paired with a live test asserting a row-validation warning (not an
// error) and that the row still imports successfully.
async function buildInvalidPassportDates() {
  const headers = ['Full Name', 'Email', 'Passport Issue Date'];
  const rows = [
    [syntheticPerson(0).fullName, 'invalid-passport-date0@example.com', 'not-a-date'],
    [syntheticPerson(1).fullName, 'invalid-passport-date1@example.com', '2024-13-45'], // invalid month/day
    [syntheticPerson(2).fullName, 'invalid-passport-date2@example.com', '2024-06-15'], // valid, for contrast
  ];
  await writeWorkbook('invalid-passport-dates.xlsx', 'Participants', headers, rows);
}

// Design doc section 13.10, scenario 11: malformed WhatsApp/emergency-contact
// phone numbers — paired with a live test asserting a warning, not a hard
// validation error (matches normalizePhone's existing "never reject"
// philosophy, extended to Phase B's phone-shape check).
async function buildMalformedPhaseBPhones() {
  const headers = ['Full Name', 'Email', 'WhatsApp Number (including country code)'];
  const malformed = ['abc', '123', '!!!not-a-phone!!!'];
  const rows = malformed.map((phone, i) => [syntheticPerson(i).fullName, `malformed-phone${i}@example.com`, phone]);
  await writeWorkbook('malformed-phaseb-phones.xlsx', 'Participants', headers, rows);
}

// Design doc section 13.10, scenario 18: 500-row import with mixed
// sensitive-data completeness — every 4th row pattern (travel-only,
// health-only, both, neither) repeated at scale, to exercise the
// conditional-upsert branches under the same chunked/concurrent apply path
// scale-500.xlsx already tests.
async function buildScaleMixedSensitive(rowCount: number, filename: string) {
  const rows = Array.from({ length: rowCount }, (_, i) => {
    const p = syntheticPerson(i, { emailDomain: 'scale-mixed.example.com' });
    const pattern = i % 4;
    return phaseBPersonRow(p, {
      sessionLanguages: ['Arabic', 'English'],
      track1FocusAreas: pattern === 0 || pattern === 2 ? ['Adaptation'] : undefined,
      departureAirport: pattern === 0 || pattern === 2 ? 'RUH' : undefined,
      allergies: pattern === 1 || pattern === 2 ? 'None' : undefined,
    });
  });
  await writeWorkbook(filename, 'Participants', HEADERS_PHASE_B_EN, rows);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  await buildValidEnglish();               // 1
  await buildValidArabic();                // 2
  await buildMixedHeadings();               // 3
  await buildMissingRequired();             // 4
  await buildInvalidEmails();               // 5
  await buildDuplicateEmails();             // 6
  await buildExistingParticipants();        // 7
  await buildMultiSelectAnswers();          // 8
  await buildExcelNativeDates();            // 9
  await buildPhoneFormats();                // 10
  await buildBlankRepeatedHeaders();        // 11
  await buildChangedAnswersReimport();      // 12 (writes both v1 and v2)
  await buildScale(500, 'scale-500.xlsx');  // 13
  await buildScale(5000, 'scale-5000.xlsx'); // 14
  await buildSensitiveDataMix();            // 15
  await buildPhaseBBilingualHeadings();     // 16
  await buildInvalidPassportDates();        // 17
  await buildMalformedPhaseBPhones();       // 18
  await buildScaleMixedSensitive(500, 'scale-500-mixed-sensitive.xlsx'); // 19

  console.log(`Fixtures generated in ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
