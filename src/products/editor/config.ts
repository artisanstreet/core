// Editor product: versioned MCP/skill configuration bundles.
// Manifest validation, canonicalization, content hashing, version assignment
// and R2 layout live here. Storage mechanics (R2 put/get) and activity come
// from shared services; the generic vault is untouched by editor content.

import { Effect, Either, Schema } from "effect";
import { base64url_decode, sha256_hex } from "../../crypto.ts";
import { bad_request, conflict, forbidden, internal, CoreError } from "../../errors.ts";
import { new_id } from "../../ids.ts";
import { AppConfigTag, DbTag, db_run } from "../../services/deps.ts";
import { record } from "../../services/activity.ts";
import { get_blob, put_blob } from "../../services/storage.ts";
import { EditorManifest } from "../../contracts/v1.ts";
import { StoredManifest, is_manifest_resp, to_editor_manifest_resp } from "../../contracts/response.ts";
import insert_bundle from "../../db/queries/config/insert-bundle.sql"
import get_latest_bundle_by_account from "../../db/queries/config/get-latest-bundle-by-account.sql"
import get_bundle_by_id from "../../db/queries/config/get-bundle-by-id.sql"
import get_bundle_by_version from "../../db/queries/config/get-bundle-by-version.sql"
import upsert_machine_config_state from "../../db/queries/config/upsert-machine-config-state.sql"
import get_machine_config_state from "../../db/queries/config/get-machine-config-state.sql"

export type ValidatedManifest = typeof EditorManifest.Type;

const MAX_SKILL_BUNDLE_BYTES = 1024 * 1024;

// Skill bundles install onto machines that lack the skill. Source refs
// alone only enable already-installed skills, so a bundle carries the
// files; bytes ride inside the content-hashed manifest (ETag-gated).
const validate_skill_bundles = (manifest: ValidatedManifest) =>
  Effect.gen(function* () {
    for (const s of manifest.skills) {
      if (!s.bundle) continue;
      let total = 0;
      let has_skill_md = false;
      for (const f of s.bundle.files) {
        if (f.path.length > 256 || f.path.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(f.path)) {
          return yield* Effect.fail(bad_request("invalid skill file path"));
        }
        const decoded = Either.try(() => base64url_decode(f.contentBase64));
        if (Either.isLeft(decoded)) return yield* Effect.fail(bad_request("invalid skill file encoding"));
        const file_bytes = decoded.right;
        total += file_bytes.length;
        if (total > MAX_SKILL_BUNDLE_BYTES) return yield* Effect.fail(bad_request("skill bundle too large"));
        const digest = yield* Effect.sync(() => sha256_hex(file_bytes));
        if (digest !== f.sha256) return yield* Effect.fail(bad_request("skill file hash mismatch"));
        if (f.path === "SKILL.md") has_skill_md = true;
      }
      if (!has_skill_md) return yield* Effect.fail(bad_request("skill bundle must include SKILL.md"));
    }
  });

export const publish_bundle = (account_id: string, manifest_input: unknown) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const manifest = yield* Schema.decodeUnknown(EditorManifest, { onExcessProperty: "error" })(manifest_input).pipe(
      Effect.mapError(() => bad_request("invalid manifest")),
    );
    if (manifest.mcpServers.length > 64 || manifest.skills.length > 256) {
      return yield* Effect.fail(bad_request("manifest too large"));
    }
    yield* validate_skill_bundles(manifest);
    // Canonical snake bytes: stable key order, no whitespace. The hash
    // names the exact snake bytes stored in R2, so Forge verifies download.
    const snake_manifest = to_editor_manifest_resp(manifest);
    const canonical = JSON.stringify(sort_keys(snake_manifest));
    const content_hash = yield* Effect.sync(() => sha256_hex(canonical));
    // Concurrent publishes race on latest+1. The unique (account, version)
    // and (account, content_hash) constraints are the arbiters: a conflict
    // inserts nothing (zero rows) instead of raising, so the service re-reads
    // latest and either returns the identical-content revision (dedup) or
    // retries with a fresh id (bounded). No driver error-shape inspection.
    for (let attempt = 0; attempt < 4; attempt++) {
      const latest = yield* db_run(() => get_latest_bundle_by_account.run(db, { account_id: account_id }));
      if (latest && latest.content_hash === content_hash) {
        return { id: latest.id, version: latest.version, content_hash: content_hash, r2_key: latest.r2_key, created_at: latest.created_at, deduplicated: true as const };
      }
      const id = new_id("bundle");
      // Content-addressed key: deterministic, no version to go stale in a race.
      const r2_key = `config/${account_id}/${content_hash}.json`;
      const rows = yield* db_run(() =>
        insert_bundle.run(db, { id, account_id: account_id, content_hash: content_hash, r2_key: r2_key, manifest: canonical }),
      );
      const done = rows[0] ?? null;
      if (!done) continue;
      yield* put_blob(r2_key, canonical);
      yield* record(account_id, "config.published", {});
      return { id: done.id, version: done.version, content_hash: content_hash, r2_key: done.r2_key, created_at: done.created_at, deduplicated: false as const };
    }
    return yield* Effect.fail(internal("concurrent publish, retry"));
  });

function sort_keys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sort_keys);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sort_keys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export const latest_bundle = (account_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const row = yield* db_run(() => get_latest_bundle_by_account.run(db, { account_id: account_id }));
    if (!row) return { bundle: null, manifest: null };
    const parsed = typeof row.manifest === "string"
      ? yield* Schema.decodeUnknown(Schema.parseJson(Schema.Unknown))(row.manifest).pipe(
        Effect.mapError(() => internal("bundle manifest corrupt")),
      )
      : row.manifest as unknown;
    const stored = yield* Schema.decodeUnknown(StoredManifest)(parsed).pipe(
      Effect.mapError(() => internal("bundle manifest corrupt")),
    );
    const snake_manifest = is_manifest_resp(stored) ? stored : to_editor_manifest_resp(stored);
    // content_hash always names the exact snake bytes served.
    const canonical = JSON.stringify(sort_keys(snake_manifest));
    const content_hash = yield* Effect.sync(() => sha256_hex(canonical));
    return {
      bundle: { id: row.id, version: row.version, content_hash: content_hash, r2_key: row.r2_key, created_at: row.created_at },
      manifest: snake_manifest };
  });

export const bundle_manifest_bytes = (account_id: string, version: number) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const row = yield* db_run(() => get_bundle_by_version.run(db, { account_id: account_id, version }));
    if (!row) return yield* Effect.fail(forbidden("no such bundle in this account"));
    // R2 holds the durable manifest object; the DB row carries the same
    // canonical bytes as fallback, so a missing object degrades instead of
    // breaking verification (the hash check still applies either way).
    const from_r2 = yield* get_blob(row.r2_key);
    const raw = from_r2 ?? new TextEncoder().encode(typeof row.manifest === "string" ? row.manifest : JSON.stringify(row.manifest));
    const raw_hash = yield* Effect.sync(() => sha256_hex(raw));
    if (raw_hash !== row.content_hash) return yield* Effect.fail(forbidden("manifest object mismatch"));
    // Legacy rows stored camel bytes: normalize to snake, re-encode
    // canonical snake bytes and recompute so the hash names bytes served.
    const parsed = yield* Schema.decodeUnknown(Schema.parseJson(Schema.Unknown))(new TextDecoder().decode(raw)).pipe(
      Effect.mapError(() => forbidden("manifest object mismatch")),
    );
    const stored = yield* Schema.decodeUnknown(StoredManifest)(parsed).pipe(
      Effect.mapError(() => forbidden("manifest object mismatch")),
    );
    const snake_manifest = is_manifest_resp(stored) ? stored : to_editor_manifest_resp(stored);
    const canonical = JSON.stringify(sort_keys(snake_manifest));
    const snake_bytes = new TextEncoder().encode(canonical);
    const content_hash = yield* Effect.sync(() => sha256_hex(canonical));
    return { bytes: snake_bytes, content_hash: content_hash };
  });

export const report_machine_state = (machine_id: string, account_id: string, opts: { bundle_id: string; status: "applied" | "failed"; detail?: string }) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    // Zero rows means the mutation's guards refused: either the machine or
    // bundle is unknown/revoked/cross-account, or the report regresses the
    // recorded version. Follow-up reads tell those apart honestly.
    const rows = yield* db_run(() =>
      upsert_machine_config_state.run(db, {
        machine_id: machine_id,
        bundle_id: opts.bundle_id,
        status: opts.status,
        detail: (opts.detail ?? "").slice(0, 500),
        account_id: account_id }),
    );
    const done = rows[0] ?? null;
    if (done) {
      yield* record(account_id, "config.state_reported", { machine_id });
      return { machine_id: done.machine_id, bundle_id: done.bundle_id, status: done.status, applied_at: done.applied_at };
    }
    const [state, bundle] = yield* Effect.all([
      db_run(() => get_machine_config_state.run(db, { machine_id: machine_id, account_id: account_id })),
      db_run(() => get_bundle_by_id.run(db, { id: opts.bundle_id, account_id: account_id })),
    ]);
    if (state && bundle && bundle.version < state.version) {
      return yield* Effect.fail(conflict("applied version regression"));
    }
    return yield* Effect.fail(forbidden("unknown machine or bundle in this account"));
  });

export const read_machine_state = (account_id: string, machine_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const row = yield* db_run(() => get_machine_config_state.run(db, { machine_id: machine_id, account_id: account_id }));
    if (!row) return yield* Effect.fail(forbidden("no such machine or state"));
    return {
      machine_id: row.machine_id,
      bundle_id: row.bundle_id,
      status: row.status,
      detail: row.detail,
      applied_at: row.applied_at,
      version: row.version,
      content_hash: row.content_hash };
  });
