// Core v1 HTTP client for the browser UI.
//
// Contract source: core/src/contracts/v1.ts (Effect Schema is
// authoritative). Rules honored here:
// - Requests are encoded STRICT: unknown fields are rejected client-side
//   before anything is sent (matches the server's strict reads).
// - Responses are read forward-compatibly: unknown fields are ignored, so
//   additive v1 fields never break this UI.
// - Session auth is the HttpOnly `ast_session` cookie (never readable from
//   JS); fetch uses same-origin `credentials: "include"`. Mutations rely on
//   the server's same-origin Origin check for cookie calls.
// - Ownership is server-derived: this client never sends accountId to
//   claim scope, and never puts tokens in URLs or logs.
//
// Effect lies underneath (`./core/api-effect.ts`): `get`/`post` run an
// Effect (`api_get`/`api_post` with typed `ApiFailure`/`TransportFailure`/
// `DecodeFailure` + `Schedule` retry on idempotent GETs) and collapse to a
// Promise ONLY here — the single `Effect.runPromise` boundary for pages.
// Product error formatting stays concise and field-level.

import { Either, Schema } from "effect";
import { ArrayFormatter, isParseError } from "effect/ParseResult";
import * as C from "../../src/contracts/v1.ts";
import { ApiError, ApiFailure } from "./core/api-error.ts";
import { run_promise } from "./core/run-promise.ts";
import { api_get, api_post, decode_lenient as decode_lenient_eff, encode_strict as encode_strict_eff, issue_grant_effect, login_status_effect, strict_options, type FetchLike, type HttpSeam } from "./core/api-effect.ts";

export { ApiError };
export type { FetchLike, HttpSeam } from "./core/api-effect.ts";
export type { ApiErrorShape } from "./core/api-error.ts";

export const strictOptions = strict_options;

/** Encode a request body strictly; throws on unknown fields. */
export function encodeStrict<A, I>(schema: Schema.Schema<A, I>, value: A): I {
  return encode_strict_eff(schema, value);
}

/** Decode a response forward-compatibly (unknown fields ignored). */
export function decodeLenient<A, I>(schema: Schema.Schema<A, I>, input: unknown): A {
  return decode_lenient_eff(schema, input);
}

/** Decode a request-shaped value strictly (used in tests + validation). */
export function decodeStrict<A, I>(schema: Schema.Schema<A, I>, input: unknown): A {
  return Schema.decodeUnknownSync(schema, strictOptions)(input);
}

/** Field labels for the forms that submit contract requests. */
const FIELD_LABELS: Record<string, string> = {
  email: "Email",
  code: "Code",
  totpCode: "Authenticator code",
  recoveryCode: "Recovery code",
  requestSecret: "Request secret",
  requestId: "Sign-in request",
  token: "Link token",
  label: "Label",
  apiKey: "API key",
  provider: "Provider",
  connectionId: "Connection",
  machineId: "Forge",
  deviceName: "Device name",
  displayName: "Name",
};

/**
 * Turn a strict-encode ParseError into one concise sentence naming the
 * first bad field (e.g. "Enter a valid email address."). Falls back to a
 * generic prompt when the tree carries nothing mappable.
 */
export function humanizeValidationError(error: unknown): string {
  if (!isParseError(error)) return "Some fields need attention before sending.";
  const issues = Either.getOrNull(
    Either.try({
      try: () => ArrayFormatter.formatErrorSync(error) as Array<{ path: ReadonlyArray<PropertyKey>; message: string }>,
      catch: () => null,
    }),
  );
  const first = issues?.[0];
  if (!first) return "Some fields need attention before sending.";
  const field = String(first.path[first.path.length - 1] ?? "");
  const label = FIELD_LABELS[field] ?? (field ? field : null);
  if (/email/i.test(field)) return "Enter a valid email address.";
  if (/message/i.test(first.message) && /missing/i.test(first.message)) {
    return label ? `Enter ${article(label)} ${label.toLowerCase()}.` : "A required field is missing.";
  }
  if (label) return `${label}: ${shorten(first.message)}`;
  return shorten(first.message);
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function shorten(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 140) return oneLine.endsWith(".") ? oneLine : `${oneLine}.`;
  return "That value is not valid here.";
}

export interface ApiOptions {
  fetchImpl?: typeof fetch;
}

/**
 * Minimal Core client. `base` is "" for same-origin (production + dev
 * proxy). A fully-qualified override is allowed only for local fixture
 * servers used in tests; cookie sessions still require same-origin.
 *
 * Promise methods ONLY — pages call these. Internals run Effect.
 */
export class CoreApi implements HttpSeam {
  readonly fetch_impl: FetchLike;
  readonly base: string;

  constructor(base = "", opts: ApiOptions = {}) {
    this.base = base;
    this.fetch_impl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  async get<A, I>(path: string, responseSchema: Schema.Schema<A, I>): Promise<A> {
    return run_promise(api_get(this.fetch_impl, this.base, path, responseSchema));
  }

  async post<A, I, RA, RI>(
    path: string,
    requestSchema: Schema.Schema<RA, RI> | null,
    requestBody: RA | null,
    responseSchema: Schema.Schema<A, I>,
  ): Promise<A> {
    return run_promise(
      api_post(
        this.fetch_impl,
        this.base,
        path,
        requestSchema,
        requestBody,
        responseSchema,
        (encode_err) =>
          new ApiFailure({
            status: 400,
            code: "bad_request",
            message: humanizeValidationError(encode_err),
            request_id: "",
          }),
      ),
    );
  }

  // -- auth ---------------------------------------------------------------

  requestMagicLink(email: string, displayName?: string, deviceName?: string) {
    return this.post("/v1/auth/magic/request", C.MagicRequest, { email, displayName, deviceName }, C.MagicRequestResp);
  }

  loginStatus(requestId: string, requestSecret: string) {
    return run_promise(login_status_effect(this.fetch_impl, this.base, requestId, requestSecret));
  }

  /** Approve an emailed link. Always POST: link GETs never consume. */
  consumeMagicLink(token: string, requestSecret?: string) {
    return this.post("/v1/auth/magic/consume", C.MagicConsumeReq, { token, requestSecret }, C.MagicConsumeResp);
  }

  /**
   * Complete sign-in. Requires the requestSecret held by the originating
   * browser: the emailed token alone can never mint a session. Callers must
   * refuse to call without a secret (enforced here, not just in the UI).
   */
  finalizeMagicLink(requestId: string, requestSecret: string | null, secondFactor?: { totpCode?: string; recoveryCode?: string }) {
    if (!requestSecret) throw new Error("finalize requires the originating browser's request secret");
    return this.post(
      "/v1/auth/magic/finalize",
      C.MagicFinalizeReq,
      { requestId, requestSecret, ...secondFactor },
      C.MagicFinalizeResp,
    );
  }

  enrollTotp() {
    return this.post("/v1/auth/totp/enroll", null, null, C.TotpEnrollResp);
  }

  verifyTotp(code: string) {
    return this.post("/v1/auth/totp/verify", C.TotpVerifyReq, { code }, C.TotpVerifyResp);
  }

  disableTotp(code: string) {
    return this.post("/v1/auth/totp/disable", C.TotpDisableReq, { code }, C.TotpDisableResp);
  }

  me() {
    return this.get("/v1/me", C.MeResp);
  }

  sessions() {
    return this.get("/v1/sessions", C.SessionListResp);
  }

  revokeCurrentSession() {
    return this.post("/v1/sessions/current/revoke", null, null, Schema.Struct({ revoked: Schema.Boolean }));
  }

  revokeAllSessions() {
    return this.post("/v1/sessions/revoke-all", null, null, Schema.Struct({ revoked: Schema.Boolean }));
  }

  // -- machines ------------------------------------------------------------

  claimEnrollment(code: string) {
    return this.post("/v1/machines/enrollments/claim", C.EnrollmentClaimReq, { code }, C.EnrollmentClaimResp);
  }

  machines() {
    return this.get("/v1/machines", C.MachineListResp);
  }

  revokeMachine(id: string) {
    return this.post(`/v1/machines/${encodeURIComponent(id)}/revoke`, null, null, Schema.Struct({ revoked: Schema.Boolean }));
  }

  // -- grants ----------------------------------------------------------------

  issueGrant(body: typeof C.GrantIssueReq.Type) {
    return run_promise(issue_grant_effect(this.fetch_impl, this.base, body));
  }

  // -- vault ------------------------------------------------------------------

  providerConnections() {
    return this.get("/v1/vault/connections", C.ProviderListResp);
  }

  createProviderConnection(provider: typeof C.ProviderKind.Type, label: string, apiKey: string) {
    return this.post("/v1/vault/connections", C.ProviderCreateReq, { provider, label, apiKey }, C.ProviderInfo);
  }

  revokeProviderConnection(id: string) {
    return this.post(`/v1/vault/connections/${encodeURIComponent(id)}/revoke`, null, null, Schema.Struct({ revoked: Schema.Boolean }));
  }

  assignConnection(connectionId: string, machineId: string) {
    return this.post("/v1/vault/assignments", C.AssignReq, { connectionId, machineId }, C.AssignResp);
  }

  unassignConnection(connectionId: string, machineId: string) {
    return this.post("/v1/vault/assignments/remove", C.AssignReq, { connectionId, machineId }, Schema.Struct({ unassigned: Schema.Boolean }));
  }

  // -- engine artifacts ----------------------------------------------------------

  artifacts() {
    return this.get("/v1/engine-artifacts", C.ArtifactListResp);
  }

  revokeArtifact(id: string) {
    return this.post(`/v1/engine-artifacts/${encodeURIComponent(id)}/revoke`, null, null, Schema.Struct({ revoked: Schema.Boolean }));
  }

  assignArtifact(artifactId: string, machineId: string) {
    return this.post(
      "/v1/engine-artifacts/assignments",
      C.ArtifactAssignReq,
      { artifactId, machineId },
      Schema.Struct({ artifactId: C.ArtifactId, machineId: C.MachineId }),
    );
  }

  unassignArtifact(artifactId: string, machineId: string) {
    return this.post(
      "/v1/engine-artifacts/assignments/remove",
      C.ArtifactAssignReq,
      { artifactId, machineId },
      Schema.Struct({ unassigned: Schema.Boolean }),
    );
  }

  // -- editor config ----------------------------------------------------------------

  publishBundle(manifest: typeof C.EditorManifest.Type) {
    return this.post("/v1/config/bundles", C.BundlePublishReq, { manifest }, C.BundleInfo);
  }

  latestBundle() {
    return this.get("/v1/config/bundles/latest", C.BundleLatestResp);
  }

  configState(machineId: string) {
    return this.get(`/v1/config/state?machineId=${encodeURIComponent(machineId)}`, C.ConfigStateResp);
  }

  // -- activity + deletion --------------------------------------------------------------

  activity(limit = 50) {
    return this.get(`/v1/activity?limit=${encodeURIComponent(String(limit))}`, C.ActivityResp);
  }

  requestDeletion(totpCode?: string) {
    return this.post("/v1/account/deletion/request", C.DeletionRequestReq, { totpCode }, C.DeletionStatusResp);
  }

  deletionStatus() {
    return this.get("/v1/account/deletion", C.DeletionStatusResp);
  }

  cancelDeletion() {
    return this.post("/v1/account/deletion/cancel", null, null, C.DeletionStatusResp);
  }

  version() {
    return this.get("/v1/version", C.VersionResp);
  }
}
