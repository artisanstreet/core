import { describe, expect, it } from "vitest";
import { api, b64url, enrollMachine, machineHeaders, setupRig, sha256HexStr, signup } from "./helpers.js";

const ORIGIN = { origin: "http://localhost" };
const manifest = {
  format: "ast-editor-config/1",
  mcpServers: [{ name: "x", command: "x" }],
  skills: [{ name: "s", source: "local" }],
  globalPrompt: "be good",
};

describe("editor config bundles", () => {
  it("publishes versioned content-hashed bundles; machines report revisions without regression", async () => {
    const rig = await setupRig();
    const acct = await signup(rig, "cfg@example.com");
    const cookie = { cookie: acct.cookie, ...ORIGIN };
    const { machineId, keys } = await enrollMachine(rig, { cookie: acct.cookie }, "forge-cfg");

    const p1 = await api(rig.app, "POST", "/v1/config/bundles", { headers: cookie, body: { manifest } });
    expect(p1.status).toBe(201);
    const b1 = p1.json as { id: string; version: number; contentHash: string; r2Key: string };
    expect(b1.version).toBe(1);
    expect(b1.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // Identical content dedups instead of minting a duplicate revision.
    const p1b = await api(rig.app, "POST", "/v1/config/bundles", { headers: cookie, body: { manifest } });
    expect(p1b.status).toBe(201);
    expect((p1b.json as { version: number }).version).toBe(1);

    const p2 = await api(rig.app, "POST", "/v1/config/bundles", {
      headers: cookie,
      body: { manifest: { ...manifest, globalPrompt: "be great" } },
    });
    expect(p2.status).toBe(201);
    const b2 = p2.json as { id: string; version: number; contentHash: string };
    expect(b2.version).toBe(2);

    // Latest serves the manifest for sync.
    const latestPath = "/v1/config/bundles/latest";
    const latest = await api(rig.app, "GET", latestPath, {
      headers: await machineHeaders(machineId, keys, "GET", latestPath, ""),
    });
    expect(latest.status).toBe(200);
    expect((latest.json as { bundle: { version: number } }).bundle.version).toBe(2);

    // Manifest bytes come from R2, hash-verified, immutable + private.
    const mpath = `/v1/config/bundles/2/manifest`;
    const mbytes = await api(rig.app, "GET", mpath, {
      headers: await machineHeaders(machineId, keys, "GET", mpath, ""),
    });
    expect(mbytes.status).toBe(200);
    expect(mbytes.headers.get("x-content-sha256")).toBe(b2.contentHash);
    expect(mbytes.headers.get("etag")).toBe(`"${b2.contentHash}"`);
    expect(mbytes.headers.get("cache-control")).toContain("immutable");
    expect(mbytes.headers.get("cache-control")).toContain("private");
    expect(mbytes.headers.get("cache-control")).not.toContain("public");

    // Checksum-based invalidation: unchanged hash → 304, changed → 200.
    const h1 = await api(rig.app, "GET", latestPath, {
      headers: { ...(await machineHeaders(machineId, keys, "GET", latestPath, "")), "if-none-match": `"${b2.contentHash}"` },
    });
    expect(h1.status).toBe(304);
    expect(h1.headers.get("etag")).toBe(`"${b2.contentHash}"`);
    expect(h1.text).toBe("");

    const p3 = await api(rig.app, "POST", "/v1/config/bundles", {
      headers: cookie,
      body: { manifest: { ...manifest, skills: [{ name: "t", source: "local" }] } },
    });
    expect(p3.status).toBe(201);
    const b3 = p3.json as { contentHash: string };
    const h2 = await api(rig.app, "GET", latestPath, {
      headers: { ...(await machineHeaders(machineId, keys, "GET", latestPath, "")), "if-none-match": `"${b2.contentHash}"` },
    });
    expect(h2.status).toBe(200);
    expect(h2.headers.get("etag")).toBe(`"${b3.contentHash}"`);

    // Manifest blob revalidates too.
    const m304 = await api(rig.app, "GET", mpath, {
      headers: { ...(await machineHeaders(machineId, keys, "GET", mpath, "")), "if-none-match": `"${b2.contentHash}"` },
    });
    expect(m304.status).toBe(304);

    // Authentication runs before conditional evaluation: bad auth + a
    // matching tag is still a 401, never a 304.
    const unauth = await api(rig.app, "GET", latestPath, {
      headers: { authorization: "Bearer ast_sess_nope", "if-none-match": `"${b3.contentHash}"` },
    });
    expect(unauth.status).toBe(401);

    // Machine reports the applied revision.
    const rpath = "/v1/config/state";
    const rbody = JSON.stringify({ bundleId: b2.id, status: "applied" });
    const rep = await api(rig.app, "POST", rpath, {
      headers: await machineHeaders(machineId, keys, "POST", rpath, rbody),
      rawBody: rbody,
    });
    expect(rep.status).toBe(200);

    // Reordered/replayed reports cannot regress the revision.
    const rold = JSON.stringify({ bundleId: b1.id, status: "applied" });
    const reg = await api(rig.app, "POST", rpath, {
      headers: await machineHeaders(machineId, keys, "POST", rpath, rold),
      rawBody: rold,
    });
    expect(reg.status).toBe(409);

    // Bundle with an embedded skill installs onto new machines.
    const skillMd = "# Test Skill\n\nA bundled skill.\n";
    const skillBytes = new TextEncoder().encode(skillMd);
    const withSkill = {
      ...manifest,
      skills: [
        {
          name: "bundled",
          source: "builtin",
          bundle: {
            files: [{ path: "SKILL.md", contentBase64: b64url(skillBytes), sha256: await sha256HexStr(skillBytes) }],
          },
        },
      ],
    };
    const pb = await api(rig.app, "POST", "/v1/config/bundles", { headers: cookie, body: { manifest: withSkill } });
    expect(pb.status).toBe(201);
    const latest2 = await api(rig.app, "GET", latestPath, {
      headers: await machineHeaders(machineId, keys, "GET", latestPath, ""),
    });
    const got = (latest2.json as { manifest: { skills: Array<{ name: string; bundle: { files: Array<{ path: string }> } }> } }).manifest;
    expect(got.skills.find((s) => s.name === "bundled")?.bundle.files.map((f) => f.path)).toEqual(["SKILL.md"]);

    // Invalid bundles are rejected: no SKILL.md, escaping path, hash mismatch.
    const badSkillMd = await sha256HexStr(skillBytes);
    for (const files of [
      [{ path: "notes.md", contentBase64: b64url(skillBytes), sha256: badSkillMd }],
      [{ path: "../evil.md", contentBase64: b64url(skillBytes), sha256: badSkillMd }],
      [{ path: "SKILL.md", contentBase64: b64url(skillBytes), sha256: "0".repeat(64) }],
    ]) {
      const bad = await api(rig.app, "POST", "/v1/config/bundles", {
        headers: cookie,
        body: { manifest: { ...manifest, skills: [{ name: "bad", source: "x", bundle: { files } }] } },
      });
      expect(bad.status).toBe(400);
    }

    // Unknown bundles and cross-account machines are refused, not regressed.
    const rbogus = JSON.stringify({ bundleId: "bundle_AAAAAAAAAAAAAAAAAAAAAAAAAA", status: "applied" });
    const bogus = await api(rig.app, "POST", rpath, {
      headers: await machineHeaders(machineId, keys, "POST", rpath, rbogus),
      rawBody: rbogus,
    });
    expect(bogus.status).toBe(403);

    const other = await signup(rig, "cfg2@example.com");
    const { machineId: m2, keys: k2 } = await enrollMachine(rig, { cookie: other.cookie }, "forge-cfg2");
    const rcross = JSON.stringify({ bundleId: b2.id, status: "applied" });
    const cross = await api(rig.app, "POST", rpath, {
      headers: await machineHeaders(m2, k2, "POST", rpath, rcross),
      rawBody: rcross,
    });
    expect(cross.status).toBe(403);
    void machineId;
  });
});
