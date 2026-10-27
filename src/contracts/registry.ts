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
  readonly request_schema?: AnySchema;
  readonly response_schema: AnySchema;
}

export const ROUTES: RouteDef[] = [];
const reg = <R extends RouteDef>(r: R): R => {
  ROUTES.push(r);
  return r;
};

export const R = {
  version: reg({ method: "GET", path: "/v1/version", summary: "Protocol version", tags: ["meta"], auth: "none", response_schema: C.VersionResp }),
  openapi: reg({ method: "GET", path: "/v1/openapi.json", summary: "Machine-readable contracts", tags: ["meta"], auth: "none", response_schema: Schema.Unknown }),
  jwks: reg({ method: "GET", path: "/.well-known/jwks.json", summary: "Grant verification keys", tags: ["grants"], auth: "none", response_schema: C.JwksResp }),
  revocations: reg({ method: "GET", path: "/v1/grants/revocations", summary: "Revocation list", tags: ["grants"], auth: "none", response_schema: C.RevocationsResp }),
  magic_request: reg({ method: "POST", path: "/v1/auth/magic/request", summary: "Request magic link", tags: ["auth"], auth: "none", request_schema: C.MagicRequest, response_schema: C.MagicRequestResp }),
  magic_status: reg({ method: "POST", path: "/v1/auth/magic/status", summary: "Poll login request", tags: ["auth"], auth: "none", request_schema: C.MagicStatusReq, response_schema: C.MagicStatusResp }),
  magic_consume: reg({ method: "POST", path: "/v1/auth/magic/consume", summary: "Approve from email", tags: ["auth"], auth: "none", request_schema: C.MagicConsumeReq, response_schema: C.MagicConsumeResp }),
  magic_finalize: reg({ method: "POST", path: "/v1/auth/magic/finalize", summary: "Complete sign-in", tags: ["auth"], auth: "none", request_schema: C.MagicFinalizeReq, response_schema: C.MagicFinalizeResp }),
  totp_enroll: reg({ method: "POST", path: "/v1/auth/totp/enroll", summary: "Start TOTP enrollment", tags: ["auth"], auth: "session", response_schema: C.TotpEnrollResp }),
  totp_verify: reg({ method: "POST", path: "/v1/auth/totp/verify", summary: "Confirm TOTP enrollment", tags: ["auth"], auth: "session", request_schema: C.TotpVerifyReq, response_schema: C.TotpVerifyResp }),
  totp_disable: reg({ method: "POST", path: "/v1/auth/totp/disable", summary: "Disable TOTP", tags: ["auth"], auth: "session", request_schema: C.TotpDisableReq, response_schema: C.TotpDisableResp }),
  me: reg({ method: "GET", path: "/v1/me", summary: "Account, machines, providers, config", tags: ["auth"], auth: "session", response_schema: C.MeResp }),
  sessions: reg({ method: "GET", path: "/v1/sessions", summary: "List sessions", tags: ["auth"], auth: "session", response_schema: C.SessionListResp }),
  logout: reg({ method: "POST", path: "/v1/sessions/current/revoke", summary: "Revoke current session", tags: ["auth"], auth: "session", response_schema: Schema.Struct({ revoked: Schema.Boolean }) }),
  sessions_revoke_all: reg({ method: "POST", path: "/v1/sessions/revoke-all", summary: "Revoke all sessions", tags: ["auth"], auth: "session", response_schema: Schema.Struct({ revoked: Schema.Boolean }) }),
  enroll_start: reg({ method: "POST", path: "/v1/machines/enrollments", summary: "Start Forge enrollment", tags: ["machines"], auth: "none", request_schema: C.EnrollmentStartReq, response_schema: C.EnrollmentStartResp }),
  enroll_claim: reg({ method: "POST", path: "/v1/machines/enrollments/claim", summary: "Claim enrollment into account", tags: ["machines"], auth: "session", request_schema: C.EnrollmentClaimReq, response_schema: C.EnrollmentClaimResp }),
  enroll_status: reg({ method: "GET", path: "/v1/machines/enrollments/:id/status", summary: "Poll enrollment (Forge proof)", tags: ["machines"], auth: "machine", response_schema: C.EnrollmentStatusResp }),
  enroll_confirm: reg({ method: "POST", path: "/v1/machines/enrollments/confirm", summary: "Confirm enrollment (Forge proof)", tags: ["machines"], auth: "machine", request_schema: C.EnrollmentConfirmReq, response_schema: C.EnrollmentConfirmResp }),
  machine_list: reg({ method: "GET", path: "/v1/machines", summary: "List account machines", tags: ["machines"], auth: "session", response_schema: C.MachineListResp }),
  machine_revoke: reg({ method: "POST", path: "/v1/machines/:id/revoke", summary: "Revoke machine", tags: ["machines"], auth: "session", response_schema: Schema.Struct({ revoked: Schema.Boolean }) }),
  grant_issue: reg({ method: "POST", path: "/v1/grants/issue", summary: "Issue grant (session: Editor; machine proof: Forge)", tags: ["grants"], auth: "either", request_schema: C.GrantIssueReq, response_schema: C.GrantIssueResp }),
  key_rotate: reg({ method: "POST", path: "/v1/admin/keys/rotate", summary: "Rotate grant signing key", tags: ["admin"], auth: "admin", response_schema: Schema.Struct({ kid: Schema.String }) }),
  janitor_run: reg({ method: "POST", path: "/v1/admin/janitor", summary: "Run maintenance", tags: ["admin"], auth: "admin", response_schema: Schema.Unknown }),
  provider_create: reg({ method: "POST", path: "/v1/vault/connections", summary: "Store provider API key", tags: ["vault"], auth: "session", request_schema: C.ProviderCreateReq, response_schema: C.ProviderInfo }),
  provider_list: reg({ method: "GET", path: "/v1/vault/connections", summary: "List connections (session: all; machine: own assigned)", tags: ["vault"], auth: "either", response_schema: C.ProviderListResp }),
  provider_revoke: reg({ method: "POST", path: "/v1/vault/connections/:id/revoke", summary: "Revoke connection", tags: ["vault"], auth: "session", response_schema: Schema.Struct({ revoked: Schema.Boolean }) }),
  provider_assign: reg({ method: "POST", path: "/v1/vault/assignments", summary: "Assign connection to machine", tags: ["vault"], auth: "session", request_schema: C.AssignReq, response_schema: C.AssignResp }),
  provider_unassign: reg({ method: "POST", path: "/v1/vault/assignments/remove", summary: "Remove assignment", tags: ["vault"], auth: "session", request_schema: C.AssignReq, response_schema: Schema.Struct({ unassigned: Schema.Boolean }) }),
  credential_release: reg({ method: "GET", path: "/v1/vault/credentials", summary: "Release credential (assigned machine)", tags: ["vault"], auth: "machine", response_schema: C.CredentialResp }),
  artifact_create: reg({ method: "POST", path: "/v1/engine-artifacts", summary: "Store engine credential artifact", tags: ["artifacts"], auth: "session", request_schema: C.ArtifactCreateReq, response_schema: Schema.Struct({ id: C.ArtifactId }) }),
  artifact_list: reg({ method: "GET", path: "/v1/engine-artifacts", summary: "List artifacts (session: all; machine: own assigned)", tags: ["artifacts"], auth: "either", response_schema: C.ArtifactListResp }),
  artifact_revoke: reg({ method: "POST", path: "/v1/engine-artifacts/:id/revoke", summary: "Revoke artifact", tags: ["artifacts"], auth: "session", response_schema: Schema.Struct({ revoked: Schema.Boolean }) }),
  artifact_assign: reg({ method: "POST", path: "/v1/engine-artifacts/assignments", summary: "Assign artifact to machine", tags: ["artifacts"], auth: "session", request_schema: C.ArtifactAssignReq, response_schema: Schema.Struct({ artifactId: C.ArtifactId, machineId: C.MachineId }) }),
  artifact_unassign: reg({ method: "POST", path: "/v1/engine-artifacts/assignments/remove", summary: "Remove artifact assignment", tags: ["artifacts"], auth: "session", request_schema: C.ArtifactAssignReq, response_schema: Schema.Struct({ unassigned: Schema.Boolean }) }),
  artifact_download: reg({ method: "GET", path: "/v1/engine-artifacts/:id/download", summary: "Download envelope (assigned machine)", tags: ["artifacts"], auth: "machine", response_schema: C.ArtifactDownloadResp }),
  bundle_publish: reg({ method: "POST", path: "/v1/config/bundles", summary: "Publish config bundle", tags: ["config"], auth: "session", request_schema: C.BundlePublishReq, response_schema: C.BundleInfo }),
  bundle_latest: reg({ method: "GET", path: "/v1/config/bundles/latest", summary: "Latest bundle + manifest", tags: ["config"], auth: "either", response_schema: C.BundleLatestResp }),
  bundle_manifest: reg({ method: "GET", path: "/v1/config/bundles/:version/manifest", summary: "Manifest bytes from R2 (hash-verified)", tags: ["config"], auth: "machine", response_schema: Schema.Unknown }),
  config_report: reg({ method: "POST", path: "/v1/config/state", summary: "Report applied revision (machine)", tags: ["config"], auth: "machine", request_schema: C.ConfigStateReq, response_schema: C.ConfigStateResp }),
  config_read: reg({ method: "GET", path: "/v1/config/state", summary: "Read machine state", tags: ["config"], auth: "session", response_schema: C.ConfigStateResp }),
  activity: reg({ method: "GET", path: "/v1/activity", summary: "Recent activity", tags: ["account"], auth: "session", response_schema: C.ActivityResp }),
  deletion_request: reg({ method: "POST", path: "/v1/account/deletion/request", summary: "Request deletion", tags: ["account"], auth: "session", request_schema: C.DeletionRequestReq, response_schema: C.DeletionStatusResp }),
  deletion_status: reg({ method: "GET", path: "/v1/account/deletion", summary: "Deletion status", tags: ["account"], auth: "session", response_schema: C.DeletionStatusResp }),
  deletion_cancel: reg({ method: "POST", path: "/v1/account/deletion/cancel", summary: "Cancel deletion", tags: ["account"], auth: "session", response_schema: C.DeletionStatusResp }) };
