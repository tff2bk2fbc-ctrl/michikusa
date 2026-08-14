# Security preflight: new photo add recovery

Date: 2026-08-15  
Scope: uncommitted v106 delta only (`public/native.js`, `public/post.js`, cache/version files and tests)

## Decision

**APPROVED FOR COMMIT.** No critical, high, medium, or low security regression was found in this delta. This is a delta approval, not a claim that the entire product is vulnerability-free.

## Communication and privacy review

### SEC-NEWPHOTO-01 — Native photo read stays inside the app origin

- Severity: Pass
- Evidence: `public/native.js:26-37`
- Review: The new Capacitor 8 result is read from the plugin-provided WebView URL. Before `fetch`, the URL is resolved and rejected unless its origin exactly equals the app origin. The change cannot fetch an arbitrary Internet URL.
- Data leaving device: none at this stage.

### SEC-NEWPHOTO-02 — Selection is explicit and bounded

- Severity: Pass
- Evidence: `public/native.js:49-99`
- Review: Camera or library access starts only after the user selects an existing app action. Single-photo gallery selection uses `allowMultipleSelection:false` and `limit:1`. The image is bounded to 4096 by 4096 at 96% quality where supported. Cancellation does not open a second picker.
- Permission: iOS owns and displays the camera/photo permission prompt.

### SEC-NEWPHOTO-03 — EXIF remains local during placement

- Severity: Pass
- Evidence: `public/native.js:40-46`, `public/native.js:102-109`
- Review: EXIF is used locally to determine the photo date and optional placement. This delta does not add EXIF to an API request, URL, log, analytics event, or third-party service. The existing upload pipeline still redraws JPEG variants before upload, which strips EXIF.

### SEC-NEWPHOTO-04 — No new external API or weakened policy

- Severity: Pass
- Evidence: `public/post.js:398-409`, `public/_headers:7`, `src/index.js:38-50`
- Review: The place sheet now calls the same local native chooser as the fixed bottom navigation. No new remote hostname, API route, credential, token storage, CSP exception, inline script, or dynamic-code execution was introduced.

## Verification

- JavaScript syntax and automated flow suite: 52/52 passed.
- Current Capacitor 8 photo-library API opened successfully in an iPhone 17 Pro simulator.
- Current API failure path falls back once to the compatible legacy API; cancellation remains closed.
- Repository and native Xcode public assets are byte-for-byte synchronized.
- `git diff --check`: passed.

