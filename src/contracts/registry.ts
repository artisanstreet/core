import { Schema } from "effect";
import * as C from "./v1.js";

// Route registry: every route declares its schemas here. The OpenAPI
// document and fixtures generate from these same objects, so the
// machine-readable contract cannot drift from the runtime.

export type AnySchema = Schema.Schema<unknown, unknown>;

export interface RouteDef {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly summary: string;
  readonly tags: string[];
  readonly auth: "none" | "session" | "machine" | "either" | "admin";
  readonly requestSchema?: Schema.Schema<unknown, unknown>;
  readonly responseSchema: Schema.Schema<unknown, unknown>;
}

export const ROUTES: RouteDef[] = [];
const reg = <R extends RouteDef>(r: R): R => {
  ROUTES.push(r);
  return r;
};

export const R = {
  version: reg({ method: "GET", path: "/v1/version", summary: "Protocol version", tags: ["meta"], auth: "none", responseSchema: C.VersionResp as unknown as AnySchema }),
  openapi: reg({ method: "GET", path: "/v1/openapi.json", summary: "Machine-readable contracts", tags: ["meta"], auth: "none", responseSchema: Schema.Unknown as unknown as AnySchema }),
  jwks: reg({ method: "GET", path: "/.well-known/jwks.json", summary: "Grant verification keys", tags: ["grants"], auth: "none", responseSchema: C.JwksResp as unknown as AnySchema }),
  revocations: reg({ method: "GET", path: "/v1/grants/revocations", summary: "Revocation list", tags: ["grants"], auth: "none", responseSchema: C.RevocationsResp as unknown as AnySchema }),
  magicRequest: reg({ method: "POST", path: "/v1/auth/magic/request", summary: "Request magic link", tags: ["auth"], auth: "none", requestSchema: C.MagicRequest as AnySchema, responseSchema: C.MagicRequestResp as unknown as AnySchema }),
  magicStatus: reg({ method: "POST", path: "/v1/auth/magic/status", summary: "Poll login request", tags: ["auth"], auth: "none", requestSchema: C.MagicStatusReq as AnySchema, responseSchema: C.MagicStatusResp as unknown as AnySchema }),
  magicConsume: reg({ method: "POST", path: "/v1/auth/magic/consume", summary: "Approve from email", tags: ["auth"], auth: "none", requestSchema: C.MagicConsumeReq as AnySchema, responseSchema: C.MagicConsumeResp as unknown as AnySchema }),
  magicFinalize: reg({ method: "POST", path: "/v1/auth/magic/finalize", summary: "Complete sign-in", tags: ["auth"], auth: "none", requestSchema: C.MagicFinalizeReq as AnySchema, responseSchema: C.MagicFinalizeResp as unknown as AnySchema }),
  totpEnroll: reg({ method: "POST", path: "/v1/auth/totp/enroll", summary: "Start TOTP enrollment", tags: ["auth"], auth: "session", responseSchema: C.TotpEnrollResp as unknown as AnySchema }),
  totpVerify: reg({ method: "POST", path: "/v1/auth/totp/verify", summary: "Confirm TOTP enrollment", tags: ["auth"], auth: "session", requestSchema: C.TotpVerifyReq as AnySchema, responseSchema: C.TotpVerifyResp as unknown as AnySchema }),
  totpDisable: reg({ method: "POST", path: "/v1/auth/totp/disable", summary: "Disable TOTP", tags: ["auth"], auth: "session", requestSchema: C.TotpDisableReq as AnySchema, responseSchema: C.TotpDisableResp as unknown as AnySchema }),
  me: reg({ method: "GET", path: "/v1/me", summary: "Account, machines, providers, config", tags: ["auth"], auth: "session", responseSchema: C.MeResp as unknown as AnySchema }),
  sessions: reg({ method: "GET", path: "/v1/sessions", summary: "List sessions", tags: ["auth"], auth: "session", responseSchema: C.SessionListResp as unknown as AnySchema }),
  logout: reg({ method: "POST", path: "/v1/sessions/current/revoke", summary: "Revoke current session", tags: ["auth"], auth: "session", responseSchema: Schema.Struct({ revoked: Schema.Boolean }) as unknown as AnySchema }),
  sessionsRevokeAll: reg({ method: "POST", path: "/v1/sessions/revoke-all", summary: "Revoke all sessions", tags: ["auth"], auth: "session", responseSchema: Schema.Struct({ revoked: Schema.Boolean }) as unknown as AnySchema }),
  enrollStart: reg({ method: "POST", path: "/v1/machines/enrollments", summary: "Start Forge enrollment", tags: ["machines"], auth: "none", requestSchema: C.EnrollmentStartReq as AnySchema, responseSchema: C.EnrollmentStartResp as unknown as AnySchema }),
  enrollClaim: reg({ method: "POST", path: "/v1/machines/enrollments/claim", summary: "Claim enrollment into account", tags: ["machines"], auth: "session", requestSchema: C.EnrollmentClaimReq as AnySchema, responseSchema: C.EnrollmentClaimResp as unknown as AnySchema }),
  enrollStatus: reg({ method: "GET", path: "/v1/machines/enrollments/:id/status", summary: "Poll enrollment (Forge proof)", tags: ["machines"], auth: "machine", responseSchema: C.EnrollmentStatusResp as unknown as AnySchema }),
  enrollConfirm: reg({ method: "POST", path: "/v1/machines/enrollments/confirm", summary: "Confirm enrollment (Forge proof)", tags: ["machines"], auth: "machine", requestSchema: C.EnrollmentConfirmReq as AnySchema, responseSchema: C.EnrollmentConfirmResp as unknown as AnySchema }),
  machineList: reg({ method: "GET", path: "/v1/machines", summary: "List account machines", tags: ["machines"], auth: "session", responseSchema: C.MachineListResp as unknown as AnySchema }),
  machineRevoke: reg({ method: "POST", path: "/v1/machines/:id/revoke", summary: "Revoke machine", tags: ["machines"], auth: "session", responseSchema: Schema.Struct({ revoked: Schema.Boolean }) as unknown as AnySchema }),
  grantIssue: reg({ method: "POST", path: "/v1/grants/issue", summary: "Issue grant (session: Editor; machine proof: Forge)", tags: ["grants"], auth: "either", requestSchema: C.GrantIssueReq as AnySchema, responseSchema: C.GrantIssueResp as unknown as AnySchema }),
  keyRotate: reg({ method: "POST", path: "/v1/admin/keys/rotate", summary: "Rotate grant signing key", tags: ["admin"], auth: "admin", responseSchema: Schema.Struct({ kid: Schema.String }) as unknown as AnySchema }),
  janitorRun: reg({ method: "POST", path: "/v1/admin/janitor", summary: "Run maintenance", tags: ["admin"], auth: "admin", responseSchema: Schema.Unknown as unknown as AnySchema }),
  providerCreate: reg({ method: "POST", path: "/v1/vault/connections", summary: "Store provider API key", tags: ["vault"], auth: "session", requestSchema: C.ProviderCreateReq as AnySchema, responseSchema: C.ProviderInfo as unknown as AnySchema }),
  providerList: reg({ method: "GET", path: "/v1/vault/connections", summary: "List connections (session: all; machine: own assigned)", tags: ["vault"], auth: "either", responseSchema: C.ProviderListResp as unknown as AnySchema }),
  providerRevoke: reg({ method: "POST", path: "/v1/vault/connections/:id/revoke", summary: "Revoke connection", tags: ["vault"], auth: "session", responseSchema: Schema.Struct({ revoked: Schema.Boolean }) as unknown as AnySchema }),
  providerAssign: reg({ method: "POST", path: "/v1/vault/assignments", summary: "Assign connection to machine", tags: ["vault"], auth: "session", requestSchema: C.AssignReq as AnySchema, responseSchema: C.AssignResp as unknown as AnySchema }),
  providerUnassign: reg({ method: "POST", path: "/v1/vault/assignments/remove", summary: "Remove assignment", tags: ["vault"], auth: "session", requestSchema: C.AssignReq as AnySchema, responseSchema: Schema.Struct({ unassigned: Schema.Boolean }) as unknown as AnySchema }),
  credentialRelease: reg({ method: "GET", path: "/v1/vault/credentials", summary: "Release credential (assigned machine)", tags: ["vault"], auth: "machine", responseSchema: C.CredentialResp as unknown as AnySchema }),
  artifactCreate: reg({ method: "POST", path: "/v1/engine-artifacts", summary: "Store engine credential artifact", tags: ["artifacts"], auth: "session", requestSchema: C.ArtifactCreateReq as AnySchema, responseSchema: Schema.Struct({ id: C.ArtifactId }) as unknown as AnySchema }),
  artifactList: reg({ method: "GET", path: "/v1/engine-artifacts", summary: "List artifacts (session: all; machine: own assigned)", tags: ["artifacts"], auth: "either", responseSchema: C.ArtifactListResp as unknown as AnySchema }),
  artifactRevoke: reg({ method: "POST", path: "/v1/engine-artifacts/:id/revoke", summary: "Revoke artifact", tags: ["artifacts"], auth: "session", responseSchema: Schema.Struct({ revoked: Schema.Boolean }) as unknown as AnySchema }),
  artifactAssign: reg({ method: "POST", path: "/v1/engine-artifacts/assignments", summary: "Assign artifact to machine", tags: ["artifacts"], auth: "session", requestSchema: C.ArtifactAssignReq as AnySchema, responseSchema: Schema.Struct({ artifactId: C.ArtifactId, machineId: C.MachineId }) as unknown as AnySchema }),
  artifactUnassign: reg({ method: "POST", path: "/v1/engine-artifacts/assignments/remove", summary: "Remove artifact assignment", tags: ["artifacts"], auth: "session", requestSchema: C.ArtifactAssignReq as AnySchema, responseSchema: Schema.Struct({ unassigned: Schema.Boolean }) as unknown as AnySchema }),
  artifactDownload: reg({ method: "GET", path: "/v1/engine-artifacts/:id/download", summary: "Download envelope (assigned machine)", tags: ["artifacts"], auth: "machine", responseSchema: C.ArtifactDownloadResp as unknown as AnySchema }),
  bundlePublish: reg({ method: "POST", path: "/v1/config/bundles", summary: "Publish config bundle", tags: ["config"], auth: "session", requestSchema: C.BundlePublishReq as AnySchema, responseSchema: C.BundleInfo as unknown as AnySchema }),
  bundleLatest: reg({ method: "GET", path: "/v1/config/bundles/latest", summary: "Latest bundle + manifest", tags: ["config"], auth: "either", responseSchema: C.BundleLatestResp as unknown as AnySchema }),
  bundleManifest: reg({ method: "GET", path: "/v1/config/bundles/:version/manifest", summary: "Manifest bytes from R2 (hash-verified)", tags: ["config"], auth: "machine", responseSchema: Schema.Unknown as unknown as AnySchema }),
  configReport: reg({ method: "POST", path: "/v1/config/state", summary: "Report applied revision (machine)", tags: ["config"], auth: "machine", requestSchema: C.ConfigStateReq as AnySchema, responseSchema: C.ConfigStateResp as unknown as AnySchema }),
  configRead: reg({ method: "GET", path: "/v1/config/state", summary: "Read machine state", tags: ["config"], auth: "session", responseSchema: C.ConfigStateResp as unknown as AnySchema }),
  activity: reg({ method: "GET", path: "/v1/activity", summary: "Recent activity", tags: ["account"], auth: "session", responseSchema: C.ActivityResp as unknown as AnySchema }),
  deletionRequest: reg({ method: "POST", path: "/v1/account/deletion/request", summary: "Request deletion", tags: ["account"], auth: "session", requestSchema: C.DeletionRequestReq as AnySchema, responseSchema: C.DeletionStatusResp as unknown as AnySchema }),
  deletionStatus: reg({ method: "GET", path: "/v1/account/deletion", summary: "Deletion status", tags: ["account"], auth: "session", responseSchema: C.DeletionStatusResp as unknown as AnySchema }),
  deletionCancel: reg({ method: "POST", path: "/v1/account/deletion/cancel", summary: "Cancel deletion", tags: ["account"], auth: "session", responseSchema: C.DeletionStatusResp as unknown as AnySchema }),
};
