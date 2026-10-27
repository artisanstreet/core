# AST browser UI (`core/web/`) — implementation + decisions

Owner: browser contributor. Scope: `core/web/` (app) + this doc only.
Core service author (Emily) owns all other core files; Relay lives in its
own repo (read-only for alignment); Rust integration author (Vilde) owns
the Forge side. Root routes; siblings do not message each other.

## What this is

The authorized account portal/cafe UI: magic-link sign-in with cross-tab
approval, account/machines/sessions/TOTP/vault/artifacts/config/activity/
deletion, and remote-Forge thread reading over a verified Relay Noise
channel. No mockups: every value on screen comes from a live API response.

- Stack: TypeScript 7.1 beta + Effect. Schemas from
  `core/src/contracts/v1.ts` (Effect Schema authoritative; strict requests,
  forward-compatible response reads). Own `package.json`/build
  (`npm run build` → `web/dist/`); Core worker serves the bundle as static
  assets (wiring owned by Emily; see “Needed wiring” below).
- Dev: `npm run dev` (port 5173, proxies `/v1` + `/.well-known` to Core;
  cookies stay same-origin). `CORE_DEV_URL` overrides the Core origin.

## Relay client: vendored release, not a sibling import

Deployed runtime never imports `../../relay/src`. `scripts/vendor-relay.mjs`
copies the exact files into `web/vendor/relay/` and records the source
commit + SHA-256 per file in `INTEGRITY.json` (+ `VERSION`).
Pinned release: **`7e4963a`** (Noise XX, `send_app`/`send_acked` + `on_ack`
ack-forwarding, `sealed_frame_size`, per-channel 64-frame / 1 MiB window).
`tests/vendor-integrity.test.ts` fails the build on any drift.
To move releases: check out the announced Relay commit in the sibling
checkout, re-run the script, update the test's expected commit.
Do NOT hand-edit `vendor/` (except via the script); do NOT vendor
mid-implementation Relay work (root coordinates).

## Auth (real semantics, not the wire-doc cafe sketch)

- Magic link: `request` → emailed `token` (link GET never consumes) →
  `consume` (POST, explicit approve) → `finalize` needs the originating
  tab's `requestSecret` (sessionStorage, tab-scoped, memory fallback).
  The emailed token alone never mints a session; email alone never
  bypasses TOTP (code or recovery code required when enrolled).
- Same-browser-new-tab works with NO token copying: the new tab approves,
  the originating tab polls to approved and finishes there. Cross-device:
  approve on the phone, finish on the originator.
- Session lifecycle (Core truth): sign-in sets a persistent HttpOnly
  `ast_session` cookie (30 days). **Closing the tab does NOT sign out** —
  only explicit revoke does. The Sessions page says this verbatim.
- Recovery codes: alternate field on both finish forms, sent as
  `recoveryCode`. TOTP enrollment renders the QR **locally** (`qrcode`
  SVG data URI — the secret never goes to an external chart service) plus
  manual setup details parsed from the otpauth URL.
- Product errors are field-level and human (`Enter a valid email
  address.`), never Effect ParseError internals.

## Tunnel: chunks, streams, grants

Wire doc: `editor/docs/plans/ast-account-wire.md` + `tunnel.rs`
(strict requests, forward-compatible reads).

- Requests encode strictly via Effect Schema (unknown fields rejected
  client-side); responses decode leniently. Paths validated origin-form,
  no `..`. `$bytes` envelopes decoded for blobs/images.
- Chunking (§4): 40 KiB raw sends; receivers accept any sane part size and
  verify `total_bytes`; >32 MiB refused explicitly — never silently cut.
- Live updates (§6): SUBSCRIBE on a dedicated channel with its own Noise
  session + own grant; `$stream` start, `$event` envelopes with the `since`
  cursor, chunked oversized envelopes, Reset → re-subscribe from cursor
  (storm → polling fallback), end/error → polling fallback. Unary calls run
  concurrently on the main channel. UNSUBSCRIBE best-effort on stop.
- Flow control: sends go through `send_app` (exact pre-seal sizing via
  `sealed_frame_size`, throws-before-consume on a full window, seal +
  `send_acked`, ack-paced, mutex-serialized per channel, all waiting
  OUTSIDE the incoming handler so the ACK read loop drains). WouldBlock
  pauses for recipient acks and retries; any post-seal failure fails the
  channel closed → re-handshake, never resend/skip ciphertext.
- Grants: fresh ephemeral `cnf` per grant (memory only), ≤300 s TTL;
  the open thread re-establishes (new grant + channel + re-handshake +
  re-subscribe from cursor) before expiry while the Core session lives.
- Transcripts render the FULL contract text in defined order
  (`transcriptText` walks ItemKind/TextContent/Collection shapes; 20-part
  and multi-question coverage in tests). No 8-item/depth caps, no
  first-result shortcut. Over 2 MiB: explicit Show-rest (in-DOM) +
  download + stored-source fetch-page expansion — never a silent cut.

## Config bundles + skills

Manifests validate/publish against Core's published schemas, including
`SkillRef.bundle` (`{path, contentBase64: base64url, sha256: hex}`).
The folder picker builds bundles client-side: SKILL.md required,
secret/tool folders refused by name (listed, never silent), caps
(64 files / 256 KiB each / 512 KiB total raw, under Core's 1 MiB JSON
body ceiling), per-file SHA-256 via SubtleCrypto, strict re-validation
before publish. `source: "bundle"` default is provisional until
Core/Rust confirm the embedded-only source value.

## Needed wiring (final configuration)

1. **DONE (core/src/index.ts):** forward `CORE_SPA_APPROVE_PATH`
   through `stringVars` (confirm endpoint 302s to the SPA), and per-request
   `postgres()` clients (max 5, fetch_types false, prepare true) via the
   `prepareDb` adapter (`{ prepare: true, simple: false }` on every
   `unsafe()`; txRunner wraps the tx client the same way) closed via
   waitUntil — the global cache caused alternating query failures.
   Hyperdrive caching stays DISABLED (`--caching-disabled`; verified via
   `wrangler hyperdrive get`): authority reads (sessions/keys/vault/
   revocation) must never serve stale cached rows. Typecheck clean.
   `.env` (gitignored, dev-local): quoted
   `CORE_SPA_APPROVE_PATH="/#/approve"` (unquoted `#` gets truncated by
   env parsing — keep it quoted or move the `#` into code).
2. **DONE (core/src/http.ts):** portal shell CSP allowlists the exact Relay
   origin via `CORE_RELAY_ORIGIN` (single `https://host[:port]`, no
   wildcards/credentials; emitted as both `https:`+`wss:` forms, `http:`+
   `ws:` for loopback harnesses; unset/invalid fails closed to
   `connect-src 'self'`). `script-src 'self' 'wasm-unsafe-eval'` (NO bare
   `'unsafe-eval'`): the bundled sodium-javascript compiles WebAssembly at
   startup — without it Chromium throws CompileError and the SPA never
   renders. `img-src 'self' data: blob:` covers transcript image blob: URLs
   (revoked on replace/error/route disposal). Dev parity via
   `VITE_DEV_CSP_RELAY_ORIGIN` in `web/vite.config.ts` (same shape).
3. **DONE (relay/src/index.ts + src/cors.ts):** `RELAY_PORTAL_ORIGIN`
   (exact portal origin) gates cross-origin browser access. Presence/health
   answer CORS preflights and reflect the origin (`Access-Control-Allow-
   Origin` exact echo + `Vary: Origin`; allow-list `GET` + `Authorization`);
   disallowed origins get no ACAO (browser blocks). WS upgrades with a
   mismatched `Origin` are refused pre-upgrade (403); absent `Origin`
   (native clients, curl) proceeds to grant+PoP. No wildcards, no
   `Access-Control-Allow-Credentials` ever (Bearer grants, never cookies).
4. No new service endpoints were needed for any UI above.

## Deployment notes (portal)

- Build the bundle: `npm run build` in `core/web` → `web/dist/`
  (hashed assets + `index.html`; source maps included). Never commit
  secrets into it — the bundle carries no credentials by construction
  (session is an HttpOnly cookie, keys are per-connection ephemeral).
- Serve `web/dist` as the Worker's static assets (Emily's ASSETS binding;
  `wrangler.jsonc` `[assets]`). The SPA shell serves unknown app paths
  with no-store + strict CSP; API/UI/metadata paths never fall through.
- Set `CORE_SPA_APPROVE_PATH="/#/approve"` (QUOTED — an unquoted `#`
  is truncated by `.env`/wired-vars parsing and the 302 loses the SPA
  route, stranding email approvals on the fallback page). Production gets
  the value from Wrangler vars/secrets (no `#` issue there), dev gets it
  from quoted `.dev.vars`/`.env`.
- Keep `.env` / `.dev.vars` / real keys out of git (already ignored).
  The account used for smoke tests is dev-only.
