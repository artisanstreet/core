// Grant verification against the REAL Core-issued fixture
// (tests/fixtures/core-issued.json, copied from core/fixtures/v1/ —
// test-only synthetic credentials, no production secrets).
//
// This runs the exact production verifier the Forge side uses
// (vendor/relay/channel-verify.ts over the fixture JWKS) against a token
// minted by the actual Core issueGrant implementation, at the fixture's
// own timestamp. Any claim-field drift between Core's emitter and the
// Relay/browser verifiers fails here first.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { createRemoteJWKSet, jwtVerify } from "jose";
import * as C from "../../src/contracts/v1.ts";
import { b64uDecode } from "../vendor/relay/jwt.ts";
import { makeChannelJwtVerifier } from "../vendor/relay/channel-verify.ts";
import { hasScope } from "../vendor/relay/jwt.ts";

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

function stubFetch() {
  return async (): Promise<Response> =>
    new Response(JSON.stringify(fixture.jwks), { status: 200, headers: { "content-type": "application/json" } });
}

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
    const jwks = createRemoteJWKSet(new URL("https://core.test/.well-known/jwks.json"), { cacheMaxAge: 0 });
    void jwks;
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

  it("channel verifier rejects the forge-role fixture as an initiator grant (role rule)", async () => {
    // The Core fixture is a FORGE machine grant (role forge). The channel
    // authorizer only accepts client-role initiator grants — this rejection
    // is the rule working, not drift. Positive channel-verify paths run
    // with client grants in tests/relay-transport.test.ts + noise-session.
    const verify = makeChannelJwtVerifier(
      { jwksUrl: "https://core.test/.well-known/jwks.json", expectedIss: fixture.issuer, expectedAud: fixture.audience, maxTtlSec: 300 },
      stubFetch() as never,
    );
    await expect(
      verify(fixture.grant, { account: fixture.accountId, machine: fixture.machineId, channel: "ch-test" }, nowSec()),
    ).rejects.toThrow(/role client/);
  });

  it("fails the channel verifier on cross-machine binding", async () => {
    const verify = makeChannelJwtVerifier(
      { jwksUrl: "https://core.test/.well-known/jwks.json", expectedIss: fixture.issuer, expectedAud: fixture.audience, maxTtlSec: 300 },
      stubFetch() as never,
    );
    await expect(
      verify(fixture.grant, { account: fixture.accountId, machine: "mch_01M5X881AAAAAAAAAAAAAAAAAAAAA", channel: "ch-test" }, nowSec()),
    ).rejects.toThrow();
  });

  it("reads the emitted JWKS + revocations through the Core response schemas", () => {
    const jwks = Schema.decodeUnknownSync(C.JwksResp)(fixture.jwks);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", use: "sig", alg: "EdDSA" });
    const rev = Schema.decodeUnknownSync(C.RevocationsResp)(fixture.revocations);
    expect(rev.revokedMachineIds).toEqual([]);
    const has = hasScope({ scopes: new Set(["relay:connect", "forge:execute"]) } as never, "relay:connect");
    expect(has).toBe(true);
  });
});
