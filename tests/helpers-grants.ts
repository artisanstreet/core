import { createLocalJWKSet, jwtVerify } from "jose";
import type { setupRig } from "./helpers.js";

type Rig = Awaited<ReturnType<typeof setupRig>>;

function checkClaims(payload: Record<string, unknown>, alg: string | undefined) {
  if (alg !== "EdDSA") throw new Error("bad alg");
  if (payload.v !== 1) throw new Error("bad v");
  if (typeof payload.sub !== "string" || typeof payload.mid !== "string") throw new Error("bad sub/mid");
  if (payload.role !== "forge" && payload.role !== "client") throw new Error("bad role");
  return payload as { sub: string; mid: string; role: string; scope: string[]; cnf: unknown; exp: number; iat: number };
}

// Mirror of what Relay/Forge implement independently
// (JWKS + iss/aud/exp + v/role/mid/scope; key binding is the transport's
// transcript check). Verifies a token against an explicit artifact JWKS.
// Pass nowSec to verify a stored artifact at ITS OWN time (committed
// fixtures have short TTLs and naturally expire on the wall clock);
// omit it for live tokens verified against the wall clock.
export async function verifyGrantWithArtifactJwks(
  token: string,
  jwks: unknown,
  issuer: string,
  audience: string,
  nowSec?: number,
) {
  const { payload, protectedHeader } = await jwtVerify(
    token,
    createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]),
    {
      issuer,
      audience,
      algorithms: ["EdDSA"],
      clockTolerance: 60,
      ...(nowSec !== undefined ? { currentDate: new Date(nowSec * 1000) } : {}),
    },
  );
  return checkClaims(payload as Record<string, unknown>, protectedHeader.alg);
}

// Live variant: verifies a newly-issued token against the rig's CURRENT
// endpoint JWKS (fresh keys per run).
export async function verifyGrantWithKeyId(rig: Rig, token: string, issuer: string, audience: string) {
  const jwksRes = await (rig.app as unknown as { request(p: string): Promise<Response> }).request("/.well-known/jwks.json");
  const jwks = (await jwksRes.json()) as unknown;
  return verifyGrantWithArtifactJwks(token, jwks, issuer, audience);
}
