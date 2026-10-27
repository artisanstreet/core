import { Effect, Schema } from "effect";
import { decrypt_with_key, encrypt_with_key } from "../crypto.ts";
import { bad_request, forbidden } from "../errors.ts";
import { new_id } from "../ids.ts";
import { AppConfigTag, DbTag, db_run } from "./deps.ts";
import { record } from "./activity.ts";
import { EngineArtifactEnvelope } from "../contracts/v1.ts";

// Validated envelope shape (shared wire language). Domain validation lives
// in the Editor product layer (products/editor/artifacts.ts); the generic
// vault only stores, assigns, and releases validated envelopes.
export type ValidatedEnvelope = typeof EngineArtifactEnvelope.Type;
import insert_provider_connection from "../db/queries/vault/insertProviderConnection.sql"
import list_provider_connections_by_account from "../db/queries/vault/listProviderConnectionsByAccount.sql"
import revoke_provider_connection from "../db/queries/vault/revokeProviderConnection.sql"
import assign_machine from "../db/queries/vault/assignMachine.sql"
import unassign_machine from "../db/queries/vault/unassignMachine.sql"
import get_credential_for_machine from "../db/queries/vault/getCredentialForMachine.sql"
import list_assignments_by_account from "../db/queries/vault/listAssignmentsByAccount.sql"
import list_assigned_connections_for_machine from "../db/queries/vault/listAssignedConnectionsForMachine.sql"
import insert_engine_artifact from "../db/queries/artifacts/insertEngineArtifact.sql"
import list_engine_artifacts_by_account from "../db/queries/artifacts/listEngineArtifactsByAccount.sql"
import revoke_engine_artifact from "../db/queries/artifacts/revokeEngineArtifact.sql"
import assign_artifact_machine from "../db/queries/artifacts/assignArtifactMachine.sql"
import unassign_artifact_machine from "../db/queries/artifacts/unassignArtifactMachine.sql"
import get_artifact_envelope_for_machine from "../db/queries/artifacts/getArtifactEnvelopeForMachine.sql"
import list_artifact_assignments_by_account from "../db/queries/artifacts/listArtifactAssignmentsByAccount.sql"
import list_assigned_artifacts_for_machine from "../db/queries/artifacts/listAssignedArtifactsForMachine.sql"

const PROVIDER_PURPOSE = "provider-secret v1";
const ARTIFACT_PURPOSE = "engine-artifact v1";
const MAX_ENVELOPE_BYTES = 262144;

// ---------------------------------------------------------------------------
// Provider API keys. API keys ONLY: Core performs no OAuth for providers.
// A pasted key is encrypted at rest and released solely to assigned live
// machines of the same account.
// ---------------------------------------------------------------------------

export const create_provider_connection = (opts: {
  account_id: string;
  provider: "anthropic" | "openai" | "openrouter" | "google";
  label: string;
  api_key: string;
}) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const key = opts.api_key.trim();
    if (key.length < 8 || key.length > 4096) return yield* Effect.fail(bad_request("apiKey looks invalid"));
    const enc = yield* Effect.sync(() =>
      encrypt_with_key(cfg.master_key.raw, new TextEncoder().encode(key), PROVIDER_PURPOSE),
    );
    const row = yield* db_run(() =>
      insert_provider_connection.run(db, {
        id: new_id("conn"),
        accountId: opts.account_id,
        provider: opts.provider,
        label: opts.label.slice(0, 120),
        secretEnc: enc }),
    );
    yield* record(opts.account_id, "vault.connection_created", {});
    return { id: row.id, provider: row.provider, label: row.label, createdAt: row.created_at };
  });

export const list_provider_connections = (account_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const conns = yield* db_run(() => list_provider_connections_by_account.run(db, { accountId: account_id }));
    const assigns = yield* db_run(() => list_assignments_by_account.run(db, { accountId: account_id }));
    return {
      connections: conns.map((c) => ({
        id: c.id,
        provider: c.provider,
        label: c.label,
        createdAt: c.created_at,
        revokedAt: c.revoked_at,
        assignedMachineIds: assigns.filter((a) => a.connection_id === c.id).map((a) => a.machine_id) })) };
  });

export const revoke_provider_connection_by_id = (account_id: string, connection_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const done = yield* db_run(() => revoke_provider_connection.run(db, { id: connection_id, accountId: account_id }));
    if (!done) return yield* Effect.fail(forbidden("no such connection in this account"));
    yield* record(account_id, "vault.connection_revoked", {});
    return { revoked: true };
  });

// Machine discovery for sync: only this machine's own assigned connections.
// assignedMachineIds is scoped to the caller so one machine never learns
// which other machines hold the same credential.
export const list_assigned_provider_connections = (account_id: string, machine_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const rows = yield* db_run(() => list_assigned_connections_for_machine.run(db, { accountId: account_id, machineId: machine_id }));
    return {
      connections: rows.map((c) => ({
        id: c.id,
        provider: c.provider,
        label: c.label,
        createdAt: c.created_at,
        revokedAt: c.revoked_at,
        assignedMachineIds: [machine_id] })) };
  });

export const assign_connection = (account_id: string, connection_id: string, machine_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    // Array cardinality is the account binding speaking: zero rows means
    // one of the ends is unknown, revoked, or in another account.
    const rows = yield* db_run(() => assign_machine.run(db, { connectionId: connection_id, machineId: machine_id, accountId: account_id }));
    const done = rows[0] ?? null;
    if (!done) return yield* Effect.fail(forbidden("unknown connection or machine in this account"));
    yield* record(account_id, "vault.assigned", {});
    return { connectionId: done.connection_id, machineId: done.machine_id };
  });

export const unassign_connection = (account_id: string, connection_id: string, machine_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const done = yield* db_run(() => unassign_machine.run(db, { connectionId: connection_id, machineId: machine_id, accountId: account_id }));
    if (!done) return yield* Effect.fail(forbidden("no such assignment in this account"));
    yield* record(account_id, "vault.unassigned", {});
    return { unassigned: true };
  });

export const release_credential = (account_id: string, machine_id: string, connection_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const row = yield* db_run(() => get_credential_for_machine.run(db, { connectionId: connection_id, machineId: machine_id, accountId: account_id }));
    if (!row) return yield* Effect.fail(forbidden("no credential available to this machine"));
    const secret = yield* Effect.try({
        try: () => decrypt_with_key(cfg.master_key.raw, new Uint8Array(row.secret_enc), PROVIDER_PURPOSE),
      catch: () => forbidden("no credential available to this machine") });
    return { provider: row.provider, secret: new TextDecoder().decode(secret) };
  });

// The envelope arrives validated by the Editor product layer
// (products/editor/artifacts.ts); this service never reinterprets it.
export const store_artifact = (opts: { account_id: string; label: string; envelope: ValidatedEnvelope }) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const env = opts.envelope;
    const enc = yield* Effect.sync(() =>
      encrypt_with_key(cfg.master_key.raw, new TextEncoder().encode(JSON.stringify(env)), ARTIFACT_PURPOSE),
    );
    const id = new_id("art");
    yield* db_run(() =>
      insert_engine_artifact.run(db, {
        id,
        accountId: opts.account_id,
        engine: env.engine,
        kind: env.kind,
        label: opts.label.slice(0, 120),
        formatVersion: env.format,
        envelopeEnc: enc,
        exportedAt: env.exportedAt }),
    );
    yield* record(opts.account_id, "artifact.stored", {});
    return { id };
  });

export const list_artifacts = (account_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const arts = yield* db_run(() => list_engine_artifacts_by_account.run(db, { accountId: account_id }));
    const assigns = yield* db_run(() => list_artifact_assignments_by_account.run(db, { accountId: account_id }));
    return {
      artifacts: arts.map((a) => ({
        id: a.id,
        engine: a.engine,
        kind: a.kind,
        label: a.label,
        formatVersion: a.format_version,
        exportedAt: a.exported_at,
        createdAt: a.created_at,
        revokedAt: a.revoked_at,
        assignedMachineIds: assigns.filter((x) => x.artifact_id === a.id).map((x) => x.machine_id) })) };
  });

export const revoke_artifact = (account_id: string, artifact_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const done = yield* db_run(() => revoke_engine_artifact.run(db, { id: artifact_id, accountId: account_id }));
    if (!done) return yield* Effect.fail(forbidden("no such artifact in this account"));
    yield* record(account_id, "artifact.revoked", {});
    return { revoked: true };
  });

// Machine discovery for sync: only this machine's own assigned artifacts.
// assignedMachineIds is scoped to the caller; envelopes are never listed.
export const list_assigned_artifacts = (account_id: string, machine_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const rows = yield* db_run(() => list_assigned_artifacts_for_machine.run(db, { accountId: account_id, machineId: machine_id }));
    return {
      artifacts: rows.map((a) => ({
        id: a.id,
        engine: a.engine,
        kind: a.kind,
        label: a.label,
        formatVersion: a.format_version,
        exportedAt: a.exported_at,
        createdAt: a.created_at,
        revokedAt: a.revoked_at,
        assignedMachineIds: [machine_id] })) };
  });

export const assign_artifact = (account_id: string, artifact_id: string, machine_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const rows = yield* db_run(() => assign_artifact_machine.run(db, { artifactId: artifact_id, machineId: machine_id, accountId: account_id }));
    const done = rows[0] ?? null;
    if (!done) return yield* Effect.fail(forbidden("unknown artifact or machine in this account"));
    yield* record(account_id, "artifact.assigned", {});
    return { artifactId: done.artifact_id, machineId: done.machine_id };
  });

export const unassign_artifact = (account_id: string, artifact_id: string, machine_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const done = yield* db_run(() => unassign_artifact_machine.run(db, { artifactId: artifact_id, machineId: machine_id, accountId: account_id }));
    if (!done) return yield* Effect.fail(forbidden("no such assignment in this account"));
    yield* record(account_id, "artifact.unassigned", {});
    return { unassigned: true };
  });

export const download_artifact = (account_id: string, machine_id: string, artifact_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const row = yield* db_run(() => get_artifact_envelope_for_machine.run(db, { artifactId: artifact_id, machineId: machine_id, accountId: account_id }));
    if (!row) return yield* Effect.fail(forbidden("no artifact available to this machine"));
    const pt = yield* Effect.try({
        try: () => decrypt_with_key(cfg.master_key.raw, new Uint8Array(row.envelope_enc), ARTIFACT_PURPOSE),
      catch: () => forbidden("no artifact available to this machine") });
    const envelope = yield* Schema.decodeUnknown(Schema.parseJson(Schema.Unknown))(new TextDecoder().decode(pt)).pipe(
      Effect.mapError(() => forbidden("no artifact available to this machine")),
    );
    return { envelope };
  });
