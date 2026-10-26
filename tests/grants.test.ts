import { describe, expect, it } from "vitest";
import { importJWK, jwtVerify, createLocalJWKSet } from "jose";
import { admin, api, enrollMachine, machineHeaders, newMachineKeys, setupRig, signup, type MachineKeys } from "./helpers.js";

type Rig = Awaited<ReturnType<typeof setupRig>>;

async function issueAsMachine(rig: Rig, machineId: string, keys: MachineKeys, body: unknown) {
  const raw = JSON.stringify(body);
  return api(rig.app, "POST", "/v1/grants/issue", {
    headers: await machineHeaders(machineId, keys, "POST", "/v1/grants/issue", raw),
    rawBody: raw,
  });
}

describe("grants", () => {
  it("machine grants bind the enrolled key; session grants bind target + ephemeral cnf", async () => {
    const rig = await setupRig();
    const acct = await signup(rig, "g@example.com");
    const { machineId, keys } = await enrollMachine(rig, { cookie: acct.cookie }, "forge-g");

    // Machine path: cnf defaults to the enrolled key, aud ast-core sync.
    const sync = await issueAsMachine(rig, machineId, keys, { audience: "ast-core", scope: ["machine:sync"] });
    expect(sync.status).toBe(200);
    const syncToken = (sync.json as { token: string }).token;

    // ast-core rejects relay scopes.
    const badAud = await issueAsMachine(rig, machineId, keys, { audience: "ast-core", scope: ["relay:connect"] });
    expect(badAud.status).toBe(400);

    // TTL is capped at 300 s.
    const badTtl = await issueAsMachine(rig, machineId, keys, { audience: "ast-relay", scope: ["relay:connect"], ttlSeconds: 301 });
    expect(badTtl.status).toBe(400);

    // Editor path: explicit target machine + ephemeral cnf key.
    const eph = await newMachineKeys();
    const grant = await api(rig.app, "POST", "/v1/grants/issue", {
      headers: { cookie: acct.cookie, origin: "http://localhost" },
      body: { audience: "ast-relay", scope: ["relay:connect", "forge:execute"], targetMachineId: machineId, cnf: { kty: "OKP", crv: "Ed25519", x: eph.publicX } },
    });
    expect(grant.status).toBe(200);
    const editorToken = (grant.json as { token: string }).token;

    // Missing target/cnf is rejected.
    const noTarget = await api(rig.app, "POST", "/v1/grants/issue", {
      headers: { cookie: acct.cookie, origin: "http://localhost" },
      body: { audience: "ast-relay", scope: ["relay:connect"] },
    });
    expect(noTarget.status).toBe(400);

    // Verify both tokens against the served JWKS, exactly like Relay does.
    const jwksRes = await api(rig.app, "GET", "/.well-known/jwks.json");
    expect(jwksRes.status).toBe(200);
    const jwks = jwksRes.json as Parameters<typeof createLocalJWKSet>[0];
    for (const [token, audience, role, mid] of [
      [syncToken, "ast-core", "forge", machineId],
      [editorToken, "ast-relay", "client", machineId],
    ] as const) {
      const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks), {
        issuer: "http://test.invalid",
        audience,
        algorithms: ["EdDSA"],
        clockTolerance: 60,
      });
      expect(protectedHeader.alg).toBe("EdDSA");
      const p = payload as Record<string, unknown>;
      expect(p.v).toBe(1);
      expect(p.sub).toBe(acct.accountId);
      expect(p.mid).toBe(mid);
      expect(p.role).toBe(role);
      expect((p.exp as number) - (p.iat as number)).toBeLessThanOrEqual(300);
      expect(p.cnf).toBeDefined();
    }

    // Unknown target machine is refused (account scope enforced).
    const other = await api(rig.app, "POST", "/v1/grants/issue", {
      headers: { cookie: acct.cookie, origin: "http://localhost" },
      body: { audience: "ast-relay", scope: ["relay:connect"], targetMachineId: "mch_AAAAAAAAAAAAAAAAAAAAAAAAAA", cnf: { kty: "OKP", crv: "Ed25519", x: eph.publicX } },
    });
    expect(other.status).toBe(403);

    // Revocation list reflects revoked machines and retired keys.
    const rev = await api(rig.app, "POST", `/v1/machines/${machineId}/revoke`, {
      headers: { cookie: acct.cookie, origin: "http://localhost" },
    });
    expect(rev.status).toBe(200);
    const rot = await api(rig.app, "POST", "/v1/admin/keys/rotate", { headers: admin });
    expect(rot.status).toBe(200);
    const list = await api(rig.app, "GET", "/v1/grants/revocations");
    expect(list.status).toBe(200);
    const lj = list.json as { revokedMachineIds: string[]; revokedKeyIds: string[] };
    expect(lj.revokedMachineIds).toContain(machineId);
    expect(lj.revokedKeyIds.length).toBeGreaterThan(0);

    // Admin endpoints hide without the token.
    const noAuth = await api(rig.app, "POST", "/v1/admin/keys/rotate", {});
    expect(noAuth.status).toBe(404);
  });
});
