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
import { b64uDecode, b64uEncode } from "../vendor/relay/jwt.ts";
import { staticKeypairFromSecret } from "../vendor/relay/channel.ts";
import type { VerifyChannelJwt } from "../vendor/relay/channel.ts";
import {
  ChunkReassembly,
  chunkBytes,
  decodeTunnelResponse,
  encodeTunnelRequest,
  isChunkFrame,
} from "../src/forge.ts";

const CTX = { account: "acct1", machine: "forge1", channel: "app-test" };

async function mintSelfGrant(opts: { account: string; machine: string; scope: string[]; cnfPk: Uint8Array; coreSk: Uint8Array; iss?: string; aud?: string }): Promise<string> {
  const key = await importJWK({ kty: "OKP", crv: "Ed25519", d: b64uEncode(opts.coreSk), x: b64uEncode(ed25519.getPublicKey(opts.coreSk)) }, "EdDSA");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    v: 1,
    sub: opts.account,
    mid: opts.machine,
    role: "client",
    scope: opts.scope,
    cnf: { jwk: { kty: "OKP", crv: "Ed25519", x: b64uEncode(opts.cnfPk) } },
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

function makeVerifier(corePk: Uint8Array): VerifyChannelJwt {
  return async (jwt: string, ctx) => {
    const key = await importJWK({ kty: "OKP", crv: "Ed25519", x: b64uEncode(corePk) }, "EdDSA");
    const { payload } = await jwtVerify(jwt, key, { issuer: "https://core.test", audience: "ast-relay" });
    if (payload.sub !== ctx.account || payload.mid !== ctx.machine) throw new Error("grant not bound to this channel context");
    if (!(payload.scope as string[]).includes("relay:connect")) throw new Error("grant lacks relay:connect");
    const cnf = payload.cnf as { jwk: { x: string } };
    const pk = b64uDecode(cnf.jwk.x);
    if (pk.length !== 32) throw new Error("bad cnf");
    return pk;
  };
}

/** The confirm path verifies a JWT asynchronously; poll with a real deadline. */
async function waitPhase(ch: { getPhase(): string }, want: string, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const got = ch.getPhase();
    if (got === want) return;
    if (got === "closed") throw new Error(`${label}: session closed while waiting for ${want}`);
    if (Date.now() > deadline) throw new Error(`${label}: timed out waiting for ${want}, stuck at ${got}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("browser Noise session (vendored SecureChannel)", () => {
  it("opens with mutual JWT identity binding, then carries a chunked tunnel call", async () => {
    const coreSk = ed25519.utils.randomSecretKey();
    const corePk = ed25519.getPublicKey(coreSk);
    const forgeSk = ed25519.utils.randomSecretKey();
    const forgePk = ed25519.getPublicKey(forgeSk);
    const editorCnfSk = ed25519.utils.randomSecretKey();
    const editorCnfPk = ed25519.getPublicKey(editorCnfSk);
    const jwt = await mintSelfGrant({ account: CTX.account, machine: CTX.machine, scope: ["relay:connect", "forge:execute"], cnfPk: editorCnfPk, coreSk });

    const init = SecureChannel.initiate(staticKeypairFromSecret(randomBytes(32)), {
      cnfSignKey: editorCnfSk,
      expectedForgeCnf: forgePk,
      ownGrantJwt: jwt,
      ctx: CTX,
    });
    const resp = SecureChannel.accept(staticKeypairFromSecret(randomBytes(32)), {
      cnfSignKey: forgeSk,
      verifyChannelJwt: makeVerifier(corePk),
      ctx: CTX,
    });

    // Handshake over a memory pipe (Relay data bodies in production).
    const i2r: Uint8Array[] = [init.pumpOutbound()[0]!];
    resp.handleIncoming(i2r[0]!);
    const r2i: Uint8Array[] = resp.pumpOutbound();
    expect(r2i).toHaveLength(1);
    init.handleIncoming(r2i[0]!);
    const i3: Uint8Array[] = init.pumpOutbound();
    expect(i3).toHaveLength(1);
    resp.handleIncoming(i3[0]!);

    // Initiator confirm flows responder->open (JWT verify is async: poll).
    for (const b of init.pumpOutbound()) resp.handleIncoming(b);
    await waitPhase(resp.noise, "open", "responder confirm");
    for (const b of resp.pumpOutbound()) init.handleIncoming(b);
    await waitPhase(init.noise, "open", "initiator confirm");

    // Chunked tunnel call: a 70 KiB transcript page request body.
    const reqJson = encodeTunnelRequest({ id: "r-big", method: "GET", path: `/threads/t1/transcript?limit=100` });
    void reqJson;
    const bigBody = { id: "r-big", status: 200, body: { items: [{ id: "i1", text: "y".repeat(70 * 1024) }] } };
    const raw = new TextEncoder().encode(JSON.stringify(bigBody));
    const chunks = chunkBytes("r-big", raw);
    expect(chunks.length).toBeGreaterThan(1);

    // Initiator -> responder: small request frame arrives as app data.
    init.queueApp(encodeTunnelRequest({ id: "r-big", method: "GET", path: "/threads/t1/transcript?limit=100" }));
    const received: Uint8Array[] = [];
    for (const ct of init.pumpOutbound()) {
      const app = resp.handleIncoming(ct);
      if (app) received.push(app);
    }
    expect(received).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(received[0]!)).id).toBe("r-big");

    // Responder (fake Forge) answers with the chunked response.
    const asm = new ChunkReassembly();
    const seen: Uint8Array[] = [];
    for (const c of chunks) {
      resp.queueApp(JSON.stringify(c));
      for (const ct of resp.pumpOutbound()) {
        const app = init.handleIncoming(ct);
        if (app) seen.push(app);
      }
    }
    expect(seen.length).toBe(chunks.length);
    let done: { done: false } | { done: true; bytes: Uint8Array } = { done: false };
    for (const frame of seen) {
      const json = JSON.parse(new TextDecoder().decode(frame));
      expect(isChunkFrame(json)).toBe(true);
      done = asm.feed(json);
      if (done.done) break;
    }
    if (!done.done) throw new Error("expected reassembled response");
    const res = decodeTunnelResponse(JSON.parse(new TextDecoder().decode(done.bytes)));
    expect(res.id).toBe("r-big");
    expect((res.body as { items: Array<{ text: string }> }).items[0]!.text).toHaveLength(70 * 1024);

    // Tampering destroys the session (fail-closed).
    const { ct } = init.noise.seal(new TextEncoder().encode("x"));
    const bad = Uint8Array.from(ct);
    bad[10]! ^= 0xff;
    expect(() => resp.handleIncoming(bad)).toThrow();
    expect(resp.isOpen()).toBe(false);
  });
});
