# Data Atlas PoC security record

## Review scope

This record covers the local-only, read-only MCP Apps PoC in this directory. It does not approve production deployment, public MCP connections, or a connection to Spota's D1/R2. The implementation is intentionally fixture-only until a separate OAuth 2.1, MFA, RBAC, data-minimisation, and production-storage review is completed.

## Supply-chain pinning

- `create-mcp-app` skill source: `modelcontextprotocol/ext-apps` commit `10195ad91851502134930e9b80ec2c04e277a720`
- Installed skill SHA-256: `fb8897196a6e2db0dc8e98a50bba7343433276a2c79757026a570dce41610a0e`
- Runtime dependencies are exact-version pinned in `package.json` and `package-lock.json`.
- Initial installation used `npm ci --ignore-scripts`.
- `npm audit --omit=dev`: 0 vulnerabilities.
- CycloneDX SBOM generated locally: 128 locked components. Direct and transitive package metadata was inspected for lifecycle scripts before any script-enabled install.
- Installed package licenses were counted from package metadata: MIT 112, BSD-3-Clause 3, ISC 8, BSD-2-Clause 1, Apache-2.0 1. The lockfile is the authoritative version and integrity record.

Lifecycle scripts found in the locked tree are not run during the approved install. In particular, `esbuild` has a platform-binary `postinstall`; the PoC build succeeded with scripts disabled, so enabling lifecycle scripts is not required for this review.

## Data boundary

The only data source is `data/atlas-fixture.json`. Zod validation bounds the snapshot to aggregate counters, region labels, and source-license status. The fixture is below 16 KiB and regression tests reject fields for photos, EXIF, exact coordinates, R2 keys, user identifiers, and notification tokens.

The two tools are explicitly read-only and allowlisted:

- `atlas-summary`
- `atlas-details`

There is no generic SQL, URL fetch, file path input, command execution, write operation, model-context update, host message, or browser storage.

## Transport and UI boundary

- stdio is available only to the local process that starts it.
- HTTP binds to `127.0.0.1` and rejects non-loopback Host headers.
- HTTP mode refuses to start unless `SPOTA_ATLAS_OPERATOR_TOKEN` is present.
- HTTP mode refuses tokens shorter than 32 UTF-8 bytes.
- Bearer comparison is constant-time and the token is never logged.
- Browser Origin is accepted only on exact equality with `SPOTA_ATLAS_ALLOWED_ORIGIN`; wildcard CORS is not used. Originless HTTP is rejected unless `SPOTA_ATLAS_ALLOW_ORIGINLESS_HTTP=1` is explicitly set for a verified native host.
- JSON request bodies are limited to 64 KiB.
- The process allows at most four active requests and thirty requests per minute.
- Audit output contains only allow/deny, status, and duration. It does not record headers, bodies, IP addresses, coordinates, photos, or tokens.
- JSON parser errors return fixed `400` or `413` bodies without stack traces or filesystem paths.
- The bundled UI has an empty `connectDomains`, `resourceDomains`, and `frameDomains` CSP declaration and contains no direct network request.

## Verification evidence

The following completed locally without modifying the main Worker or native app:

```text
npm ci --ignore-scripts       PASS
npm audit --omit=dev         PASS, 0 vulnerabilities
npm run build                PASS, TypeScript + Vite single HTML bundle
npm test                     PASS, 3 security/data-boundary tests
stdio initialize/list/call  PASS
stdio resources/read        PASS
HTTP without token          401
HTTP with token              200
HTTP unapproved Origin      403
```

The security team must re-review before any commit is pushed. App Store, Cloudflare, or public MCP release remains blocked until a real operator identity provider, MFA, per-tool authorization, host compatibility tests, production data adapter, and end-to-end redacted audit logging are separately approved.
