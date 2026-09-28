# QR Token Format and Lifecycle — Canonical Contract

**Status:** Approved. This document is the single canonical source for the QR credential token format, referenced by both issuance (Phase 6.1) and scanning (Phase 7). It closes the gap left by `docs/superpowers/specs/_phase6-qr-rpc-reference-draft.md`'s §10 "Open items carried forward," which named this section but never wrote it.

**Do not implement issuance, reissue, or scan-time resolution against any other interpretation of the token format.** If this document and any other comment/prose disagree, this document wins; fix the other location.

---

## 1. Raw token

```
rawToken = crypto.randomBytes(32)   // Node's built-in CSPRNG
```

- Exactly 32 bytes, 256 bits of entropy.
- Generated **only** in trusted Node server-side code — never in the browser, never in SQL/Postgres, never derived from any existing identifier (credential UUID, application ID, participant data, timestamp, etc.).
- Never persisted in plaintext, anywhere, at any point — not in the database, not in logs, not in a cache.

## 2. Text token

```
encodedToken = base64url_unpadded(rawToken)
```

- Base64url alphabet: `A-Z`, `a-z`, `0-9`, `-`, `_`.
- **No padding** (`=` characters never appear).
- Canonical length for a 32-byte input: **exactly 43 characters**.
- Forbidden in canonical form: `+`, `/`, `=`, any whitespace, or any other non-canonical representation of the same 32 bytes.

## 3. QR payload

```
rcoy:v1:<encodedToken>
```

- Prefix is exactly `rcoy:v1:`, case-sensitive, matched literally.
- Total payload length: `8 + 43 = 51` characters.
- This is the exact string encoded into the QR code image and the exact string a scanner submits after decoding.

## 4. Canonical parsing (scan-time and any other consumer)

Parsing a submitted payload string must, in order:

1. Require the exact `rcoy:v1:` prefix (case-sensitive).
2. Require exactly 43 characters after the prefix.
3. Require every character to be in the base64url alphabet (`A-Z`, `a-z`, `0-9`, `-`, `_`) only.
4. Reject any padding character (`=`) or whitespace anywhere in the payload.
5. Base64url-decode the 43-character token portion.
6. Require the decoded value to be exactly 32 bytes.
7. Re-encode those 32 decoded bytes as unpadded base64url.
8. Require the re-encoded text to be **byte-for-byte identical** to the originally supplied token text.

Step 7–8 exists specifically to prevent multiple textual representations (e.g. a non-canonical base64 variant that happens to decode to the same bytes) from being treated as valid — only the single canonical encoding of a given 32 bytes is ever accepted. Any failure at any step is a single collapsed "malformed" outcome; do not attempt partial recovery or leniency at any step.

## 5. Hash contract

```
tokenHash = SHA256(rawToken)     // the 32 RAW bytes, before any text encoding
```

- **Not** `SHA256("rcoy:v1:" + encodedToken)`.
- **Not** `SHA256(encodedToken)` (the base64url text).
- **Not** `SHA256(UTF8 bytes of the text token)`.
- Hashing happens on the raw 32 bytes only, immediately after generation, before any text encoding is ever produced.
- This is the value stored in `qr_credentials.token_hash` (`bytea`, 32 bytes, per the existing, unmodified schema constraint `check (octet_length(token_hash) = 32)`).
- Scan-time resolution recomputes this same hash from the raw bytes recovered by canonical-parsing + base64url-decoding a submitted payload, then looks up `qr_credentials` by `token_hash` equality. Scan-time verification **never** requires decrypting `token_ciphertext`.

## 6. Encryption contract

**Algorithm:** AES-256-GCM.

**Plaintext:** the same original 32 raw token bytes — not the encoded text, not the `rcoy:v1:` payload, not the hash.

**Envelope layout — exactly 61 bytes, matching the existing, unmodified schema/finalizer/trigger checks (`octet_length(token_ciphertext) = 61`, `get_byte(token_ciphertext, 0) = 1`):**

| Bytes | Length | Content |
|---|---|---|
| `0` | 1 | Envelope version marker — `0x01` |
| `1..12` | 12 | Nonce/IV — fresh cryptographically random bytes, generated independently for every single encryption call |
| `13..44` | 32 | AES-256-GCM ciphertext (same length as the 32-byte plaintext, as GCM is a stream cipher mode — no padding) |
| `45..60` | 16 | AES-GCM authentication tag |

Total: `1 + 12 + 32 + 16 = 61` bytes.

**Hard requirements:**
- A fresh random 12-byte nonce is generated for every encryption call — never reused with the same key, ever.
- The authentication tag is always exactly 16 bytes (AES-GCM's standard/default tag length; do not shorten it).
- Decryption must explicitly validate, in order: total envelope length = 61 → version byte is a supported version → GCM authentication tag verifies → decrypted plaintext length = 32 bytes. Any failure at any step fails closed (throws), never returns partial/unauthenticated plaintext.
- Tampered ciphertext or tag must fail authentication and must never be treated as a soft/recoverable error.
- No alternate envelope layout is ever introduced without a new version byte and a new section in this document.

This table was derived from, and is fully consistent with, the schema/trigger/finalizer checks already present unmodified in `supabase/migrations/20260805235959_phase6_qr_issuance_reissue.sql` (`qr_credentials_enforce_lifecycle_trigger`, `finalize_qr_issuance_for_server`, `finalize_qr_reissue_for_server`) — no migration change was required to support this contract.

## 7. Key material

The database (`qr_encryption_key_registry`) stores **only metadata** — `key_version`, `status` (`active` / `decrypt_only` / `retired`), `activated_at`, `retired_at`. **No raw key bytes are ever stored in Postgres.** This is existing, unmodified schema — confirmed by inspection, not changed by this document.

**External key source (Node-side, new):**

```
QR_ENCRYPTION_KEY_V<n>=<base64url-unpadded, 32 raw bytes>
```

- One environment variable per key version — e.g. `QR_ENCRYPTION_KEY_V1`, `QR_ENCRYPTION_KEY_V2`, ... — matching this repository's existing convention of flat scalar secrets (`RESEND_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, etc.); no structured/JSON env-var blob is introduced, since no such pattern exists anywhere else in this codebase.
- Encoding: base64url, unpadded — same encoding family as the token itself, for consistency; decoding must yield exactly 32 bytes.
- **Never** prefixed `NEXT_PUBLIC_` — these must never reach the browser bundle.
- **Never** committed to `.env.local` or any tracked file. `.env.local.example` documents the variable name/format only, using an obviously-fake placeholder, never a real key.
- Read only from trusted server-side code (Node server actions / library code never imported by a client component).

**Lookup rule:**
- Encryption always uses the **currently active** key version (`select key_version from qr_encryption_key_registry where status = 'active'`), reading `QR_ENCRYPTION_KEY_V<that version>` from the environment.
- Decryption selects the environment variable matching the credential's own stored `encryption_key_version` column — which may be `active` or `decrypt_only` (both are valid for decryption; only `active` is valid for new encryption, matching the existing `is_encryption_key_version_active` vs. `is_encryption_key_version_decryptable` SQL helpers).
- A `retired` key version, or any key version whose corresponding environment variable is missing or fails to decode to exactly 32 bytes, fails closed — the operation throws, it never silently falls back to a different key or proceeds with degraded/no authentication.
- No silent truncation or padding of a malformed environment value is ever performed.

## 8. Storage rules

- `qr_credentials.token_hash` — the SHA-256 of the raw 32 bytes (§5). Already the schema's shape; unmodified.
- `qr_credentials.token_ciphertext` — the 61-byte envelope (§6). Already the schema's shape; unmodified.
- The raw 32 bytes and the encoded/QR-payload text form are **never** persisted anywhere — not in `qr_credentials`, not in any other table, not in a log line, not in a cache, not in `audit_logs` metadata.

## 9. Scan-time lookup rule

```
submitted payload → canonical parse (§4) → raw 32 bytes → SHA256 → qr_credentials.token_hash lookup
```

- Scan-time verification is a **hash lookup only** — it never requires decrypting `token_ciphertext`.
- A row is only eligible to satisfy a scan if `status = 'active'`. `revoked` and `replaced` rows exist in the table (by design, for audit/lifecycle history) but must never resolve as valid at scan time.
- No row found, or a found row with `status <> 'active'`, is a single collapsed "credential does not resolve" outcome at this layer — per the approved Phase 7 design, this maps to the existing `invalid_qr` attendance outcome, not a distinct client-facing vocabulary.

## 10. Plaintext handling

- Raw token bytes exist in memory only for the duration of a single issuance/reissue/decrypt operation, then go out of scope.
- Never logged, in any form — not the raw bytes, not the base64url text, not the full `rcoy:v1:...` payload — at any log level, in any environment, including error paths.
- Never returned to the client except as the direct result of an issuance/reissue call the trusted server-side caller genuinely needs to deliver/render (e.g. handing the QR payload back to the participant who just requested it). Never returned as a byproduct of any other operation (e.g. scanning never returns a token).
- If finalization fails after token material has been generated in memory, the generated material is simply discarded (allowed to be garbage-collected) — no cleanup/rollback of plaintext is needed since it was never persisted, but no retry may reuse the same raw bytes; a fresh `crypto.randomBytes(32)` call is required for any retry.

## 11. Reissue behavior

- A reissue **always** generates an entirely new, independent `crypto.randomBytes(32)` — never derived from, or related to, the old token's raw bytes in any way.
- The old credential's row is transitioned to `status = 'replaced'` (existing, unmodified finalizer behavior) and its `token_hash`/`token_ciphertext` remain in the table for audit/history — they must never resolve at scan time once replaced (§9).
- Every rule in §1–§10 applies identically to a reissue's new token; there is no separate reissue-specific token contract.

---

## Relationship to existing, unmodified infrastructure

This document introduces **no schema or finalizer changes**. Every constraint referenced here (`octet_length(token_hash) = 32`, `octet_length(token_ciphertext) = 61`, `get_byte(token_ciphertext, 0) = 1`, the `qr_encryption_key_registry` active/decrypt_only/retired model, `is_encryption_key_version_active`/`is_encryption_key_version_decryptable`) already exists, unmodified, in `supabase/migrations/20260805235959_phase6_qr_issuance_reissue.sql`. What was missing — and what this document fixes — was purely the Node-side contract for what bytes go into those already-defined shapes.
