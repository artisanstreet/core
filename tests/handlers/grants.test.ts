import { describe, expect, it } from "vitest";
import { importJWK as import_jwk, jwtVerify as jwt_verify, createLocalJWKSet as create_local_jwk_set } from "jose";
import { admin, api, enroll_machine, machine_headers, new_machine_keys, setup_rig, signup, type MachineKeys } from "../helpers/http.ts";

type Rig = Awaited<ReturnType<typeof setup_rig>>;

async function issue_as_machine(rig: Rig, machine_id: string, keys: MachineKeys, body: unknown) {
  const raw = JSON.stringify(body);
  return api(rig.app, "POST", "/v1/grants/issue", {
    headers: await machine_headers(machine_id, keys, "POST", "/v1/grants/issue", raw),
    raw_body: raw });
}

describe("grants", () => {
  it("machine grants bind the enrolled key; session grants bind target + ephemeral cnf", async () => {
    const rig = await setup_rig();
    const acct = await signup(rig, "g@example.com");
    const { machine_id, keys } = await enroll_machine(rig, { cookie: acct.cookie }, "forge-g");

    // Machine path: cnf defaults to the enrolled key, aud ast-core sync.
    const sync = await issue_as_machine(rig, machine_id, keys, { audience: "ast-core", scope: ["machine:sync"] });
    expect(sync.status).toBe(200);
    const syncToken = (sync.json as { token: string }).token;

    // ast-core rejects relay scopes.
    const badAud = await issue_as_machine(rig, machine_id, keys, { audience: "ast-core", scope: ["relay:connect"] });
    expect(badAud.status).toBe(400);

    // TTL is capped at 300 s.
    const badTtl = await issue_as_machine(rig, machine_id, keys, { audience: "ast-relay", scope: ["relay:connect"], ttlSeconds: 301 });
    expect(badTtl.status).toBe(400);

    // Editor path: explicit target machine + ephemeral cnf key.
    const eph = await new_machine_keys();
    const grant = await api(rig.app, "POST", "/v1/grants/issue", {
      headers: { cookie: acct.cookie, origin: "http://localhost" },
      body: { audience: "ast-relay", scope: ["relay:connect", "forge:execute"], targetMachineId: machine_id, cnf: { kty: "OKP", crv: "Ed25519", x: eph.public_x } } });
    expect(grant.status).toBe(200);
    const editorToken = (grant.json as { token: string }).token;

    // Missing target/cnf is rejected.
    const noTarget = await api(rig.app, "POST", "/v1/grants/issue", {
      headers: { cookie: acct.cookie, origin: "http://localhost" },
      body: { audience: "ast-relay", scope: ["relay:connect"] } });
    expect(noTarget.status).toBe(400);

    // Verify both tokens against the served JWKS, exactly like Relay does.
    const jwksRes = await api(rig.app, "GET", "/.well-known/jwks.json");
    expect(jwksRes.status).toBe(200);
    const jwks = jwksRes.json as Parameters<typeof create_local_jwk_set>[0];
    for (const [token, audience, role, mid] of [
      [syncToken, "ast-core", "forge", machine_id],
      [editorToken, "ast-relay", "client", machine_id],
    ] as const) {
      const { payload, protectedHeader } = await jwt_verify(token, create_local_jwk_set(jwks), {
        issuer: "http://test.invalid",
        audience,
        algorithms: ["EdDSA"],
        clockTolerance: 60 });
      expect(protectedHeader.alg).toBe("EdDSA");
      const p = payload as Record<string, unknown>;
      expect(p.v).toBe(1);
      expect(p.sub).toBe(acct.account_id);
      expect(p.mid).toBe(mid);
      expect(p.role).toBe(role);
      expect((p.exp as number) - (p.iat as number)).toBeLessThanOrEqual(300);
      expect(p.cnf).toBeDefined();
    }

    // Unknown target machine is refused (account scope enforced).
    const other = await api(rig.app, "POST", "/v1/grants/issue", {
      headers: { cookie: acct.cookie, origin: "http://localhost" },
      body: { audience: "ast-relay", scope: ["relay:connect"], targetMachineId: "mch_AAAAAAAAAAAAAAAAAAAAAAAAAA", cnf: { kty: "OKP", crv: "Ed25519", x: eph.public_x } } });
    expect(other.status).toBe(403);

    // Revocation list reflects revoked machines and retired keys.
    const rev = await api(rig.app, "POST", `/v1/machines/${machine_id}/revoke`, {
      headers: { cookie: acct.cookie, origin: "http://localhost" } });
    expect(rev.status).toBe(200);
    const rot = await api(rig.app, "POST", "/v1/admin/keys/rotate", { headers: admin });
    expect(rot.status).toBe(200);
    const list = await api(rig.app, "GET", "/v1/grants/revocations");
    expect(list.status).toBe(200);
    const lj = list.json as { revoked_machine_ids: string[]; revoked_key_ids: string[] };
    expect(lj.revoked_machine_ids).toContain(machine_id);
    expect(lj.revoked_key_ids.length).toBeGreaterThan(0);

    // Admin endpoints hide without the token.
    const noAuth = await api(rig.app, "POST", "/v1/admin/keys/rotate", {});
    expect(noAuth.status).toBe(404);
  });
});
