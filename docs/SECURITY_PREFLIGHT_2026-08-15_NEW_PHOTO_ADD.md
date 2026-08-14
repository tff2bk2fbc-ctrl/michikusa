# Security preflight: photo import and social actions

Date: 2026-08-15
Scope: `origin/main..HEAD` (`v108` photo recovery, likes/comments verification, Flash UI/API/D1)

## Decision

**APPROVED FOR PUSH.** No critical, high, medium, or low security regression was found in this delta. This approval covers the reviewed changes only and is not a claim that the entire product is vulnerability-free.

## Communication and privacy review

### SEC-PHOTO-01 — Native photo reads stay inside the app bridge

- Severity: Pass
- Evidence: `public/native.js:27-37`, `public/post.js:91-105`
- Review: The app accepts same-origin files and Capacitor-provided `localhost/_capacitor_file_` URLs only. The native bridge exception also requires an internal `nativeAsset` marker. Arbitrary Internet photo URLs are rejected.
- Data leaving device: none during selection or EXIF parsing.

### SEC-PHOTO-02 — Failed IndexedDB transactions cannot be reported as success

- Severity: Pass
- Evidence: `public/core.js:120-141`, `public/post.js:76-83`
- Review: A photo is successful only after the complete IndexedDB transaction commits. `error` and `abort` fail closed. A storage recovery retry compacts server-synced copies only; unsynced originals are retained.

### SEC-PHOTO-03 — EXIF and upload data remain bounded

- Severity: Pass
- Evidence: `public/native.js:54-94`, `public/post.js:65-74`, `public/sync.js:91-164`
- Review: Selection is explicit and capped at 200 photos. Local originals are bounded to a 4096-pixel JPEG. Server uploads use separately resized JPEG variants, which do not include the original EXIF metadata.

### SEC-SOCIAL-01 — Likes, comments, and Flash stay behind authentication

- Severity: Pass
- Evidence: `src/index.js:113-130`, `src/index.js:1339-1523`
- Review: All routes execute after Firebase authentication. They re-check post visibility and block relationships server-side. SQL values use D1 prepared bindings, and comments use idempotent operation IDs.

### SEC-SOCIAL-02 — Flash cannot bypass privacy or moderation

- Severity: Pass
- Evidence: `src/index.js:1401-1523`, `migrations/0003_post_flash.sql`
- Review: Flash accepts published public posts with a moderation-approved thumbnail only. It excludes users blocked by the actor or post owner, is limited to five recipients, and is one action per user and post. Burst, per-user daily, and global daily limits are enforced.
- Data leaving device: existing FCM delivery receives notification text and a post ID only. No photo bytes, EXIF, latitude, or longitude are added to Flash storage or push payloads.

### SEC-SOCIAL-03 — Partial failures remain retryable

- Severity: Pass
- Evidence: `src/index.js:1478-1521`
- Review: Notification writes use a D1 batch and dedupe key. If recipient selection or the batch fails, only a zero-recipient claim is removed so the authenticated user can retry without duplicate delivery.

### SEC-CONFIG-01 — No new secret or external endpoint

- Severity: Pass
- Evidence: repository secret scan and `wrangler deploy --dry-run`
- Review: The delta adds no API key, private key, credential, third-party script, or new remote hostname. The existing Firebase Web API key is a public client identifier and was not introduced or changed here; server credentials remain Worker secrets.

## Verification

- Automated syntax, security, photo, UI, migration, and social integration tests: 58/58 passed.
- GPS photo browser flow: `1枚から1か所` → `1枚を1か所に置きました` succeeded.
- Persistence: after a full reload, the saved album still contained the photo.
- Likes/comments/Flash: save, count, notification, read-back, idempotency, block filtering, and unlike all passed against a real SQLite constraint engine through a D1-compatible adapter.
- Remote D1: `post_flashes` migration applied; migration journal aligned; foreign-key violations: 0.
- Recovery point: a D1 Time Travel bookmark was captured before migration.
- Cloudflare Worker build: `wrangler deploy --dry-run` passed.
- iOS simulator build: passed.
- Connected iPhone device build, signing, install, and launch: passed.
- `unsafeForcedSync`: not present in either simulator or device build output and not reproduced during the captured device launch.
- `git diff --check`: passed.
