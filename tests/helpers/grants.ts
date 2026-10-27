import { createLocalJWKSet as create_local_jwk_set, jwtVerify as jwt_verify } from "jose";
import type { setup_rig } from "./http.ts";

type Rig = Awaited<ReturnType<typeof setup_rig>>;

function check_claims(payload: Record<string, unknown>, alg: string | undefined) {
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
export async function verify_grant_with_artifact_jwks(
  token: string,
  jwks: unknown,
  issuer: string,
  audience: string,
  now_sec?: number,
) {
  const { payload, protectedHeader } = await jwt_verify(
    token,
    create_local_jwk_set(jwks as Parameters<typeof create_local_jwk_set>[0]),
    {
      issuer,
      audience,
      algorithms: ["EdDSA"],
      clockTolerance: 60,
      ...(now_sec !== undefined ? { currentDate: new Date(now_sec * 1000) } : {}) },
  );
  return check_claims(payload as Record<string, unknown>, protectedHeader.alg);
}

// Live variant: verifies a newly-issued token against the rig's CURRENT
// endpoint JWKS (fresh keys per run).
export async function verify_grant_with_key_id(rig: Rig, token: string, issuer: string, audience: string) {
  const jwks_res = await (rig.app as unknown as { request(p: string): Promise<Response> }).request("/.well-known/jwks.json");
  const jwks = (await jwks_res.json()) as unknown;
  return verify_grant_with_artifact_jwks(token, jwks, issuer, audience);
}
