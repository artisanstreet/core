import { Effect } from "effect";
import { decryptWithKey, encryptWithKey } from "../crypto.ts";
import { badRequest, forbidden } from "../errors.ts";
import { newId } from "../ids.ts";
import { AppConfigTag, DbTag, dbRun } from "./deps.ts";
import { record } from "./activity.ts";
import { EngineArtifactEnvelope } from "../contracts/v1.ts";

// Validated envelope shape (shared wire language). Domain validation lives
// in the Editor product layer (products/editor/artifacts.ts); the generic
// vault only stores, assigns, and releases validated envelopes.
export type ValidatedEnvelope = typeof EngineArtifactEnvelope.Type;
import insertProviderConnection from "../db/queries/vault/insertProviderConnection.sql";
import listProviderConnectionsByAccount from "../db/queries/vault/listProviderConnectionsByAccount.sql";
import revokeProviderConnection from "../db/queries/vault/revokeProviderConnection.sql";
import assignMachine from "../db/queries/vault/assignMachine.sql";
import unassignMachine from "../db/queries/vault/unassignMachine.sql";
import getCredentialForMachine from "../db/queries/vault/getCredentialForMachine.sql";
import listAssignmentsByAccount from "../db/queries/vault/listAssignmentsByAccount.sql";
import listAssignedConnectionsForMachine from "../db/queries/vault/listAssignedConnectionsForMachine.sql";
import insertEngineArtifact from "../db/queries/artifacts/insertEngineArtifact.sql";
import listEngineArtifactsByAccount from "../db/queries/artifacts/listEngineArtifactsByAccount.sql";
import revokeEngineArtifact from "../db/queries/artifacts/revokeEngineArtifact.sql";
import assignArtifactMachine from "../db/queries/artifacts/assignArtifactMachine.sql";
import unassignArtifactMachine from "../db/queries/artifacts/unassignArtifactMachine.sql";
import getArtifactEnvelopeForMachine from "../db/queries/artifacts/getArtifactEnvelopeForMachine.sql";
import listArtifactAssignmentsByAccount from "../db/queries/artifacts/listArtifactAssignmentsByAccount.sql";
import listAssignedArtifactsForMachine from "../db/queries/artifacts/listAssignedArtifactsForMachine.sql";

const PROVIDER_PURPOSE = "provider-secret v1";
const ARTIFACT_PURPOSE = "engine-artifact v1";
const MAX_ENVELOPE_BYTES = 262144;

// ---------------------------------------------------------------------------
// Provider API keys. API keys ONLY: Core performs no OAuth for providers.
// A pasted key is encrypted at rest and released solely to assigned live
// machines of the same account.
// ---------------------------------------------------------------------------

export function createProviderConnection(opts: {
  accountId: string;
  provider: "anthropic" | "openai" | "openrouter" | "google";
  label: string;
  apiKey: string;
}) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const key = opts.apiKey.trim();
    if (key.length < 8 || key.length > 4096) return yield* Effect.fail(badRequest("apiKey looks invalid"));
    const enc = yield* Effect.promise(() =>
      encryptWithKey(cfg.masterKey.raw, new TextEncoder().encode(key), PROVIDER_PURPOSE),
    );
    const row = yield* dbRun(() =>
      insertProviderConnection.run(db, {
        id: newId("conn"),
        accountId: opts.accountId,
        provider: opts.provider,
        label: opts.label.slice(0, 120),
        secretEnc: enc,
      }),
    );
    yield* record(opts.accountId, "vault.connection_created", {});
    return { id: row.id, provider: row.provider, label: row.label, createdAt: row.created_at };
  });
}

export function listProviderConnections(accountId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const conns = yield* dbRun(() => listProviderConnectionsByAccount.run(db, { accountId }));
    const assigns = yield* dbRun(() => listAssignmentsByAccount.run(db, { accountId }));
    return {
      connections: conns.map((c) => ({
        id: c.id,
        provider: c.provider,
        label: c.label,
        createdAt: c.created_at,
        revokedAt: c.revoked_at,
        assignedMachineIds: assigns.filter((a) => a.connection_id === c.id).map((a) => a.machine_id),
      })),
    };
  });
}

export function revokeProviderConnectionById(accountId: string, connectionId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const done = yield* dbRun(() => revokeProviderConnection.run(db, { id: connectionId, accountId }));
    if (!done) return yield* Effect.fail(forbidden("no such connection in this account"));
    yield* record(accountId, "vault.connection_revoked", {});
    return { revoked: true };
  });
}

// Machine discovery for sync: only this machine's own assigned connections.
// assignedMachineIds is scoped to the caller so one machine never learns
// which other machines hold the same credential.
export function listAssignedProviderConnections(accountId: string, machineId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const rows = yield* dbRun(() => listAssignedConnectionsForMachine.run(db, { accountId, machineId }));
    return {
      connections: rows.map((c) => ({
        id: c.id,
        provider: c.provider,
        label: c.label,
        createdAt: c.created_at,
        revokedAt: c.revoked_at,
        assignedMachineIds: [machineId],
      })),
    };
  });
}

export function assignConnection(accountId: string, connectionId: string, machineId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    // Array cardinality is the account binding speaking: zero rows means
    // one of the ends is unknown, revoked, or in another account.
    const rows = yield* dbRun(() => assignMachine.run(db, { connectionId, machineId, accountId }));
    const done = rows[0] ?? null;
    if (!done) return yield* Effect.fail(forbidden("unknown connection or machine in this account"));
    yield* record(accountId, "vault.assigned", {});
    return { connectionId: done.connection_id, machineId: done.machine_id };
  });
}

export function unassignConnection(accountId: string, connectionId: string, machineId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const done = yield* dbRun(() => unassignMachine.run(db, { connectionId, machineId, accountId }));
    if (!done) return yield* Effect.fail(forbidden("no such assignment in this account"));
    yield* record(accountId, "vault.unassigned", {});
    return { unassigned: true };
  });
}

export function releaseCredential(accountId: string, machineId: string, connectionId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const row = yield* dbRun(() => getCredentialForMachine.run(db, { connectionId, machineId, accountId }));
    if (!row) return yield* Effect.fail(forbidden("no credential available to this machine"));
    const secret = yield* Effect.tryPromise({
      try: () => decryptWithKey(cfg.masterKey.raw, new Uint8Array(row.secret_enc), PROVIDER_PURPOSE),
      catch: () => forbidden("no credential available to this machine"),
    });
    return { provider: row.provider, secret: new TextDecoder().decode(secret) };
  });
}

// The envelope arrives validated by the Editor product layer
// (products/editor/artifacts.ts); this service never reinterprets it.
export function storeArtifact(opts: { accountId: string; label: string; envelope: ValidatedEnvelope }) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const env = opts.envelope;
    const enc = yield* Effect.promise(() =>
      encryptWithKey(cfg.masterKey.raw, new TextEncoder().encode(JSON.stringify(env)), ARTIFACT_PURPOSE),
    );
    const id = newId("art");
    yield* dbRun(() =>
      insertEngineArtifact.run(db, {
        id,
        accountId: opts.accountId,
        engine: env.engine,
        kind: env.kind,
        label: opts.label.slice(0, 120),
        formatVersion: env.format,
        envelopeEnc: enc,
        exportedAt: env.exportedAt,
      }),
    );
    yield* record(opts.accountId, "artifact.stored", {});
    return { id };
  });
}

export function listArtifacts(accountId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const arts = yield* dbRun(() => listEngineArtifactsByAccount.run(db, { accountId }));
    const assigns = yield* dbRun(() => listArtifactAssignmentsByAccount.run(db, { accountId }));
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
        assignedMachineIds: assigns.filter((x) => x.artifact_id === a.id).map((x) => x.machine_id),
      })),
    };
  });
}

export function revokeArtifact(accountId: string, artifactId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const done = yield* dbRun(() => revokeEngineArtifact.run(db, { id: artifactId, accountId }));
    if (!done) return yield* Effect.fail(forbidden("no such artifact in this account"));
    yield* record(accountId, "artifact.revoked", {});
    return { revoked: true };
  });
}

// Machine discovery for sync: only this machine's own assigned artifacts.
// assignedMachineIds is scoped to the caller; envelopes are never listed.
export function listAssignedArtifacts(accountId: string, machineId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const rows = yield* dbRun(() => listAssignedArtifactsForMachine.run(db, { accountId, machineId }));
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
        assignedMachineIds: [machineId],
      })),
    };
  });
}

export function assignArtifact(accountId: string, artifactId: string, machineId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const rows = yield* dbRun(() => assignArtifactMachine.run(db, { artifactId, machineId, accountId }));
    const done = rows[0] ?? null;
    if (!done) return yield* Effect.fail(forbidden("unknown artifact or machine in this account"));
    yield* record(accountId, "artifact.assigned", {});
    return { artifactId: done.artifact_id, machineId: done.machine_id };
  });
}

export function unassignArtifact(accountId: string, artifactId: string, machineId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const done = yield* dbRun(() => unassignArtifactMachine.run(db, { artifactId, machineId, accountId }));
    if (!done) return yield* Effect.fail(forbidden("no such assignment in this account"));
    yield* record(accountId, "artifact.unassigned", {});
    return { unassigned: true };
  });
}

export function downloadArtifact(accountId: string, machineId: string, artifactId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const row = yield* dbRun(() => getArtifactEnvelopeForMachine.run(db, { artifactId, machineId, accountId }));
    if (!row) return yield* Effect.fail(forbidden("no artifact available to this machine"));
    const pt = yield* Effect.tryPromise({
      try: () => decryptWithKey(cfg.masterKey.raw, new Uint8Array(row.envelope_enc), ARTIFACT_PURPOSE),
      catch: () => forbidden("no artifact available to this machine"),
    });
    const envelope = JSON.parse(new TextDecoder().decode(pt)) as unknown;
    return { envelope };
  });
}
