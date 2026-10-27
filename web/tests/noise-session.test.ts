// End-to-end through the exact classes the Forge view uses: vendored
// SecureChannel (Noise XX + JWT-in-confirm) with a memory pipe, then a
// chunked TunnelRequest/TunnelResponse exchange through the open channel.
// Grants here are self-minted for the loopback (the production verifier
// path against a real Core token is covered in grant-fixture.test.ts).

import { describe, expect, it } from "vitest";
import { importJWK, SignJWT, jwtVerify } from "jose";
import { ed25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { SecureChannel } from "../vendor/relay/client.ts";
import { b64u_decode, b64u_encode } from "../vendor/relay/b64u.ts";
import { static_keypair_from_secret } from "../vendor/relay/channel.ts";
import type { VerifyChannelJwt } from "../vendor/relay/channel.ts";
import {
  ChunkReassembly,
  chunk_bytes,
  decode_tunnel_response,
  encode_tunnel_request,
  is_chunk_frame,
} from "../src/forge.ts";

const CTX = { account: "acct1", machine: "forge1", channel: "app-test" };

async function mint_self_grant(opts: { account: string; machine: string; scope: string[]; cnf_pk: Uint8Array; core_sk: Uint8Array; iss?: string; aud?: string }): Promise<string> {
  const key = await importJWK({ kty: "OKP", crv: "Ed25519", d: b64u_encode(opts.core_sk), x: b64u_encode(ed25519.getPublicKey(opts.core_sk)) }, "EdDSA");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    v: 1,
    sub: opts.account,
    mid: opts.machine,
    role: "client",
    scope: opts.scope,
    cnf: { jwk: { kty: "OKP", crv: "Ed25519", x: b64u_encode(opts.cnf_pk) } },
    jti: "test-jti-1",
  })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: "test-1" })
    .setIssuer(opts.iss ?? "https://core.test")
    .setAudience(opts.aud ?? "ast-relay")
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 120)
    .sign(key);
}

function make_verifier(core_pk: Uint8Array): VerifyChannelJwt {
  return async (jwt: string, ctx) => {
    const key = await importJWK({ kty: "OKP", crv: "Ed25519", x: b64u_encode(core_pk) }, "EdDSA");
    const { payload } = await jwtVerify(jwt, key, { issuer: "https://core.test", audience: "ast-relay" });
    if (payload.sub !== ctx.account || payload.mid !== ctx.machine) throw new Error("grant not bound to this channel context");
    if (!(payload.scope as string[]).includes("relay:connect")) throw new Error("grant lacks relay:connect");
    const cnf = payload.cnf as { jwk: { x: string } };
    const pk = b64u_decode(cnf.jwk.x);
    if (pk.length !== 32) throw new Error("bad cnf");
    return pk;
  };
}

/** The confirm path verifies a JWT asynchronously; poll with a real deadline. */
async function wait_phase(ch: { get_phase(): string }, want: string, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const got = ch.get_phase();
    if (got === want) return;
    if (got === "closed") throw new Error(`${label}: session closed while waiting for ${want}`);
    if (Date.now() > deadline) throw new Error(`${label}: timed out waiting for ${want}, stuck at ${got}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("browser Noise session (vendored SecureChannel)", () => {
  it("opens with mutual JWT identity binding, then carries a chunked tunnel call", async () => {
    const core_sk = ed25519.utils.randomSecretKey();
    const core_pk = ed25519.getPublicKey(core_sk);
    const forge_sk = ed25519.utils.randomSecretKey();
    const forge_pk = ed25519.getPublicKey(forge_sk);
    const editor_cnf_sk = ed25519.utils.randomSecretKey();
    const editor_cnf_pk = ed25519.getPublicKey(editor_cnf_sk);
    const jwt = await mint_self_grant({ account: CTX.account, machine: CTX.machine, scope: ["relay:connect", "forge:execute"], cnf_pk: editor_cnf_pk, core_sk });

    const init = SecureChannel.initiate(static_keypair_from_secret(randomBytes(32)), {
      cnf_sign_key: editor_cnf_sk,
      expected_forge_cnf: forge_pk,
      own_grant_jwt: jwt,
      ctx: CTX,
    });
    const resp = SecureChannel.accept(static_keypair_from_secret(randomBytes(32)), {
      cnf_sign_key: forge_sk,
      verify_channel_jwt: make_verifier(core_pk),
      ctx: CTX,
    });

    // Handshake over a memory pipe (Relay data bodies in production).
    const i2r: Uint8Array[] = [init.pump_outbound()[0]!];
    resp.handle_incoming(i2r[0]!);
    const r2i: Uint8Array[] = resp.pump_outbound();
    expect(r2i).toHaveLength(1);
    init.handle_incoming(r2i[0]!);
    const i3: Uint8Array[] = init.pump_outbound();
    expect(i3).toHaveLength(1);
    resp.handle_incoming(i3[0]!);

    // Initiator confirm flows responder->open (JWT verify is async: poll).
    for (const b of init.pump_outbound()) resp.handle_incoming(b);
    await wait_phase(resp.noise, "open", "responder confirm");
    for (const b of resp.pump_outbound()) init.handle_incoming(b);
    await wait_phase(init.noise, "open", "initiator confirm");

    // Chunked tunnel call: a 70 KiB transcript page request body.
    const req_json = encode_tunnel_request({ id: "r-big", method: "GET", path: `/threads/t1/transcript?limit=100` });
    void req_json;
    const big_body = { id: "r-big", status: 200, body: { items: [{ id: "i1", text: "y".repeat(70 * 1024) }] } };
    const raw = new TextEncoder().encode(JSON.stringify(big_body));
    const chunks = chunk_bytes("r-big", raw);
    expect(chunks.length).toBeGreaterThan(1);

    // Initiator -> responder: small request frame arrives as app data.
    init.queue_app(encode_tunnel_request({ id: "r-big", method: "GET", path: "/threads/t1/transcript?limit=100" }));
    const received: Uint8Array[] = [];
    for (const ct of init.pump_outbound()) {
      const app = resp.handle_incoming(ct);
      if (app) received.push(app);
    }
    expect(received).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(received[0]!)).id).toBe("r-big");

    // Responder (fake Forge) answers with the chunked response.
    const asm = new ChunkReassembly();
    const seen: Uint8Array[] = [];
    for (const c of chunks) {
      resp.queue_app(JSON.stringify(c));
      for (const ct of resp.pump_outbound()) {
        const app = init.handle_incoming(ct);
        if (app) seen.push(app);
      }
    }
    expect(seen.length).toBe(chunks.length);
    let done: { done: false } | { done: true; bytes: Uint8Array } = { done: false };
    for (const frame of seen) {
      const json = JSON.parse(new TextDecoder().decode(frame));
      expect(is_chunk_frame(json)).toBe(true);
      done = asm.feed(json);
      if (done.done) break;
    }
    if (!done.done) throw new Error("expected reassembled response");
    const res = decode_tunnel_response(JSON.parse(new TextDecoder().decode(done.bytes)));
    expect(res.id).toBe("r-big");
    expect((res.body as { items: Array<{ text: string }> }).items[0]!.text).toHaveLength(70 * 1024);

    // Tampering destroys the session (fail-closed).
    const { ct } = init.noise.seal(new TextEncoder().encode("x"));
    const bad = Uint8Array.from(ct);
    bad[10]! ^= 0xff;
    expect(() => resp.handle_incoming(bad)).toThrow();
    expect(resp.is_open()).toBe(false);
  });
});
