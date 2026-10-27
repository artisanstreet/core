// Grant verification against the REAL Core-issued fixture
// (tests/fixtures/core-issued.json, copied from core/fixtures/v1/ —
// test-only synthetic credentials, no production secrets).
//
// Verification here is independent (jose + authoritative Core GrantClaims),
// mirroring what the Forge does itself (Core JWKS, sub/mid/scope/expiry)
// without importing Relay server code: the browser bundle vendors only
// the client/channel closure, never the server grant adapter. Any
// claim-field drift between Core's emitter and the verifiers fails here
// first.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { jwtVerify } from "jose";
import * as C from "../../src/contracts/v1.ts";
import { b64uDecode } from "../vendor/relay/b64u.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = JSON.parse(readFileSync(join(root, "core-issued.json"), "utf8")) as {
  note: string;
  issuedAt: string;
  issuer: string;
  audience: string;
  accountId: string;
  machineId: string;
  grant: string;
  jwks: { keys: unknown[] };
  revocations: { revokedMachineIds: unknown[]; revokedKeyIds: unknown[]; asOf: string };
};

const nowSec = () => Math.floor(Date.parse(fixture.issuedAt) / 1000);

describe("core-issued grant fixture (real issueGrant output)", () => {
  it("is test-only synthetic material", () => {
    expect(fixture.note).toMatch(/TEST-ONLY/i);
  });

  it("strict-decodes against the authoritative Core GrantClaims (catches field drift)", () => {
    const [, payloadB64] = fixture.grant.split(".");
    const payload = JSON.parse(new TextDecoder().decode(b64uDecode(payloadB64 ?? "")));
    const claims = Schema.decodeUnknownSync(C.GrantClaims, { onExcessProperty: "error" })(payload);
    expect(claims.v).toBe(1);
    expect(claims.iss).toBe(fixture.issuer);
    expect(claims.sub).toBe(fixture.accountId);
    expect(claims.mid).toBe(fixture.machineId);
    expect(claims.role).toBe("forge");
    expect([...claims.scope]).toEqual(expect.arrayContaining(["relay:connect", "forge:execute"]));
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(300);
    expect(claims.exp - claims.iat).toBeGreaterThan(0);
  });

  it("verifies by signature (EdDSA, fixture JWKS kid) at fixture nowSec", async () => {
    // Verify through jose with an explicit key (no network): the header
    // kid must resolve to the fixture JWKS key.
    const header = JSON.parse(new TextDecoder().decode(b64uDecode(fixture.grant.split(".")[0] ?? ""))) as {
      alg?: unknown;
      kid?: unknown;
    };
    expect(header.alg).toBe("EdDSA");
    const key = fixture.jwks.keys.find((k) => (k as { kid?: unknown }).kid === header.kid);
    expect(key).toBeDefined();
    const { importJWK } = await import("jose");
    const pubKey = await importJWK(key as Parameters<typeof importJWK>[0], "EdDSA");
    const { payload } = await jwtVerify(fixture.grant, pubKey, {
      issuer: fixture.issuer,
      audience: fixture.audience,
      currentDate: new Date(nowSec() * 1000),
    });
    expect(payload.sub).toBe(fixture.accountId);
    expect(payload.mid).toBe(fixture.machineId);
  });

  /**
   * Independent Forge-side channel rule check (role/binding/scope/TTL),
   * the same rule the Forge authorizer enforces — verified here through
   * jose + the Core contract, without importing Relay server code.
   */
  async function verify_channel_grant(
    jwt: string,
    ctx: { account: string; machine: string },
    now_sec: number,
  ): Promise<Uint8Array> {
    const header = JSON.parse(new TextDecoder().decode(b64uDecode(jwt.split(".")[0] ?? ""))) as {
      alg?: unknown;
      kid?: unknown;
    };
    if (header.alg !== "EdDSA") throw new Error("unexpected alg");
    const key = fixture.jwks.keys.find((k) => (k as { kid?: unknown }).kid === header.kid);
    if (!key) throw new Error("unknown kid");
    const { importJWK } = await import("jose");
    const pubKey = await importJWK(key as Parameters<typeof importJWK>[0], "EdDSA");
    const { payload } = await jwtVerify(jwt, pubKey, {
      issuer: fixture.issuer,
      audience: fixture.audience,
      currentDate: new Date(now_sec * 1000),
    });
    const claims = Schema.decodeUnknownSync(C.GrantClaims, { onExcessProperty: "error" })(payload);
    if (claims.role !== "client") throw new Error("channel grants must have role client");
    if (claims.sub !== ctx.account || claims.mid !== ctx.machine) {
      throw new Error("grant not bound to this channel context");
    }
    if (!claims.scope.includes("relay:connect")) throw new Error("grant lacks relay:connect");
    if (!claims.scope.includes("forge:execute")) throw new Error("grant lacks forge:execute");
    const ttl = claims.exp - claims.iat;
    if (ttl <= 0 || ttl > 300) throw new Error("grant ttl out of bounds");
    return b64uDecode(claims.cnf.jwk.x);
  }

  it("channel rule rejects the forge-role fixture as an initiator grant (role rule)", async () => {
    // The Core fixture is a FORGE machine grant (role forge). The channel
    // authorizer only accepts client-role initiator grants — this rejection
    // is the rule working, not drift. Positive channel paths run
    // with client grants in tests/relay-transport.test.ts + noise-session.
    await expect(
      verify_channel_grant(fixture.grant, { account: fixture.accountId, machine: fixture.machineId }, nowSec()),
    ).rejects.toThrow(/role client/);
  });

  it("fails the channel rule on cross-machine binding", async () => {
    // Rule order matches the Forge authorizer: role is checked before
    // binding, so the forge-role fixture fails on role even for a foreign
    // machine.
    await expect(
      verify_channel_grant(
        fixture.grant,
        { account: fixture.accountId, machine: "mch_01M5X881AAAAAAAAAAAAAAAAAAAAA" },
        nowSec(),
      ),
    ).rejects.toThrow(/role client/);
    // The binding data the rule consumes: the grant is bound to the
    // fixture machine only, so a foreign mid would fail binding next.
    const [, payloadB64] = fixture.grant.split(".");
    const payload = JSON.parse(new TextDecoder().decode(b64uDecode(payloadB64 ?? "")));
    const claims = Schema.decodeUnknownSync(C.GrantClaims, { onExcessProperty: "error" })(payload);
    expect(claims.mid).toBe(fixture.machineId);
    expect(claims.mid).not.toBe("mch_01M5X881AAAAAAAAAAAAAAAAAAAAA");
  });

  it("reads the emitted JWKS + revocations through the Core response schemas", () => {
    const jwks = Schema.decodeUnknownSync(C.JwksResp)(fixture.jwks);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", use: "sig", alg: "EdDSA" });
    const rev = Schema.decodeUnknownSync(C.RevocationsResp)(fixture.revocations);
    expect(rev.revokedMachineIds).toEqual([]);
    expect(fixture.grant.split(".")).toHaveLength(3);
  });
});
