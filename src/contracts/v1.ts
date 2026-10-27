import { JSONSchema, Schema } from "effect";

// Authoritative runtime contracts for Core v1. Every request, response,
// event, and nested field is defined here. Sibling repos (Relay, Rust
// Forge/Editor) implement against docs/contracts.md + generated OpenAPI +
// fixtures; all three derive from these schemas.
//
// Rules: requests decode STRICT (unknown fields rejected); responses are
// read forward-compatibly by peers (unknown fields ignored). SQL-inferred
// row types are private and never re-exported here.

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const ulid26 = "[0-9A-HJKMNP-TV-Z]{26}";
const id_pattern = (prefix: string) => new RegExp(`^${prefix}_${ulid26}$`);

export const AccountId = Schema.String.pipe(Schema.pattern(id_pattern("acct")));
export const SessionId = Schema.String.pipe(Schema.pattern(id_pattern("sess")));
export const MachineId = Schema.String.pipe(Schema.pattern(id_pattern("mch")));
export const EnrollmentId = Schema.String.pipe(Schema.pattern(id_pattern("enr")));
export const LoginRequestId = Schema.String.pipe(Schema.pattern(id_pattern("logreq")));
export const ConnectionId = Schema.String.pipe(Schema.pattern(id_pattern("conn")));
export const ArtifactId = Schema.String.pipe(Schema.pattern(id_pattern("art")));
export const BundleId = Schema.String.pipe(Schema.pattern(id_pattern("bundle")));
export const TokenId = Schema.String.pipe(Schema.pattern(id_pattern("tkn")));
export const EventId = Schema.String.pipe(Schema.pattern(id_pattern("evt")));

export type AccountId = typeof AccountId.Type;
export type MachineId = typeof MachineId.Type;

export const Rfc3339 = Schema.String.pipe(
  Schema.filter((s) => !Number.isNaN(Date.parse(s)), {
    message: () => "expected RFC 3339 timestamp" }),
);

export const Base64url = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]+$/),
);

export const Base64url32 = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{43}$/),
);

export const Sha256Hex = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));

// ---------------------------------------------------------------------------
// Shared nested
// ---------------------------------------------------------------------------

export const JwkOkp = Schema.Struct({
  kty: Schema.Literal("OKP"),
  crv: Schema.Literal("Ed25519"),
  x: Base64url32 });
export type JwkOkp = typeof JwkOkp.Type;

export const ErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    requestId: Schema.String }) });

// ---------------------------------------------------------------------------
// Grant JWT claims (mirrors the signed JWT payload; cnf binds the key)
// ---------------------------------------------------------------------------

export const GrantScope = Schema.Literal("relay:connect", "forge:execute", "machine:sync");
export type GrantScope = typeof GrantScope.Type;

export const GrantClaims = Schema.Struct({
  v: Schema.Literal(1),
  iss: Schema.String,
  aud: Schema.Literal("ast-relay", "ast-core"),
  sub: AccountId,
  mid: MachineId,
  role: Schema.Literal("client", "forge"),
  cnf: Schema.Struct({ jwk: JwkOkp }),
  scope: Schema.NonEmptyArray(GrantScope),
  iat: Schema.Number,
  nbf: Schema.Number,
  exp: Schema.Number,
  jti: TokenId });
export type GrantClaims = typeof GrantClaims.Type;

// ---------------------------------------------------------------------------
// Auth: magic link + TOTP + sessions
// ---------------------------------------------------------------------------

export const Email = Schema.String.pipe(
  Schema.pattern(/^[^@\s]+@[^@\s]+\.[^@\s]+$/),
);

export const MagicRequest = Schema.Struct({
  email: Email,
  displayName: Schema.optional(Schema.String),
  deviceName: Schema.optional(Schema.String) });
export const MagicRequestResp = Schema.Struct({
  requestId: LoginRequestId,
  // Returned ONCE to the originating session only (never emailed, never
  // logged). The email token alone can never mint a session.
  requestSecret: Schema.String,
  expiresAt: Rfc3339 });

export const MagicStatusReq = Schema.Struct({
  requestId: LoginRequestId,
  requestSecret: Schema.String });
export const MagicStatusResp = Schema.Struct({
  requestId: LoginRequestId,
  status: Schema.Literal("pending", "email_approved", "completed", "expired"),
  totpRequired: Schema.Boolean,
  email: Email,
  expiresAt: Rfc3339 });

export const MagicConsumeReq = Schema.Struct({
  token: Schema.String,
  requestSecret: Schema.optional(Schema.String) });
export const MagicConsumeResp = Schema.Struct({
  requestId: LoginRequestId,
  status: Schema.Literal("pending", "email_approved", "completed", "expired"),
  totpRequired: Schema.Boolean });

export const MagicConfirmResp = Schema.Struct({
  status: Schema.Literal("confirmation_required") });

export const MagicFinalizeReq = Schema.Struct({
  requestId: LoginRequestId,
  requestSecret: Schema.String,
  totpCode: Schema.optional(Schema.String),
  recoveryCode: Schema.optional(Schema.String) });
export const MagicFinalizeResp = Schema.Struct({
  sessionId: SessionId,
  accountId: AccountId,
  expiresAt: Rfc3339,
  totpVerified: Schema.Boolean });

export const TotpEnrollResp = Schema.Struct({
  otpauthUrl: Schema.String,
  recoveryCodes: Schema.Array(Schema.String) });
export const TotpVerifyReq = Schema.Struct({ code: Schema.String });
export const TotpVerifyResp = Schema.Struct({ enrolled: Schema.Boolean });
export const TotpDisableReq = Schema.Struct({ code: Schema.String });
export const TotpDisableResp = Schema.Struct({ disabled: Schema.Boolean });

export const SessionInfo = Schema.Struct({
  id: SessionId,
  deviceName: Schema.String,
  totpVerifiedAt: Schema.NullOr(Rfc3339),
  createdAt: Rfc3339,
  expiresAt: Rfc3339,
  revokedAt: Schema.NullOr(Rfc3339) });
export const SessionListResp = Schema.Struct({ sessions: Schema.Array(SessionInfo) });

// Login gives the account its Forges, provider connections, and config.
export const MeMachine = Schema.Struct({
  id: MachineId,
  publicKey: JwkOkp,
  label: Schema.String,
  createdAt: Rfc3339,
  revokedAt: Schema.NullOr(Rfc3339) });
export const MeProvider = Schema.Struct({
  id: ConnectionId,
  provider: Schema.String,
  label: Schema.String,
  revokedAt: Schema.NullOr(Rfc3339),
  assignedMachineIds: Schema.Array(MachineId) });
export const MeResp = Schema.Struct({
  accountId: AccountId,
  email: Email,
  displayName: Schema.String,
  totpEnrolled: Schema.Boolean,
  machines: Schema.Array(MeMachine),
  providerConnections: Schema.Array(MeProvider),
  latestConfigVersion: Schema.NullOr(Schema.Number) });

// ---------------------------------------------------------------------------
// Machines: enrollment + registry
// ---------------------------------------------------------------------------

export const EnrollmentStartReq = Schema.Struct({
  publicKey: JwkOkp,
  label: Schema.String,
  timestamp: Schema.Number,
  proof: Base64url });
export const EnrollmentStartResp = Schema.Struct({
  enrollmentId: EnrollmentId,
  code: Schema.String,
  expiresAt: Rfc3339,
  keyFingerprint: Base64url });

export const EnrollmentClaimReq = Schema.Struct({ code: Schema.String });
export const EnrollmentClaimResp = Schema.Struct({
  enrollmentId: EnrollmentId,
  status: Schema.Literal("claimed") });

export const EnrollmentStatusResp = Schema.Struct({
  enrollmentId: EnrollmentId,
  status: Schema.Literal("pending", "claimed", "confirmed", "expired", "voided"),
  accountId: Schema.NullOr(AccountId),
  email: Schema.NullOr(Email),
  displayName: Schema.NullOr(Schema.String),
  expiresAt: Rfc3339 });

export const EnrollmentConfirmReq = Schema.Struct({
  enrollmentId: EnrollmentId,
  accountId: AccountId,
  confirmation: Base64url });
export const EnrollmentConfirmResp = Schema.Struct({
  machineId: MachineId,
  accountId: AccountId });

export const MachineInfo = Schema.Struct({
  id: MachineId,
  publicKey: JwkOkp,
  label: Schema.String,
  createdAt: Rfc3339,
  revokedAt: Schema.NullOr(Rfc3339),
  lastSeenAt: Schema.NullOr(Rfc3339) });
export const MachineListResp = Schema.Struct({ machines: Schema.Array(MachineInfo) });

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export const GrantIssueReq = Schema.Struct({
  audience: Schema.Literal("ast-relay", "ast-core"),
  scope: Schema.NonEmptyArray(GrantScope),
  ttlSeconds: Schema.optional(Schema.Number),
  targetMachineId: Schema.optional(MachineId),
  cnf: Schema.optional(JwkOkp) });
export const GrantIssueResp = Schema.Struct({
  token: Schema.String,
  expiresAt: Rfc3339 });

export const JwksResp = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      kty: Schema.Literal("OKP"),
      crv: Schema.Literal("Ed25519"),
      x: Base64url32,
      kid: Schema.String,
      use: Schema.Literal("sig"),
      alg: Schema.Literal("EdDSA") }),
  ) });
export type JwksResp = typeof JwksResp.Type;

export const RevocationsResp = Schema.Struct({
  revokedMachineIds: Schema.Array(MachineId),
  revokedKeyIds: Schema.Array(Schema.String),
  asOf: Rfc3339 });

// ---------------------------------------------------------------------------
// Vault: provider API keys (API keys only; Core performs no OAuth)
// ---------------------------------------------------------------------------

export const ProviderKind = Schema.Literal("anthropic", "openai", "openrouter", "google");
export type ProviderKind = typeof ProviderKind.Type;

export const ProviderCreateReq = Schema.Struct({
  provider: ProviderKind,
  label: Schema.optional(Schema.String),
  apiKey: Schema.String });
export const ProviderInfo = Schema.Struct({
  id: ConnectionId,
  provider: ProviderKind,
  label: Schema.String,
  createdAt: Rfc3339,
  revokedAt: Schema.NullOr(Rfc3339),
  assignedMachineIds: Schema.Array(MachineId) });
export const ProviderListResp = Schema.Struct({ connections: Schema.Array(ProviderInfo) });

export const AssignReq = Schema.Struct({
  connectionId: ConnectionId,
  machineId: MachineId });
export const AssignResp = Schema.Struct({
  connectionId: ConnectionId,
  machineId: MachineId });

export const ArtifactAssignReq = Schema.Struct({
  artifactId: ArtifactId,
  machineId: MachineId });

export const CredentialResp = Schema.Struct({
  provider: ProviderKind,
  secret: Schema.String });

// ---------------------------------------------------------------------------
// Engine artifacts: opaque envelopes from the harness's own local login.
// Core validates the envelope SHAPE; inner file bytes stay opaque.
// Core performs no OAuth for engines either.
// ---------------------------------------------------------------------------

export const ArtifactFile = Schema.Struct({
  path: Schema.String,
  mode: Schema.Literal("0600", "0400"),
  sha256: Sha256Hex,
  contentBase64: Base64url });
export type ArtifactFile = typeof ArtifactFile.Type;

export const EngineArtifactEnvelope = Schema.Struct({
  format: Schema.Literal("ast-engine-credential/1"),
  engine: Schema.Literal("claude", "codex", "opencode"),
  kind: Schema.Literal("oauth", "api_key"),
  exportedAt: Rfc3339,
  expiresAt: Schema.NullOr(Rfc3339),
  files: Schema.NonEmptyArray(ArtifactFile),
  note: Schema.optional(Schema.String) });
export type EngineArtifactEnvelope = typeof EngineArtifactEnvelope.Type;

export const ArtifactCreateReq = Schema.Struct({
  label: Schema.optional(Schema.String),
  envelope: EngineArtifactEnvelope });
export const ArtifactInfo = Schema.Struct({
  id: ArtifactId,
  engine: Schema.Literal("claude", "codex", "opencode"),
  kind: Schema.Literal("oauth", "api_key"),
  label: Schema.String,
  formatVersion: Schema.String,
  exportedAt: Rfc3339,
  createdAt: Rfc3339,
  revokedAt: Schema.NullOr(Rfc3339),
  assignedMachineIds: Schema.Array(MachineId) });
export const ArtifactListResp = Schema.Struct({ artifacts: Schema.Array(ArtifactInfo) });
export const ArtifactDownloadResp = Schema.Struct({ envelope: EngineArtifactEnvelope });

// ---------------------------------------------------------------------------
// Editor configuration: versioned MCP/skill bundles + applied revisions
// ---------------------------------------------------------------------------

export const McpServer = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  command: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
  args: Schema.optional(Schema.Array(Schema.String.pipe(Schema.maxLength(500)))),
  url: Schema.optional(Schema.String.pipe(Schema.maxLength(2000))) });
export const SkillFile = Schema.Struct({
  // Path relative to the skill root. Strict: non-empty, no leading slash,
  // no parent escapes, 256 chars max. Every bundle must include SKILL.md.
  path: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  contentBase64: Base64url,
  sha256: Sha256Hex });
export type SkillFile = typeof SkillFile.Type;
export const SkillRef = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  // Where an already-installed skill lives (local path/URL understood by
  // the Forge importer). Stays required so existing references keep working.
  source: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2000)),
  version: Schema.optional(Schema.String.pipe(Schema.maxLength(60))),
  // Optional embedded skill for machines that do not have it installed:
  // files install onto the new machine verbatim under the skill root.
  // Bytes live inside the content-hashed R2 manifest (no new service/SQL);
  // the manifest ETag prevents re-downloading unchanged bundles.
  bundle: Schema.optional(
    Schema.Struct({
      files: Schema.Array(SkillFile).pipe(Schema.minItems(1), Schema.maxItems(64)) }),
  ) });
export const EditorManifest = Schema.Struct({
  format: Schema.Literal("ast-editor-config/1"),
  mcpServers: Schema.Array(McpServer),
  skills: Schema.Array(SkillRef),
  globalPrompt: Schema.optional(Schema.String) });
export type EditorManifest = typeof EditorManifest.Type;

export const BundlePublishReq = Schema.Struct({ manifest: EditorManifest });
export const BundleInfo = Schema.Struct({
  id: BundleId,
  version: Schema.Number,
  contentHash: Sha256Hex,
  r2Key: Schema.String,
  createdAt: Rfc3339 });
export const BundleLatestResp = Schema.Struct({
  bundle: Schema.NullOr(BundleInfo),
  manifest: Schema.NullOr(EditorManifest) });

export const ConfigStateReq = Schema.Struct({
  bundleId: BundleId,
  status: Schema.Literal("applied", "failed"),
  detail: Schema.optional(Schema.String) });
export const ConfigStateResp = Schema.Struct({
  machineId: MachineId,
  bundleId: BundleId,
  status: Schema.Literal("applied", "failed"),
  appliedAt: Rfc3339 });

// ---------------------------------------------------------------------------
// Activity + deletion + version
// ---------------------------------------------------------------------------

export const ActivityEvent = Schema.Struct({
  id: EventId,
  machineId: Schema.NullOr(MachineId),
  kind: Schema.String,
  detail: Schema.Unknown,
  ip: Schema.NullOr(Schema.String),
  createdAt: Rfc3339 });
export const ActivityResp = Schema.Struct({ events: Schema.Array(ActivityEvent) });

export const DeletionRequestReq = Schema.Struct({
  totpCode: Schema.optional(Schema.String) });
export const DeletionStatusResp = Schema.Struct({
  status: Schema.Literal("none", "pending", "cancelled", "done"),
  requestedAt: Schema.NullOr(Rfc3339),
  purgeAfter: Schema.NullOr(Rfc3339),
  completedAt: Schema.NullOr(Rfc3339) });

export const VersionResp = Schema.Struct({
  api: Schema.String,
  contracts: Schema.String,
  jwksUri: Schema.String,
  openapi: Schema.String });

// ---------------------------------------------------------------------------
// Strict boundary helpers
// ---------------------------------------------------------------------------

export function decode_request<A, I>(schema: Schema.Schema<A, I>, input: unknown): A {
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input);
}

export function encode_response<A, I>(schema: Schema.Schema<A, I>, value: A): I {
  return Schema.encodeUnknownSync(schema)(value) as I;
}

export function json_schema_for<A, I>(schema: Schema.Schema<A, I>): Record<string, unknown> {
  return JSONSchema.make(schema) as unknown as Record<string, unknown>;
}
