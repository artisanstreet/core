import { describe, expect, it } from "vitest";
import { api, b64url, enroll_machine, machine_headers, setup_rig, sha256_hex_str, signup } from "../../../helpers/http.ts";

const ORIGIN = { origin: "http://localhost" };

describe("provider vault", () => {
  it("stores encrypted keys and releases only to assigned live machines", async () => {
    const rig = await setup_rig();
    const acct = await signup(rig, "v@example.com");
    const cookie = { cookie: acct.cookie, ...ORIGIN };
    const { machine_id, keys } = await enroll_machine(rig, { cookie: acct.cookie }, "forge-v");
    const other = await signup(rig, "w@example.com");
    const { machine_id: other_machine } = await enroll_machine(rig, { cookie: other.cookie }, "forge-w");

    const created = await api(rig.app, "POST", "/v1/vault/connections", {
      headers: cookie,
      body: { provider: "anthropic", label: "main", apiKey: "sk-ant-test-secret-value" } });
    expect(created.status).toBe(201);
    const connId = (created.json as { id: string }).id;

    // Listing never exposes secrets.
    const list = await api(rig.app, "GET", "/v1/vault/connections", { headers: { cookie: acct.cookie } });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.json)).not.toContain("sk-ant-test-secret-value");

    // Unassigned machine is refused before any crypto happens.
    const credPath = (id: string) => `/v1/vault/credentials?connectionId=${id}`;
    const denied = await api(rig.app, "GET", credPath(connId), {
      headers: await machine_headers(machine_id, keys, "GET", credPath(connId), "") });
    expect(denied.status).toBe(403);

    // Cross-account assignment binds nothing.
    const cross = await api(rig.app, "POST", "/v1/vault/assignments", {
      headers: { cookie: other.cookie, ...ORIGIN },
      body: { connectionId: connId, machineId: other_machine } });
    expect(cross.status).toBe(403);

    const assign = await api(rig.app, "POST", "/v1/vault/assignments", {
      headers: cookie,
      body: { connectionId: connId, machineId: machine_id } });
    expect(assign.status).toBe(200);

    const rel = await api(rig.app, "GET", credPath(connId), {
      headers: await machine_headers(machine_id, keys, "GET", credPath(connId), "") });
    expect(rel.status).toBe(200);
    expect(rel.json).toEqual({ provider: "anthropic", secret: "sk-ant-test-secret-value" });

    // Revoked connection stops releasing.
    const rev = await api(rig.app, "POST", `/v1/vault/connections/${connId}/revoke`, { headers: cookie });
    expect(rev.status).toBe(200);
    const after = await api(rig.app, "GET", credPath(connId), {
      headers: await machine_headers(machine_id, keys, "GET", credPath(connId), "") });
    expect(after.status).toBe(403);
  });
});

describe("engine artifacts", () => {
  it("validates envelope shape; opaque bytes round-trip only to assigned machines", async () => {
    const rig = await setup_rig();
    const acct = await signup(rig, "x@example.com");
    const cookie = { cookie: acct.cookie, ...ORIGIN };
    const { machine_id, keys } = await enroll_machine(rig, { cookie: acct.cookie }, "forge-x");
    const other = await signup(rig, "y@example.com");
    const { machine_id: other_machine, keys: other_keys } = await enroll_machine(rig, { cookie: other.cookie }, "forge-y");

    const raw = JSON.stringify({ oauth: "redacted-synthetic-token" });
    const bytes = new TextEncoder().encode(raw);
    const good = {
      format: "ast-engine-credential/1",
      engine: "claude",
      kind: "oauth",
      exportedAt: new Date().toISOString(),
      expiresAt: null,
      files: [{ path: "claude.json", mode: "0600", sha256: await sha256_hex_str(bytes), contentBase64: b64url(bytes) }] };

    // Shape violations.
    for (const bad of [
      { ...good, engine: "cursor" },
      { ...good, files: [] },
      { ...good, files: [{ ...good.files[0]!, path: "../escape.json" }] },
      { ...good, files: [{ ...good.files[0]!, sha256: "0".repeat(64) }] },
      { ...good, files: [{ ...good.files[0]!, mode: "0644" }] },
      { ...good, extra: "unknown-field" },
    ]) {
      const r = await api(rig.app, "POST", "/v1/engine-artifacts", { headers: cookie, body: { label: "t", envelope: bad } });
      expect(r.status).toBe(400);
    }
    const created = await api(rig.app, "POST", "/v1/engine-artifacts", { headers: cookie, body: { label: "claude-sub", envelope: good } });
    expect(created.status).toBe(201);
    const artId = (created.json as { id: string }).id;

    // Metadata listings never include envelope bytes.
    const list = await api(rig.app, "GET", "/v1/engine-artifacts", { headers: { cookie: acct.cookie } });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.json)).not.toContain("redacted-synthetic-token");

    const dlPath = (id: string) => `/v1/engine-artifacts/${id}/download`;
    const denied = await api(rig.app, "GET", dlPath(artId), {
      headers: await machine_headers(machine_id, keys, "GET", dlPath(artId), "") });
    expect(denied.status).toBe(403);

    // Cross-account assignment binds nothing.
    const cross = await api(rig.app, "POST", "/v1/engine-artifacts/assignments", {
      headers: { cookie: other.cookie, ...ORIGIN },
      body: { artifactId: artId, machineId: other_machine } });
    expect(cross.status).toBe(403);

    const assign = await api(rig.app, "POST", "/v1/engine-artifacts/assignments", {
      headers: cookie,
      body: { artifactId: artId, machineId: machine_id } });
    expect(assign.status).toBe(200);

    // Other account's machine cannot download even with its own valid proof.
    const crossDl = await api(rig.app, "GET", dlPath(artId), {
      headers: await machine_headers(other_machine, other_keys, "GET", dlPath(artId), "") });
    expect(crossDl.status).toBe(403);

    const dl = await api(rig.app, "GET", dlPath(artId), {
      headers: await machine_headers(machine_id, keys, "GET", dlPath(artId), "") });
    expect(dl.status).toBe(200);
    expect(dl.json).toEqual({
      envelope: {
        format: good.format,
        engine: good.engine,
        kind: good.kind,
        exported_at: good.exportedAt,
        expires_at: good.expiresAt,
        files: [
          {
            path: good.files[0]!.path,
            mode: good.files[0]!.mode,
            sha256: good.files[0]!.sha256,
            content_base64: good.files[0]!.contentBase64,
          },
        ],
      },
    });
  });
});

describe("machine discovery for sync", () => {
  it("machines list only their own assigned metadata, never secrets", async () => {
    const rig = await setup_rig();
    const acct = await signup(rig, "sync@example.com");
    const cookie = { cookie: acct.cookie, origin: "http://localhost" };
    const { machine_id: m1, keys: k1 } = await enroll_machine(rig, { cookie: acct.cookie }, "sync-1");
    const { machine_id: m2, keys: k2 } = await enroll_machine(rig, { cookie: acct.cookie }, "sync-2");

    const conn = await api(rig.app, "POST", "/v1/vault/connections", {
      headers: cookie,
      body: { provider: "openai", label: "k", apiKey: "sk-test-sync-12345678" } });
    const connId = (conn.json as { id: string }).id;
    await api(rig.app, "POST", "/v1/vault/assignments", { headers: cookie, body: { connectionId: connId, machineId: m1 } });

    const raw = JSON.stringify({ oauth: "redacted-synthetic-token" });
    const bytes = new TextEncoder().encode(raw);
    const art = await api(rig.app, "POST", "/v1/engine-artifacts", {
      headers: cookie,
      body: {
        label: "codex-sub",
        envelope: {
          format: "ast-engine-credential/1",
          engine: "codex",
          kind: "oauth",
          exportedAt: new Date().toISOString(),
          expiresAt: null,
          files: [{ path: "auth.json", mode: "0600", sha256: await sha256_hex_str(bytes), contentBase64: b64url(bytes) }] } } });
    const artId = (art.json as { id: string }).id;
    await api(rig.app, "POST", "/v1/engine-artifacts/assignments", { headers: cookie, body: { artifactId: artId, machineId: m1 } });

    const cpath = "/v1/vault/connections";
    const m1c = await api(rig.app, "GET", cpath, { headers: await machine_headers(m1, k1, "GET", cpath, "") });
    expect(m1c.status).toBe(200);
    const m1conns = (m1c.json as { connections: Array<{ id: string; assigned_machine_ids: string[] }> }).connections;
    expect(m1conns.map((c) => c.id)).toEqual([connId]);
    expect(m1conns[0]!.assigned_machine_ids).toEqual([m1]);
    expect(JSON.stringify(m1c.json)).not.toContain("sk-test-sync");

    const m2c = await api(rig.app, "GET", cpath, { headers: await machine_headers(m2, k2, "GET", cpath, "") });
    expect(m2c.status).toBe(200);
    expect((m2c.json as { connections: unknown[] }).connections).toEqual([]);

    const apath = "/v1/engine-artifacts";
    const m1a = await api(rig.app, "GET", apath, { headers: await machine_headers(m1, k1, "GET", apath, "") });
    expect(m1a.status).toBe(200);
    const m1arts = (m1a.json as { artifacts: Array<{ id: string; assigned_machine_ids: string[] }> }).artifacts;
    expect(m1arts.map((a) => a.id)).toEqual([artId]);
    expect(m1arts[0]!.assigned_machine_ids).toEqual([m1]);
    expect(JSON.stringify(m1a.json)).not.toContain("redacted-synthetic");

    const m2a = await api(rig.app, "GET", apath, { headers: await machine_headers(m2, k2, "GET", apath, "") });
    expect(m2a.status).toBe(200);
    expect((m2a.json as { artifacts: unknown[] }).artifacts).toEqual([]);
  });
});
