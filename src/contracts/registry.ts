import { Schema } from "effect";
import * as C from "./v1.ts";

// Route registry: every route declares its schemas here. The OpenAPI
// document, fixtures, and HTTP composition all derive from these SAME
// objects (method + path + schemas), so the machine-readable contract
// cannot drift from the runtime.

export type AnySchema = Schema.Schema<any, any, never>;

export interface RouteDef {
  readonly method: "GET" | "POST";
  readonly path: `/${string}`;
  readonly summary: string;
  readonly tags: string[];
  readonly auth: "none" | "session" | "machine" | "either" | "admin";
  readonly requestSchema?: AnySchema;
  readonly responseSchema: AnySchema;
}

export const ROUTES: RouteDef[] = [];
const reg = <R extends RouteDef>(r: R): R => {
  ROUTES.push(r);
  return r;
};

export const R = {
  version: reg({ method: "GET", path: "/v1/version", summary: "Protocol version", tags: ["meta"], auth: "none", responseSchema: C.VersionResp }),
  openapi: reg({ method: "GET", path: "/v1/openapi.json", summary: "Machine-readable contracts", tags: ["meta"], auth: "none", responseSchema: Schema.Unknown }),
  jwks: reg({ method: "GET", path: "/.well-known/jwks.json", summary: "Grant verification keys", tags: ["grants"], auth: "none", responseSchema: C.JwksResp }),
  revocations: reg({ method: "GET", path: "/v1/grants/revocations", summary: "Revocation list", tags: ["grants"], auth: "none", responseSchema: C.RevocationsResp }),
  magicRequest: reg({ method: "POST", path: "/v1/auth/magic/request", summary: "Request magic link", tags: ["auth"], auth: "none", requestSchema: C.MagicRequest, responseSchema: C.MagicRequestResp }),
  magicStatus: reg({ method: "POST", path: "/v1/auth/magic/status", summary: "Poll login request", tags: ["auth"], auth: "none", requestSchema: C.MagicStatusReq, responseSchema: C.MagicStatusResp }),
  magicConsume: reg({ method: "POST", path: "/v1/auth/magic/consume", summary: "Approve from email", tags: ["auth"], auth: "none", requestSchema: C.MagicConsumeReq, responseSchema: C.MagicConsumeResp }),
  magicFinalize: reg({ method: "POST", path: "/v1/auth/magic/finalize", summary: "Complete sign-in", tags: ["auth"], auth: "none", requestSchema: C.MagicFinalizeReq, responseSchema: C.MagicFinalizeResp }),
  totpEnroll: reg({ method: "POST", path: "/v1/auth/totp/enroll", summary: "Start TOTP enrollment", tags: ["auth"], auth: "session", responseSchema: C.TotpEnrollResp }),
  totpVerify: reg({ method: "POST", path: "/v1/auth/totp/verify", summary: "Confirm TOTP enrollment", tags: ["auth"], auth: "session", requestSchema: C.TotpVerifyReq, responseSchema: C.TotpVerifyResp }),
  totpDisable: reg({ method: "POST", path: "/v1/auth/totp/disable", summary: "Disable TOTP", tags: ["auth"], auth: "session", requestSchema: C.TotpDisableReq, responseSchema: C.TotpDisableResp }),
  me: reg({ method: "GET", path: "/v1/me", summary: "Account, machines, providers, config", tags: ["auth"], auth: "session", responseSchema: C.MeResp }),
  sessions: reg({ method: "GET", path: "/v1/sessions", summary: "List sessions", tags: ["auth"], auth: "session", responseSchema: C.SessionListResp }),
  logout: reg({ method: "POST", path: "/v1/sessions/current/revoke", summary: "Revoke current session", tags: ["auth"], auth: "session", responseSchema: Schema.Struct({ revoked: Schema.Boolean }) }),
  sessionsRevokeAll: reg({ method: "POST", path: "/v1/sessions/revoke-all", summary: "Revoke all sessions", tags: ["auth"], auth: "session", responseSchema: Schema.Struct({ revoked: Schema.Boolean }) }),
  enrollStart: reg({ method: "POST", path: "/v1/machines/enrollments", summary: "Start Forge enrollment", tags: ["machines"], auth: "none", requestSchema: C.EnrollmentStartReq, responseSchema: C.EnrollmentStartResp }),
  enrollClaim: reg({ method: "POST", path: "/v1/machines/enrollments/claim", summary: "Claim enrollment into account", tags: ["machines"], auth: "session", requestSchema: C.EnrollmentClaimReq, responseSchema: C.EnrollmentClaimResp }),
  enrollStatus: reg({ method: "GET", path: "/v1/machines/enrollments/:id/status", summary: "Poll enrollment (Forge proof)", tags: ["machines"], auth: "machine", responseSchema: C.EnrollmentStatusResp }),
  enrollConfirm: reg({ method: "POST", path: "/v1/machines/enrollments/confirm", summary: "Confirm enrollment (Forge proof)", tags: ["machines"], auth: "machine", requestSchema: C.EnrollmentConfirmReq, responseSchema: C.EnrollmentConfirmResp }),
  machineList: reg({ method: "GET", path: "/v1/machines", summary: "List account machines", tags: ["machines"], auth: "session", responseSchema: C.MachineListResp }),
  machineRevoke: reg({ method: "POST", path: "/v1/machines/:id/revoke", summary: "Revoke machine", tags: ["machines"], auth: "session", responseSchema: Schema.Struct({ revoked: Schema.Boolean }) }),
  grantIssue: reg({ method: "POST", path: "/v1/grants/issue", summary: "Issue grant (session: Editor; machine proof: Forge)", tags: ["grants"], auth: "either", requestSchema: C.GrantIssueReq, responseSchema: C.GrantIssueResp }),
  keyRotate: reg({ method: "POST", path: "/v1/admin/keys/rotate", summary: "Rotate grant signing key", tags: ["admin"], auth: "admin", responseSchema: Schema.Struct({ kid: Schema.String }) }),
  janitorRun: reg({ method: "POST", path: "/v1/admin/janitor", summary: "Run maintenance", tags: ["admin"], auth: "admin", responseSchema: Schema.Unknown }),
  providerCreate: reg({ method: "POST", path: "/v1/vault/connections", summary: "Store provider API key", tags: ["vault"], auth: "session", requestSchema: C.ProviderCreateReq, responseSchema: C.ProviderInfo }),
  providerList: reg({ method: "GET", path: "/v1/vault/connections", summary: "List connections (session: all; machine: own assigned)", tags: ["vault"], auth: "either", responseSchema: C.ProviderListResp }),
  providerRevoke: reg({ method: "POST", path: "/v1/vault/connections/:id/revoke", summary: "Revoke connection", tags: ["vault"], auth: "session", responseSchema: Schema.Struct({ revoked: Schema.Boolean }) }),
  providerAssign: reg({ method: "POST", path: "/v1/vault/assignments", summary: "Assign connection to machine", tags: ["vault"], auth: "session", requestSchema: C.AssignReq, responseSchema: C.AssignResp }),
  providerUnassign: reg({ method: "POST", path: "/v1/vault/assignments/remove", summary: "Remove assignment", tags: ["vault"], auth: "session", requestSchema: C.AssignReq, responseSchema: Schema.Struct({ unassigned: Schema.Boolean }) }),
  credentialRelease: reg({ method: "GET", path: "/v1/vault/credentials", summary: "Release credential (assigned machine)", tags: ["vault"], auth: "machine", responseSchema: C.CredentialResp }),
  artifactCreate: reg({ method: "POST", path: "/v1/engine-artifacts", summary: "Store engine credential artifact", tags: ["artifacts"], auth: "session", requestSchema: C.ArtifactCreateReq, responseSchema: Schema.Struct({ id: C.ArtifactId }) }),
  artifactList: reg({ method: "GET", path: "/v1/engine-artifacts", summary: "List artifacts (session: all; machine: own assigned)", tags: ["artifacts"], auth: "either", responseSchema: C.ArtifactListResp }),
  artifactRevoke: reg({ method: "POST", path: "/v1/engine-artifacts/:id/revoke", summary: "Revoke artifact", tags: ["artifacts"], auth: "session", responseSchema: Schema.Struct({ revoked: Schema.Boolean }) }),
  artifactAssign: reg({ method: "POST", path: "/v1/engine-artifacts/assignments", summary: "Assign artifact to machine", tags: ["artifacts"], auth: "session", requestSchema: C.ArtifactAssignReq, responseSchema: Schema.Struct({ artifactId: C.ArtifactId, machineId: C.MachineId }) }),
  artifactUnassign: reg({ method: "POST", path: "/v1/engine-artifacts/assignments/remove", summary: "Remove artifact assignment", tags: ["artifacts"], auth: "session", requestSchema: C.ArtifactAssignReq, responseSchema: Schema.Struct({ unassigned: Schema.Boolean }) }),
  artifactDownload: reg({ method: "GET", path: "/v1/engine-artifacts/:id/download", summary: "Download envelope (assigned machine)", tags: ["artifacts"], auth: "machine", responseSchema: C.ArtifactDownloadResp }),
  bundlePublish: reg({ method: "POST", path: "/v1/config/bundles", summary: "Publish config bundle", tags: ["config"], auth: "session", requestSchema: C.BundlePublishReq, responseSchema: C.BundleInfo }),
  bundleLatest: reg({ method: "GET", path: "/v1/config/bundles/latest", summary: "Latest bundle + manifest", tags: ["config"], auth: "either", responseSchema: C.BundleLatestResp }),
  bundleManifest: reg({ method: "GET", path: "/v1/config/bundles/:version/manifest", summary: "Manifest bytes from R2 (hash-verified)", tags: ["config"], auth: "machine", responseSchema: Schema.Unknown }),
  configReport: reg({ method: "POST", path: "/v1/config/state", summary: "Report applied revision (machine)", tags: ["config"], auth: "machine", requestSchema: C.ConfigStateReq, responseSchema: C.ConfigStateResp }),
  configRead: reg({ method: "GET", path: "/v1/config/state", summary: "Read machine state", tags: ["config"], auth: "session", responseSchema: C.ConfigStateResp }),
  activity: reg({ method: "GET", path: "/v1/activity", summary: "Recent activity", tags: ["account"], auth: "session", responseSchema: C.ActivityResp }),
  deletionRequest: reg({ method: "POST", path: "/v1/account/deletion/request", summary: "Request deletion", tags: ["account"], auth: "session", requestSchema: C.DeletionRequestReq, responseSchema: C.DeletionStatusResp }),
  deletionStatus: reg({ method: "GET", path: "/v1/account/deletion", summary: "Deletion status", tags: ["account"], auth: "session", responseSchema: C.DeletionStatusResp }),
  deletionCancel: reg({ method: "POST", path: "/v1/account/deletion/cancel", summary: "Cancel deletion", tags: ["account"], auth: "session", responseSchema: C.DeletionStatusResp }),
};
