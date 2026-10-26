// Editor product: versioned MCP/skill configuration bundles.
// Manifest validation, canonicalization, content hashing, version assignment
// and R2 layout live here. Storage mechanics (R2 put/get) and activity come
// from shared services; the generic vault is untouched by editor content.

import { Effect, Schema } from "effect";
import { sha256Hex } from "../../crypto.js";
import { badRequest, conflict, forbidden, internal } from "../../errors.js";
import { newId } from "../../ids.js";
import { AppConfigTag, DbTag, dbRun } from "../../services/deps.js";
import { record } from "../../services/activity.js";
import { getBlob, putBlob } from "../../services/storage.js";
import { EditorManifest } from "../../contracts/v1.js";
import insertBundle from "../../db/queries/config/insertBundle.sql";
import getLatestBundleByAccount from "../../db/queries/config/getLatestBundleByAccount.sql";
import getBundleById from "../../db/queries/config/getBundleById.sql";
import getBundleByVersion from "../../db/queries/config/getBundleByVersion.sql";
import upsertMachineConfigState from "../../db/queries/config/upsertMachineConfigState.sql";
import getMachineConfigState from "../../db/queries/config/getMachineConfigState.sql";

export type ValidatedManifest = typeof EditorManifest.Type;

export function publishBundle(accountId: string, manifestInput: unknown) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    let manifest: ValidatedManifest;
    try {
      manifest = Schema.decodeUnknownSync(EditorManifest, { onExcessProperty: "error" })(manifestInput);
    } catch {
      return yield* Effect.fail(badRequest("invalid manifest"));
    }
    if (manifest.mcpServers.length > 64 || manifest.skills.length > 256) {
      return yield* Effect.fail(badRequest("manifest too large"));
    }
    // Canonical bytes: stable key order, no whitespace. The hash names the
    // exact bytes stored in R2, so Forge can verify what it downloads.
    const canonical = JSON.stringify(sortKeys(manifest));
    const contentHash = yield* Effect.promise(() => sha256Hex(canonical));
    // Concurrent publishes race on latest+1. The unique (account, version)
    // and (account, content_hash) constraints are the arbiters: a conflict
    // inserts nothing (zero rows) instead of raising, so the service re-reads
    // latest and either returns the identical-content revision (dedup) or
    // retries with a fresh id (bounded). No driver error-shape inspection.
    for (let attempt = 0; attempt < 4; attempt++) {
      const latest = yield* dbRun(() => getLatestBundleByAccount.run(db, { accountId }));
      if (latest && latest.content_hash === contentHash) {
        return { id: latest.id, version: latest.version, contentHash, r2Key: latest.r2_key, createdAt: latest.created_at, deduplicated: true as const };
      }
      const id = newId("bundle");
      // Content-addressed key: deterministic, no version to go stale in a race.
      const r2Key = `config/${accountId}/${contentHash}.json`;
      const rows = yield* dbRun(() =>
        insertBundle.run(db, { id, accountId, contentHash, r2Key, manifest: canonical }),
      );
      const done = rows[0] ?? null;
      if (!done) continue;
      yield* putBlob(r2Key, canonical);
      yield* record(accountId, "config.published", {});
      return { id: done.id, version: done.version, contentHash, r2Key: done.r2_key, createdAt: done.created_at, deduplicated: false as const };
    }
    return yield* Effect.fail(internal("concurrent publish, retry"));
  });
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export function latestBundle(accountId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const row = yield* dbRun(() => getLatestBundleByAccount.run(db, { accountId }));
    if (!row) return { bundle: null, manifest: null };
    const manifest = (typeof row.manifest === "string" ? JSON.parse(row.manifest) : row.manifest) as unknown;
    return {
      bundle: { id: row.id, version: row.version, contentHash: row.content_hash, r2Key: row.r2_key, createdAt: row.created_at },
      manifest,
    };
  });
}

export function bundleManifestBytes(accountId: string, version: number) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const row = yield* dbRun(() => getBundleByVersion.run(db, { accountId, version }));
    if (!row) return yield* Effect.fail(forbidden("no such bundle in this account"));
    // R2 holds the durable manifest object; the DB row carries the same
    // canonical bytes as fallback, so a missing object degrades instead of
    // breaking verification (the hash check still applies either way).
    const fromR2 = yield* getBlob(row.r2_key);
    const raw = fromR2 ?? new TextEncoder().encode(typeof row.manifest === "string" ? row.manifest : JSON.stringify(row.manifest));
    const hash = yield* Effect.promise(() => sha256Hex(raw));
    if (hash !== row.content_hash) return yield* Effect.fail(forbidden("manifest object mismatch"));
    return { bytes: raw, contentHash: row.content_hash };
  });
}

export function reportMachineState(machineId: string, accountId: string, opts: { bundleId: string; status: "applied" | "failed"; detail?: string }) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    // Zero rows means the mutation's guards refused: either the machine or
    // bundle is unknown/revoked/cross-account, or the report regresses the
    // recorded version. Follow-up reads tell those apart honestly.
    const rows = yield* dbRun(() =>
      upsertMachineConfigState.run(db, {
        machineId,
        bundleId: opts.bundleId,
        status: opts.status,
        detail: (opts.detail ?? "").slice(0, 500),
        accountId,
      }),
    );
    const done = rows[0] ?? null;
    if (done) {
      yield* record(accountId, "config.state_reported", { machineId });
      return { machineId: done.machine_id, bundleId: done.bundle_id, status: done.status, appliedAt: done.applied_at };
    }
    const [state, bundle] = yield* Effect.all([
      dbRun(() => getMachineConfigState.run(db, { machineId, accountId })),
      dbRun(() => getBundleById.run(db, { id: opts.bundleId, accountId })),
    ]);
    if (state && bundle && bundle.version < state.version) {
      return yield* Effect.fail(conflict("applied version regression"));
    }
    return yield* Effect.fail(forbidden("unknown machine or bundle in this account"));
  });
}

export function readMachineState(accountId: string, machineId: string) {
  return Effect.gen(function* () {
    const { db } = yield* DbTag;
    const row = yield* dbRun(() => getMachineConfigState.run(db, { machineId, accountId }));
    if (!row) return yield* Effect.fail(forbidden("no such machine or state"));
    return {
      machineId: row.machine_id,
      bundleId: row.bundle_id,
      status: row.status,
      detail: row.detail,
      appliedAt: row.applied_at,
      version: row.version,
      contentHash: row.content_hash,
    };
  });
}
