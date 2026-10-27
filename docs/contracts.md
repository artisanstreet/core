# Core contracts v1 (initial decisions — 2026-10-26)

Owner: Core (`/home/sander/projects/artisanstreet/core`). Root routes; Relay and
Rust/Forge contributors implement against this file. On drift, this file wins;
coordinate changes via root before editing wire format.

Status: initial decisions published for Relay + Rust integration. Auth session,
vault, config, and deletion endpoints are listed as paths; their full schemas
land with the implementation. Machine identity, request proof, grant JWT/JWKS,
and pairing lifecycle below are normative for v1.

## 0. Choices (why this shape)

- Grant JWT alg is **EdDSA (Ed25519)**, not ES256. Rust already depends on
  `ed25519-dalek`; Cloudflare WebCrypto and `jose@6` both support Ed25519
  (verified in Node 24 WebCrypto 2026-10-26: generate/sign/verify/JWK export).
  Standards-based JWT + JWK + JWKS, no custom token format.
- Machine keys are Ed25519 everywhere (enrollment, request proof, grant
  subject). One algorithm across Forge/Core/Relay removes negotiation drift.
- Pairing enrolls a Forge machine into an **account**, not per Editor
  (per `editor/docs/plans/ast-relay-project-replication.md`: full trust after
  pairing, no per-project/read-only tiers). Scopes distinguish *use*
  (routing vs execution vs machine sync), not privilege tiers.

## 1. Base, versioning, conventions

- Base URLs: prod `https://api.artisan.st` (configurable via
  `CORE_PUBLIC_BASE_URL`); dev `http://127.0.0.1:8787`.
- All product endpoints are versioned: `/v1/*`. Breaking wire change → `/v2`;
  additive fields are allowed within v1.
- `GET /v1/version` → `{ "api": "1", "contracts": "1.0.0",
  "jwksUri": "/.well-known/jwks.json", "openapi": "/v1/openapi.json" }`.
- Machine-readable contract: `contracts/v1.openapi.json` (authoritative once
  published); cross-language fixtures: `fixtures/v1/*.json`.
- Timestamps: RFC 3339 UTC strings (`2026-10-26T20:00:00.000Z`). Durations in
  seconds unless named `*At`/`*Ms`.
- IDs: `{prefix}_{ULID}` Crockford base32, e.g. `acct_01K…`, `sess_…`, `mch_…`,
  `enr_…`, `logreq_…`. Regex: `^(acct|sess|mch|enr|logreq|conn|bundle)_[0-9A-HJKMNP-TV-Z]{26}$`.
  Account ID in JWT `sub` uses the same `acct_…` string.
- Requests: **strict** — unknown JSON fields are rejected (`400`). Responses:
  forward-compatible reads — receivers ignore unknown fields.
- Ownership is server-derived. Clients never send `accountId` to claim scope,
  except echoing it inside signed proof strings where the server re-derives
  and compares. Session/machine auth determines the account.
- Errors: `{ "error": { "code": "snake_case", "message": "human",
  "requestId": "…" } }`, HTTP status mirrors `code` class. `message` never
  carries secrets, tokens, or hashes.

## 2. Machine public key format (normative)

- Ed25519. Transmitted **only** as JWK:
  `{ "kty": "OKP", "crv": "Ed25519", "x": "<base64url 32 bytes>" }`.
  No raw PEM/DER on the wire. Extra JWK members are rejected on requests,
  ignored on reads.
- Forge stores the raw 32-byte public/64-byte private key locally (existing
  `identity.json` / Forge keypair location is Forge's choice); wire form is
  always the JWK above.
- Fingerprint for display/pinning (CLI, logs):
  `SHA-256(raw 32 pubkey bytes)`, base64url no-pad. Example field name
  `keyFingerprint`. Never log private material.

## 3. Machine request proof (Forge → Core, normative)

Used for enrollment polling/confirmation and for issuing a grant. (Most other
machine calls may use the grant JWT instead; §4.)

- Headers per request:
  - `X-AST-Machine: <mch_… or enr_…>` (for enrollment polling, the
    `enr_…` id; after confirmation, the `mch_…` id).
  - `X-AST-Timestamp: <unix seconds, integer as string>`.
  - `X-AST-Nonce: <base64url, ≥12 random bytes, unique per request>`.
  - `Authorization: AST-Machine <base64url Ed25519 signature>`.
- Body hash: hex lowercase `SHA-256(raw request body bytes)`; empty body →
  hash of empty string
  (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`).
- Canonical string (UTF-8, `\n` separators, no trailing newline):
  `{timestamp}\n{nonce}\n{METHOD}\n{pathAndQuery}\n{bodyHashHex}`
  - `METHOD` uppercased (`GET`, `POST`, …).
  - `pathAndQuery` is origin-form, e.g. `/v1/machines/enrollments/enr_XXX`
    or `/v1/machines/enrollments/enr_XXX/status?x=1`. Scheme/host excluded.
- Signature: Ed25519 over UTF-8 canonical bytes with the private key whose
  public key the server holds for that id (enrollment pending key, or machine
  key). Base64url no-pad in the header.
- Server checks: id exists and not revoked/expired; `|now - timestamp| ≤ 300`s;
  atomic durable nonce dedup: `INSERT` into `machine_nonces(subject, nonce)`
  with a unique constraint; conflict → `401 machine_auth_failed` (replay).
  No best-effort cache. Recompute body hash (constant-time compare); Ed25519
  verify. Failure → `401 machine_auth_failed`, no account oracle.
- Rust: `ed25519-dalek` verify over canonical bytes; base64url via existing
  workspace `base64` conventions; SHA-256 via existing deps. No new crypto
  algorithms.

## 4. Grant JWT: Core-signed access for Relay/Forge (normative)

Standards JWT, JWS compact, `alg: "EdDSA"` (Ed25519), `typ: "JWT"`.

- Header: `{ "alg": "EdDSA", "kid": "<key id>", "typ": "JWT" }`.
  `kid` example: `core-2026-10-a`. Rotation keeps ≤2 kids valid; verifiers
  refresh JWKS on unknown `kid`.
- Claims (all required unless noted):
  - `v` (integer): `1`. Contract version of the claim set; verifiers reject
    unknown `v`. Audience stays `ast-relay`/`ast-core` (no `-v1` suffix).
  - `iss` (string): `https://api.artisan.st` (value equals
    `CORE_JWT_ISSUER`; dev `http://127.0.0.1:8787`).
  - `aud` (string, exact match): `ast-relay` (present to Relay / used inside
    tunnel setup) or `ast-core` (machine sync: vault/config). One audience
    per token; tokens are not cross-honored.
  - `sub` (string): account id `acct_…`.
  - `mid` (string): explicit target machine `mch_…`. For machine grants this
    is the machine itself; for Editor/user grants to Relay this is the
    **target Forge machine** the client wants to reach. Relay grants always
    bind a target `mid` (no unbound relay tokens).
  - `role` (string): `"forge"` (acting as the enrolled machine) or
    `"client"` (Editor/user reaching a machine). Relay admission is key-bound
    (see `cnf`).
  - `cnf` (object): confirmation key
    `{ "jwk": { "kty": "OKP", "crv": "Ed25519", "x": "…" } }`.
    Machine grants: `cnf.jwk` MUST equal the enrolled machine key. Editor
    grants: `cnf.jwk` is an ephemeral Ed25519 key generated per sign-in/
    connection (not user-visible pairing), submitted by the authenticated
    session at grant issuance; the Editor proves possession of it to Relay.
  - `scope` (string[]): subset of
    `["relay:connect", "forge:execute", "machine:sync"]`.
    Full trust = all three. Routing-only bearer = `["relay:connect"]`.
    No per-project or read-only tiers in v1.
  - `iat`, `nbf` (= iat), `exp`: seconds. TTL default 300 s, **max 300 s**.
    Core always emits `nbf` (peers that treat it as optional stay compatible).
  - `jti`: unique per token (`tkn_…` ULID or UUIDv7 string).
- No `rev` claim in v1 (decision 2026-10-26): Rust/Relay drafts required a
  `rev` integer, but Core maintains no per-token revocation epoch — short
  TTL (≤300 s) plus the `revokedMachineIds`/`revokedKeyIds` revocation list
  is the revocation mechanism, and Relay holds no per-machine mutable state
  (no shared DB). Peers: remove the `rev` requirement. If epochs are ever
  needed, they ship as a `v: 2` claim change, not a silent extra field.
- Audience rule: Core emits `aud` as a singular string and verifiers MUST
  exact-match it. Peers MAY tolerate array-formed `aud` from other issuers
  only with a narrow membership check against the single expected audience;
  Core never emits arrays.
- Verification (Relay/Forge, independent of Core availability): fetch JWKS,
  select by `kid`, check `alg == EdDSA`, verify Ed25519 JWS (never `none`,
  never algorithm confusion), then check `v == 1`, `iss`, `aud` exact,
  `exp/nbf` with ≤60 s clock skew, `sub`/`mid` format, `role` value,
  requested scope ⊆ `scope`, and **key-bound admission**: the connecting
  party proves possession of the `cnf` private key with an Ed25519 signature
  over the actual Noise handshake hash (transcript format is Relay's spec;
  Core defines only the keys and the JWT).
  Cache JWKS 10 min; on unknown `kid` refetch once before rejecting.
  Revocation bound: short TTL (≤300 s) is the revocation mechanism;
  additionally Core publishes `revokedKeys`/`revokedMachines` best-effort
  list consumed by Relay
  (`GET /v1/grants/revocations`, 60 s cache). No request-proof inspection of
  application plaintext by Relay: Relay verifies the grant envelope only.
- Endpoints:
  - `POST /v1/machine/grants/issue` (machine proof §3, or valid session for
    user grants) `{ "audience": "ast-relay"|"ast-core",
    "scope": [...], "ttlSeconds": 300,
    "targetMachineId": "mch_…" (required when audience is ast-relay),
    "cnf": {JWK} (required for session-issued Editor grants; omitted for
    machine grants where cnf defaults to the enrolled key) }`
    → `{ "token": "<jwt>", "expiresAt": "…" }`. Server intersects requested
    scope with what the account/machine is entitled to and enforces
    `ttlSeconds ≤ 300`.
  - `POST /v1/grants/issue` (session alias for Editor grants; same body).
  - `GET /.well-known/jwks.json` → `{ "keys": [
    { "kty": "OKP", "crv": "Ed25519", "x": "…", "kid": "…",
      "use": "sig", "alg": "EdDSA" } ] }` (public keys only, cacheable).
  - `GET /v1/grants/revocations` → `{ "revokedMachineIds": [...],
    "revokedKeyIds": [...], "asOf": "…" }`.

### Relay usage (for Relay contributor)

- Transport is Noise XX (Relay-owned). Core grants are presented **inside
  the encrypted handshake confirmation**, not as cleartext bearers where
  the transport allows it. Presentation mechanics are Relay's spec; the
  credential is always the Core JWT below.
- Forge→Relay and Editor→Relay present a grant JWT (`aud=ast-relay`).
  Relay verifies the grant **envelope** only: JWKS/`kid`, `alg==EdDSA`,
  `iss`/`aud` exact, `exp`/`nbf`, `scope` ⊇ required scope. It routes
  opaque bytes; it does not inspect or log application plaintext.
- Required scope: `relay:connect`; tunneled execution additionally requires
  `forge:execute` (Relay checks presence, Forge enforces execution itself
  as the paired full-trust peer).
- Key-bound admission (Ed25519 signatures over the **actual handshake
  hash**, no custom crypto, no X25519 registry in Core):
  - Forge verifies the client's grant JWT **and** a transcript signature
    made with the grant's `cnf` private key over the actual Noise handshake
    hash. Machine grants: `cnf` equals the enrolled machine key.
    Editor grants: `cnf` is the Editor's per-connection ephemeral Ed25519
    key, submitted by the authenticated session at issuance.
  - Editor fetches the target Forge's enrolled Ed25519 public key from
    authenticated Core (`GET /v1/machines` returns `publicKey` JWKs for the
    account's machines) and verifies Forge's transcript signature against it.
  - Core stores no Noise/X25519 keys: standard `cnf` issuance plus the
    existing enrolled machine key field is the whole Core surface.
- Relay needs no shared DB and no Core internals import — only JWKS +
  revocation list + this section.

## 5. Pairing lifecycle: Forge machine → account (normative)

Goal: enrolling a Forge machine into an account. Attacker guessing the short
code cannot enroll without the local Forge's private-key confirmation bound
to the exact account/key. Codes are single-use, short TTL, rate-limited.

1. **Forge starts enrollment** (unauthenticated + proof-of-possession of the
   fresh keypair):
   `POST /v1/machines/enrollments`
   `{ "publicKey": {JWK}, "label": "server-forge", "timestamp": 173…,
      "proof": "<base64url Ed25519 over
      `enrollment-request\n<x>\n<label>\n<timestamp>`>" }`
   → `201 { "enrollmentId": "enr_…", "code": "8-char",
   "expiresAt": "…", "keyFingerprint": "…" }`.
   `code`: 8 chars from a 31-symbol unambiguous alphabet
   (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`, ~39.6 bits), 10 min TTL,
   SHA-256 hash stored, raw code returned once.
   Rate limit per IP. An absent/wrong code cannot map to an enrollment, so
   wrong-code limits are enforced per account, per IP, and globally — not
   per enrollment.
2. **Signed-in user claims it**:
   `POST /v1/machines/enrollments/claim` (session auth)
   `{ "code": "XXXXXXXX" }` → `{ "enrollmentId": "enr_…",
   "status": "claimed" }`. Binds enrollment to the session's account.
   Rate limits: per account, per IP, and global wrong-code budgets; codes
   burn on success and expire on TTL. No existence oracle beyond
   rate-limit responses.
3. **Forge polls** (machine proof §3 with `X-AST-Machine: enr_…`, i.e. an
   authenticated caller holding the enrollment private key):
   `GET /v1/machines/enrollments/{id}/status`
   → `{ "status": "pending"|"claimed"|"confirmed"|"expired"|"voided",
   "accountId": "acct_…"|null,
   "email": "full verified address"|null,
   "displayName": "…"|null }`.
   When `claimed`, the polling Forge sees the full verified email/display
   for the account that claimed it; the local operator explicitly approves
   that exact identity (no masked-only hint, no copy/paste of account IDs).
   `email`/`accountId` are only ever returned to the proven holder of the
   enrollment key, never to unauthenticated callers.
4. **Forge confirms locally** (explicit operator action, machine proof §3):
   `POST /v1/machines/enrollments/confirm`
   `{ "enrollmentId": "enr_…", "accountId": "acct_…",
      "confirmation": "<base64url Ed25519 over
      `enrollment-confirm\n<enrollmentId>\n<accountId>\n<x>`>" }`
   → `201 { "machineId": "mch_…", "accountId": "acct_…" }`.
   Server: enrollment exists, unexpired, `claimed` to that same account,
   signature verifies with the enrollment public key over the exact
   account+key binding. Then the machine row is created; code is burned.
   Without this private-key signature over the exact account, no machine is
   created — guessing the code is insufficient.
- Later: `GET /v1/machines` (session) lists the account's machines;
  `POST /v1/machines/{id}/revoke` (session, account scope) revokes;
  machines auth thereafter with §3 or §4 (`machine:sync`).

## 6. Remaining v1 paths (schemas land with implementation)

Auth/sessions: `POST /v1/auth/magic/request`, `GET /v1/auth/magic/confirm`,
`POST /v1/auth/magic/consume|approve|finalize`, `GET /v1/auth/status`,
TOTP `…/totp/{enroll|verify|disable}`, recovery codes, `…/sessions/*`.
Requester-secret binding + explicit original-session approval for
cross-browser flows; email alone never bypasses TOTP (normative behavior,
schemas follow). Vault: provider connections + per-machine assignment, decrypt
only for assigned authenticated machines. Machine discovery for sync: the two
list endpoints accept machine auth and return ONLY the caller's own assigned
metadata (`GET /v1/vault/connections`, `GET /v1/engine-artifacts`; secrets and
envelopes are never listed, and no other machine's assignments leak), so Forge
learns its assigned IDs without a session. Per-id download/release stay
machine-proofed and account-bound. Engine artifacts: opaque envelopes from the
harness's own local login (Core performs no OAuth), strict shape validation.
Config: versioned MCP/skill bundles
(content SHA-256, R2 manifest, applied-revision reports). Activity + account
deletion lifecycle. Full request/response/event schemas in Effect Schema with
strict requests; OpenAPI export; fixtures under `fixtures/v1/`.

### Sign-in link entry (API-only)

- Shipped email links are `GET /v1/auth/magic/confirm?token=…`. The GET is
  read-only: valid tokens return `{ status: "confirmation_required" }`;
  invalid tokens are 400 JSON. The GET never consumes and never redirects
  (mail scanners that merely fetch approve nothing). Approval is an
  explicit `POST /v1/auth/magic/consume`; completion is `POST
  /v1/auth/magic/finalize` with the originating request secret.
- The Worker binds no static assets and serves no HTML. Every unknown,
  root, asset, or legacy UI path returns JSON 404 (`not_found`); API
  (`/v1/*`) and metadata (`/.well-known/*`) paths are the only surface.
- The separate web product (`web/`, own build) lives on its own host and
  calls the same consume/finalize API; it is never bundled or served by
  `api.artisan.st`.

### Config sync (checksum-based invalidation)

- `GET /v1/config/bundles/latest` and `GET /v1/config/bundles/:version/manifest`
  are account-scoped conditional GETs. Responses carry a strong `ETag` (the
  quoted content SHA-256) and private cache directives (`latest` must
  revalidate; versioned manifest blobs are immutable for a year). Forge and
  Editor persist the hash/revision and send `If-None-Match`; a match returns
  `304` with an empty body, saving downloads and cost. Authentication is
  evaluated before the conditional, so bad credentials never get a 304.
  Private configs are never shared through public caches.
- Rust client: persist the content hash (and version) per account/machine and
  always revalidate with `If-None-Match` before downloading; treat `304` as
  "local copy current" and `200` as "replace local copy, store new hash".

### Skill bundles (exact schema for Rust/browser)

`SkillRef` keeps `source` (already-installed lookup, still required) and
gains an optional `bundle` for machines that lack the skill:

```json
{ "name": "code-review", "source": "builtin",
  "bundle": { "files": [
    { "path": "SKILL.md", "contentBase64": "…", "sha256": "…" },
    { "path": "refs/checklist.md", "contentBase64": "…", "sha256": "…" }
  ] } }
```

- `files`: 1–64 entries; total decoded ≤ 1 MiB. Paths are relative to the
  skill root: non-empty, ≤ 256 chars, no leading `/`, no `..` segments.
  Every bundle MUST include `SKILL.md` at the root; each file's `sha256`
  (hex) must match its decoded bytes. Violations are `400`.
- Bytes live inside the content-hashed R2 manifest — no new service, table,
  or endpoint. Forge installs bundle files verbatim under the skill root on
  a new machine; machines that already have the skill keep using `source`.
  Unchanged bundles are never re-downloaded (manifest `ETag`/`304`).

## 7. Integration order (ask)

1. Rust: implement §2–§5 against `fixtures/v1/machine-proof.json` and
   `fixtures/v1/grant.json` (landing next); report any canonical-string or
   JWK mismatch before coding the tunnel.
2. Relay: implement §4 verification + revocation polling; confirm JWKS cache
   TTL and required scope check for tunneled execution.
3. Core: full services + tests + dry-run follow in this repo; contract edits
   go through root.

## 8. Commentary for root (2026-10-26, rev 2)

- EdDSA/Ed25519 JWT kept per review. Added `v: 1`, `role: client|forge`,
  explicit target `mid` on ALL relay grants, `cnf: {jwk}` key binding.
  Editor ephemeral key auto-generated per sign-in/connection, submitted by
  the authenticated session — not user-visible pairing. Machine-grant `cnf`
  must equal the enrolled machine key. TTL max 300 s. Audiences stay
  `ast-relay`/`ast-core` (Relay's `ast-relay-v1` not adopted; version rides
  in `v`).
- Pairing simplified per review: authenticated polling Forge sees full
  `accountId` + verified email/display; operator approves the exact identity.
  No masked-only hint, no account-ID copy/paste.
- Nonce replay: atomic durable `INSERT` with unique(subject, nonce);
  best-effort cache removed. Relay holds no nonce state (JWT only).
- Code entropy corrected to ~40 bits (32⁸); wrong-code limits are per
  account/IP/global since absent codes don't map to enrollments.
- No X25519 anywhere — enrollment/request-proof/grants are Ed25519 only, so
  nothing binds to the unconfirmed X25519 shape; Relay's revised crypto
  should stay within Ed25519 + JWT/JWKS.
- Next: machine-readable OpenAPI + fixtures, then services/tests.
