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

// Product error formatting: validation failures become concise,
// field-level human messages — never Effect Schema internals. ParseError
// trees stay in debug logs, not on screen.

import { Schema } from "effect";
import { ArrayFormatter, isParseError } from "effect/ParseResult";
import * as C from "../../src/contracts/v1.ts";

export const strictOptions = { onExcessProperty: "error" } as const;

/** Encode a request body strictly; throws on unknown fields. */
export function encodeStrict<A, I>(schema: Schema.Schema<A, I>, value: A): I {
  return Schema.encodeUnknownSync(schema, strictOptions)(value) as I;
}

/** Decode a response forward-compatibly (unknown fields ignored). */
export function decodeLenient<A, I>(schema: Schema.Schema<A, I>, input: unknown): A {
  return Schema.decodeUnknownSync(schema)(input);
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
  if (isParseError(error)) {
    try {
      const issues = ArrayFormatter.formatErrorSync(error) as Array<{ path: ReadonlyArray<PropertyKey>; message: string }>;
      const first = issues[0];
      if (first) {
        const field = String(first.path[first.path.length - 1] ?? "");
        const label = FIELD_LABELS[field] ?? (field ? field : null);
        if (/email/i.test(field)) return "Enter a valid email address.";
        if (/message/i.test(first.message) && /missing/i.test(first.message)) {
          return label ? `Enter ${article(label)} ${label.toLowerCase()}.` : "A required field is missing.";
        }
        if (label) return `${label}: ${shorten(first.message)}`;
        return shorten(first.message);
      }
    } catch {
      // fall through to generic
    }
  }
  return "Some fields need attention before sending.";
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function shorten(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 140) return oneLine.endsWith(".") ? oneLine : `${oneLine}.`;
  return "That value is not valid here.";
}

export interface ApiErrorShape {
  code: string;
  message: string;
  requestId: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string;
  constructor(status: number, body: ApiErrorShape) {
    // The message comes from the server and is already secret-free by
    // contract (messages never carry secrets, tokens, or hashes).
    super(body.message || body.code);
    this.name = "ApiError";
    this.code = body.code;
    this.status = status;
    this.requestId = body.requestId;
  }
}

export type FetchLike = typeof fetch;

export interface ApiOptions {
  fetchImpl?: FetchLike;
}

function errorShape(input: unknown): ApiErrorShape {
  if (typeof input === "object" && input !== null && "error" in input) {
    const e = (input as { error: Record<string, unknown> }).error;
    if (typeof e?.code === "string" && typeof e?.message === "string") {
      return { code: e.code, message: e.message, requestId: typeof e?.requestId === "string" ? e.requestId : "" };
    }
  }
  return { code: "bad_response", message: "Unexpected response from the account service.", requestId: "" };
}

/**
 * Minimal Core client. `base` is "" for same-origin (production + dev
 * proxy). A fully-qualified override is allowed only for local fixture
 * servers used in tests; cookie sessions still require same-origin.
 */
export class CoreApi {
  private readonly fetchImpl: FetchLike;
  readonly base: string;

  constructor(base = "", opts: ApiOptions = {}) {
    this.base = base;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  async get<A, I>(path: string, responseSchema: Schema.Schema<A, I>): Promise<A> {
    const res = await this.fetchImpl(this.base + path, {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    return this.read(res, responseSchema);
  }

  async post<A, I, RA, RI>(
    path: string,
    requestSchema: Schema.Schema<RA, RI> | null,
    requestBody: RA | null,
    responseSchema: Schema.Schema<A, I>,
  ): Promise<A> {
    let encoded = "{}";
    if (requestSchema && requestBody !== null) {
      try {
        encoded = JSON.stringify(encodeStrict(requestSchema, requestBody));
      } catch (error) {
        // Client-side strict validation failed: never send a malformed
        // request, and show a concise field-level message instead of
        // schema internals.
        throw new ApiError(400, { code: "bad_request", message: humanizeValidationError(error), requestId: "" });
      }
    }
    const res = await this.fetchImpl(this.base + path, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: encoded,
    });
    return this.read(res, responseSchema);
  }

  private async read<A, I>(res: Response, responseSchema: Schema.Schema<A, I>): Promise<A> {    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      throw new ApiError(res.status, { code: "bad_response", message: `Account service answered ${res.status}.`, requestId: "" });
    }
    if (!res.ok) throw new ApiError(res.status, errorShape(json));
    try {
      return decodeLenient(responseSchema, json);
    } catch {
      throw new ApiError(res.status, { code: "bad_response", message: "Account service answered with an unreadable shape.", requestId: "" });
    }
  }

  // -- auth ---------------------------------------------------------------

  requestMagicLink(email: string, displayName?: string, deviceName?: string) {
    return this.post("/v1/auth/magic/request", C.MagicRequest, { email, displayName, deviceName }, C.MagicRequestResp);
  }

  loginStatus(requestId: string, requestSecret: string) {
    return this.post("/v1/auth/magic/status", C.MagicStatusReq, { requestId, requestSecret }, C.MagicStatusResp);
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
    return this.post("/v1/grants/issue", C.GrantIssueReq, body, C.GrantIssueResp);
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
