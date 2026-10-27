// MOCK Core + Relay for browser UI verification ONLY. Not Core, not Relay,
// not production: an in-process fixture that implements just enough of the
// v1 HTTP surface and the Relay admission/Noise responder side for a real
// Chromium to drive the real UI code end to end (real grant JWTs minted
// with a throwaway test key, real Noise XX handshake, real chunked tunnel
// answers). Every synthetic value is clearly fake. Labeled MOCK throughout.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { importJWK, SignJWT, jwtVerify } from "jose";
import { ed25519 } from "@noble/curves/ed25519.js";
import { NoiseChannel, staticKeypairFromSecret, type VerifyChannelJwt } from "../../vendor/relay/channel.ts";
import { b64uDecode, b64uEncode } from "../../vendor/relay/jwt.ts";
import { popVerify } from "../../vendor/relay/e2e.ts";
import { ChunkReassembly, chunkBytes, SINGLE_FRAME_BYTES } from "../../src/forge.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const rid = (n: number) => Array.from(randomBytes(n), (b) => CROCKFORD[(b as number) % 32]).join("");
const newId = (prefix: string) => `${prefix}_01K${rid(23)}`;
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const nowSec = () => Math.floor(Date.now() / 1000);

const MOCK_ISS = "http://mock-core.test";
const MOCK_AUD = "ast-relay";

export interface MockHandles {
  url: string;
  coreSk: Uint8Array;
  corePk: Uint8Array;
  forgeCnfSk: Uint8Array;
  forgeCnfPk: Uint8Array;
  close(): Promise<void>;
}

interface LoginRequest {
  email: string;
  secret: string;
  token: string;
  status: "pending" | "email_approved" | "completed" | "expired";
  totpRequired: boolean;
  expiresAt: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".map": "application/json",
};

export async function startMock(distDir: string, port = 0): Promise<MockHandles> {
  const coreSk = ed25519.utils.randomSecretKey();
  const corePk = ed25519.getPublicKey(coreSk);
  const forgeCnfSk = ed25519.utils.randomSecretKey();
  const forgeCnfPk = ed25519.getPublicKey(forgeCnfSk);
  const accountId = `acct_01K${rid(23)}`;
  const machineId = `mch_01K${rid(23)}`;

  const logins = new Map<string, LoginRequest>(); // by requestId
  const outbox: string[] = []; // MOCK-ONLY: issued email tokens
  const sessions = new Set<string>();
  let lastBundle: { info: { id: string; version: number; contentHash: string; r2Key: string; createdAt: string }; manifest: unknown } | null = null;

  const coreKey = await importJWK({ kty: "OKP", crv: "Ed25519", d: b64u(coreSk), x: b64u(corePk) }, "EdDSA");
  const corePubKey = await importJWK({ kty: "OKP", crv: "Ed25519", x: b64u(corePk) }, "EdDSA");

  async function mintGrant(opts: { sub: string; mid: string; role: "client" | "forge"; scope: string[]; cnf: { kty: string; crv: string; x: string }; ttl: number }): Promise<string> {
    const t = nowSec();
    return new SignJWT({
      v: 1,
      sub: opts.sub,
      mid: opts.mid,
      role: opts.role,
      cnf: { jwk: opts.cnf },
      scope: opts.scope,
      jti: newId("tkn"),
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: "mock-core-1" })
      .setIssuer(MOCK_ISS)
      .setAudience(MOCK_AUD)
      .setIssuedAt(t)
      .setNotBefore(t)
      .setExpirationTime(t + opts.ttl)
      .sign(coreKey);
  }

  async function verifyAdmissionGrant(jwt: string, account: string, machine: string) {
    const { payload } = await jwtVerify(jwt, corePubKey, { issuer: MOCK_ISS, audience: MOCK_AUD });
    if (payload.sub !== account || payload.mid !== machine) throw new Error("room binding");
    if (!(payload.scope as string[]).includes("relay:connect")) throw new Error("scope");
    const ttl = (payload.exp as number) - (payload.iat as number);
    if (!(ttl > 0 && ttl <= 300)) throw new Error("ttl");
    const cnf = payload.cnf as { jwk: { x: string } };
    return { jti: payload.jti as string, cnfPk: b64uDecode(cnf.jwk.x) };
  }

  const channelVerify: VerifyChannelJwt = async (jwt, ctx) => {
    const { payload } = await jwtVerify(jwt, corePubKey, { issuer: MOCK_ISS, audience: MOCK_AUD });
    if (payload.sub !== ctx.account || payload.mid !== ctx.machine) throw new Error("channel binding");
    if (!(payload.scope as string[]).includes("relay:connect")) throw new Error("scope");
    return b64uDecode((payload.cnf as { jwk: { x: string } }).jwk.x);
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      const parts: Buffer[] = [];
      req.on("data", (c) => parts.push(c as Buffer));
      req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
      req.on("error", reject);
    });

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const err = (res: ServerResponse, status: number, code: string, message: string) =>
    json(res, status, { error: { code, message, requestId: newId("req").slice(0, 18) } });

  const cookieOf = (req: IncomingMessage): string | null => {
    const m = /ast_session=([^;]+)/.exec(req.headers.cookie ?? "");
    return m ? decodeURIComponent(m[1]!) : null;
  };
  const authed = (req: IncomingMessage) => {
    const t = cookieOf(req);
    return t !== null && sessions.has(t);
  };

  // -- canned Forge application data ---------------------------------------
  const bigText = "Long transcript line. ".repeat(3500); // ~73 KiB: forces chunked tunnel answers
  const forgeState = {
    forge_version: "mock-forge-0",
    protocol: 1,
    head: 42,
    projects: [{ id: "proj_cafe", path: "/home/cafe/demo", name: "demo", seq: 1, created_at: "2026-10-26T20:00:00.000Z", removed: false }],
    threads: [
      { id: "thread_short", project_id: "proj_cafe", title: "Mock: short thread", activity_seq: 10, read_seq: 10, settled_seq: 10, seq: 12, created_at: "2026-10-26T20:00:00.000Z", updated_at: "2026-10-26T20:00:00.000Z", archived: false },
      { id: "thread_long", project_id: "proj_cafe", title: "Mock: long transcript", activity_seq: 40, read_seq: 0, settled_seq: 0, seq: 41, created_at: "2026-10-26T20:00:00.000Z", updated_at: "2026-10-26T20:00:00.000Z", archived: false },
    ],
    runs: [],
    waiting: [{ id: "item_wait1", thread_id: "thread_short" }],
  };
  const shortTranscript = {
    items: [
      { id: "item_u1", thread_id: "thread_short", position: 1, seq: 2, run_id: null, parent_id: null, status: "done", created_at: "2026-10-26T20:00:00.000Z", updated_at: "2026-10-26T20:00:00.000Z", kind: { type: "user_message", text: "Mock: hello from the UI test" } },
      { id: "item_a1", thread_id: "thread_short", position: 2, seq: 3, run_id: null, parent_id: null, status: "awaiting_user", created_at: "2026-10-26T20:00:00.000Z", updated_at: "2026-10-26T20:00:00.000Z", kind: { type: "tool", tool: { kind: "shell", command: "rm -rf /tmp/mock", cwd: null, background: false, watch: false }, title: "Mock shell", output: null, exit_code: null, approval: { request: { type: "command", command: "rm -rf /tmp/mock", cwd: null }, reason: "Mock: destructive command needs approval", options: ["allow_once", "deny_once"], decision: null } } },
    ],
    more: false,
  };
  const longTranscript = {
    items: [
      { id: "item_big", thread_id: "thread_long", position: 1, seq: 2, run_id: null, parent_id: null, status: "done", created_at: "2026-10-26T20:00:00.000Z", updated_at: "2026-10-26T20:00:00.000Z", kind: { type: "assistant_message", text: bigText, phase: "final" } },
    ],
    more: false,
  };

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://mock");
      const path = url.pathname;
      // MOCK-ONLY outbox (lets the test read the emailed token).
      if (path === "/mock/outbox" && req.method === "GET") return json(res, 200, { tokens: outbox });
      if (path === "/mock/info" && req.method === "GET") {
        return json(res, 200, { mock: true, accountId, machineId, forgeCnfX: b64u(forgeCnfPk), iss: MOCK_ISS });
      }
      if (path === "/v1/version") return json(res, 200, { api: "1", contracts: "1.0.0", jwksUri: "/.well-known/jwks.json", openapi: "/v1/openapi.json" });
      if (path === "/.well-known/jwks.json") {
        return json(res, 200, { keys: [{ kty: "OKP", crv: "Ed25519", x: b64u(corePk), kid: "mock-core-1", use: "sig", alg: "EdDSA" }] });
      }
      if (path === "/v1/grants/revocations") {
        return json(res, 200, { revokedMachineIds: [], revokedKeyIds: [], asOf: new Date().toISOString() });
      }
      if (path === "/v1/auth/magic/request" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { email?: string; displayName?: string; deviceName?: string };
        if (typeof body.email !== "string" || !body.email.includes("@")) return err(res, 400, "bad_request", "Enter an email address.");
        const requestId = newId("logreq");
        const login: LoginRequest = {
          email: body.email,
          secret: b64u(randomBytes(32)),
          token: b64u(randomBytes(24)),
          status: "pending",
          totpRequired: body.email.startsWith("totp@"),
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        };
        logins.set(requestId, login);
        outbox.push(login.token);
        return json(res, 200, { requestId, requestSecret: login.secret, expiresAt: login.expiresAt });
      }
      if (path === "/v1/auth/magic/status" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { requestId?: string; requestSecret?: string };
        const l = logins.get(body.requestId ?? "");
        if (!l || l.secret !== body.requestSecret) return err(res, 404, "not_found", "Unknown sign-in request.");
        return json(res, 200, { requestId: body.requestId, status: l.status, totpRequired: l.totpRequired, email: l.email, expiresAt: l.expiresAt });
      }
      if (path === "/v1/auth/magic/consume" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { token?: string };
        const entry = [...logins.entries()].find(([, l]) => l.token === body.token);
        if (!entry) return err(res, 404, "not_found", "This link is invalid or expired.");
        entry[1].status = "email_approved";
        return json(res, 200, { requestId: entry[0], status: "email_approved", totpRequired: entry[1].totpRequired });
      }
      if (path === "/v1/auth/magic/finalize" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { requestId?: string; requestSecret?: string; totpCode?: string; recoveryCode?: string };
        const l = logins.get(body.requestId ?? "");
        if (!l || l.secret !== body.requestSecret) return err(res, 401, "unauthorized", "This browser did not start the sign-in.");
        if (l.status !== "email_approved") return err(res, 409, "conflict", "The emailed link has not been approved yet.");
        if (l.totpRequired && body.totpCode !== "123456" && body.recoveryCode !== "mock-recovery-1") {
          return err(res, 401, "totp_required", "Enter the authenticator code.");
        }
        l.status = "completed";
        const token = b64u(randomBytes(32));
        sessions.add(token);
        res.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": `ast_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        });
        return res.end(JSON.stringify({ sessionId: newId("sess"), accountId, expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), totpVerified: l.totpRequired }));
      }
      if (!authed(req)) {
        if (path.startsWith("/v1/") && !path.startsWith("/v1/auth/") && path !== "/v1/version" && !path.startsWith("/v1/presence/")) {
          return err(res, 401, "unauthorized", "Sign in first.");
        }
      }
      const machineInfo = (label: string) => ({
        id: machineId,
        publicKey: { kty: "OKP", crv: "Ed25519", x: b64u(forgeCnfPk) },
        label,
        createdAt: "2026-10-26T20:00:00.000Z",
        revokedAt: null,
        lastSeenAt: new Date().toISOString(),
      });
      if (path === "/v1/me") {
        return json(res, 200, { accountId, email: "cafe@example.com", displayName: "Cafe User", totpEnrolled: false, machines: [machineInfo("cafe-forge")], providerConnections: [], latestConfigVersion: null });
      }
      if (path === "/v1/machines" && req.method === "GET") return json(res, 200, { machines: [machineInfo("cafe-forge")] });
      if (path === "/v1/machines/enrollments/claim" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { code?: string };
        if (body.code !== "MOCK1234") return err(res, 404, "not_found", "Wrong or expired code.");
        return json(res, 200, { enrollmentId: newId("enr"), status: "claimed" });
      }
      if (path === "/v1/sessions" && req.method === "GET") {
        return json(res, 200, { sessions: [{ id: newId("sess"), deviceName: "mock browser", totpVerifiedAt: null, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), revokedAt: null }] });
      }
      if (path === "/v1/sessions/current/revoke" && req.method === "POST") {
        const t = cookieOf(req);
        if (t) sessions.delete(t);
        res.writeHead(200, { "content-type": "application/json", "set-cookie": "ast_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
        return res.end(JSON.stringify({ revoked: true }));
      }
      if (path === "/v1/sessions/revoke-all" && req.method === "POST") {
        sessions.clear();
        res.writeHead(200, { "content-type": "application/json", "set-cookie": "ast_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
        return res.end(JSON.stringify({ revoked: true }));
      }
      if (path === "/v1/auth/totp/enroll" && req.method === "POST") {
        return json(res, 200, { otpauthUrl: "otpauth://totp/mock?secret=MOCK", recoveryCodes: ["mock-recovery-1", "mock-recovery-2"] });
      }
      if ((path === "/v1/auth/totp/verify" || path === "/v1/auth/totp/disable") && req.method === "POST") {
        return json(res, 200, path.endsWith("verify") ? { enrolled: true } : { disabled: true });
      }
      if (path === "/v1/vault/connections" && req.method === "GET") return json(res, 200, { connections: [] });
      if (path === "/v1/engine-artifacts" && req.method === "GET") return json(res, 200, { artifacts: [] });
      if (path === "/v1/config/bundles/latest") {
        return json(res, 200, lastBundle ? { bundle: lastBundle.info, manifest: lastBundle.manifest } : { bundle: null, manifest: null });
      }
      if (path === "/v1/config/bundles" && req.method === "POST") {
        const raw = await readBody(req);
        let body: { manifest?: { format?: unknown; mcpServers?: unknown; skills?: unknown } };
        try {
          body = JSON.parse(raw || "{}") as typeof body;
        } catch {
          return err(res, 400, "bad_request", "Not valid JSON.");
        }
        if (body.manifest?.format !== "ast-editor-config/1") return err(res, 400, "bad_request", "Bad manifest.");
        const info = {
          id: newId("bundle"),
          version: (lastBundle?.info.version ?? 0) + 1,
          contentHash: createHash("sha256").update(raw).digest("hex"),
          r2Key: "mock/bundles/latest",
          createdAt: new Date().toISOString(),
        };
        lastBundle = { info, manifest: body.manifest };
        return json(res, 201, info);
      }
      if (path === "/v1/activity") return json(res, 200, { events: [] });
      if (path === "/v1/grants/issue" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { audience?: string; scope?: string[]; ttlSeconds?: number; targetMachineId?: string; cnf?: { kty: string; crv: string; x: string } };
        if (body.audience !== "ast-relay") return err(res, 400, "bad_request", "Mock only issues ast-relay grants.");
        if (!body.targetMachineId || body.targetMachineId !== machineId) return err(res, 403, "forbidden", "Unknown target machine.");
        if (!body.cnf) return err(res, 400, "bad_request", "cnf is required.");
        const ttl = Math.min(body.ttlSeconds ?? 300, 300);
        const token = await mintGrant({ sub: accountId, mid: body.targetMachineId, role: "client", scope: body.scope ?? ["relay:connect"], cnf: body.cnf, ttl });
        return json(res, 200, { token, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() });
      }
      if (path.startsWith("/v1/presence/") && req.method === "GET") {
        const auth = req.headers.authorization ?? "";
        const m = /^Bearer (.+)$/.exec(auth);
        if (!m) return err(res, 401, "unauthorized", "Grant required.");
        try {
          await verifyAdmissionGrant(m[1]!, accountId, machineId);
        } catch {
          return err(res, 403, "forbidden", "Bad grant.");
        }
        return json(res, 200, { v: 1, forge_online: true, clients: 1 });
      }
      // MOCK of Core's emailed-link endpoint: a plain page that hands off
      // to the account portal (Core will wire the real asset/redirect;
      // this mock mirrors that shape so the test drives the mailed URL).
      if (path === "/v1/auth/magic/confirm" && req.method === "GET") {
        const token = url.searchParams.get("token") ?? "";
        const known = [...logins.values()].some((l) => l.token === token);
        if (!/^[A-Za-z0-9_-]{10,128}$/.test(token) || !known) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          return res.end("<!doctype html><html><body><p>This approval link is invalid or expired. Request a new sign-in link.</p></body></html>");
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(
          `<!doctype html><html><head><meta charset="utf-8"><title>Approve sign-in</title></head><body>` +
            `<main style="font-family:system-ui;max-width:26rem;margin:4rem auto">` +
            `<h1>Approve this sign-in?</h1>` +
            `<p>Only approve if you just tried to sign in — otherwise ignore this page.</p>` +
            `<p><a id="continue" href="/#/approve?token=${encodeURIComponent(token)}">Continue in the account portal</a></p>` +
            `</main></body></html>`,
        );
      }
      // Static UI bundle.
      if (req.method === "GET") {
        let file = path === "/" ? "/index.html" : normalize(path);
        if (file.includes("..")) return err(res, 400, "bad_request", "bad path");
        try {
          const data = await readFile(join(distDir, file));
          res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
          return res.end(data);
        } catch {
          // SPA fallback for hash routes (all state lives after #).
          if (!extname(file)) {
            const data = await readFile(join(distDir, "index.html"));
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            return res.end(data);
          }
          return err(res, 404, "not_found", "no such file");
        }
      }
      return err(res, 404, "not_found", "mock: unimplemented");
    } catch (e) {
      return err(res, 500, "internal", `mock failure: ${(e as Error).message}`);
    }
  });

  // -- Relay WS mock ---------------------------------------------------------
  const wss = new WebSocketServer({ server, path: undefined });
  wss.on("connection", (ws: WebSocket, req) => {
    void handleRelayConn(ws, req).catch(() => {
      try {
        ws.close(4408, "mock failure");
      } catch {
        // ignore
      }
    });
  });

  interface Conn {
    account: string;
    machine: string;
    grant: { jti: string; cnfPk: Uint8Array; scope: string[] };
    nonce: Uint8Array;
    challengedAt: number;
    authed: boolean;
    seqOut: number;
    seqIn: Map<string, number>;
    noise: Map<string, NoiseChannel>;
    asm: Map<string, ChunkReassembly>;
  }

  interface RoomSub {
    ws: WebSocket;
    c: Conn;
    channel: string;
    thread: string;
  }

  // Room-global live state: streams live on their own WS/Conn, so
  // subscriptions and the event cursor are shared across connections.
  const roomSubs = new Map<string, RoomSub>();
  let roomEventSeq = 1000;
  let subSeq = 0;
  const threadItems = new Map<string, Array<Record<string, unknown>>>([
    ["thread_short", [...(shortTranscript.items as Array<Record<string, unknown>>)].map((i) => ({ ...i }))],
    ["thread_long", [...(longTranscript.items as Array<Record<string, unknown>>)].map((i) => ({ ...i }))],
  ]);
  // Valid 1x1 WebP fixture (generated with ImageMagick, not hand bytes):
  // the transcript's Image item references it by sha256, and GET /blobs/<hash>
  // serves the exact bytes as a $bytes envelope.
  const webpBytes = await readFile(new URL("./fixtures/dot-1x1.webp", import.meta.url));
  const webpHash = createHash("sha256").update(webpBytes).digest("hex");
  threadItems.get("thread_short")?.push({
    id: "item_img1",
    thread_id: "thread_short",
    position: 3,
    seq: 4,
    run_id: null,
    parent_id: null,
    status: "done",
    created_at: "2026-10-26T20:00:00.000Z",
    updated_at: "2026-10-26T20:00:00.000Z",
    kind: { type: "image", blob: webpHash, caption: "Mock: 1x1 test image" },
  });
  const itemEventSeq = new Map<string, number>();
  const nextEventSeq = (itemId: string): number => {
    const s = ++roomEventSeq;
    itemEventSeq.set(itemId, s);
    return s;
  };

  const send = (ws: WebSocket, frame: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  const dataOut = (c: Conn, ws: WebSocket, channel: string, body: Uint8Array) => {
    send(ws, { v: 1, type: "data", channel, seq: c.seqOut++, body: Buffer.from(body).toString("base64url") });
  };
  const pumpResponder = (c: Conn, ws: WebSocket, channel: string) => {
    const n = c.noise.get(channel);
    if (!n) return;
    for (const b of n.takeOutbound()) dataOut(c, ws, channel, b);
    // Responder handshake turn: emit our reply (m2) when it is our turn.
    // takeOutbound alone never produces handshake messages.
    if (n.getPhase() === "handshake") {
      try {
        for (const b of [n.nextHandshakeMessage()]) dataOut(c, ws, channel, b);
        for (const b of n.takeOutbound()) dataOut(c, ws, channel, b);
      } catch {
        // Not our turn yet; the next inbound message triggers us.
      }
    }
  };

  const answerTunnel = (c: Conn, ws: WebSocket, channel: string, reqJson: unknown) => {
    const r = reqJson as { id?: unknown; method?: unknown; path?: unknown; body?: unknown };
    const id = typeof r.id === "string" ? r.id : "unknown";
    const method = typeof r.method === "string" ? r.method : "GET";
    const path = typeof r.path === "string" ? r.path : "/";
    const exec = method !== "GET";
    if (exec && !c.grant.scope.includes("forge:execute")) {
      return { id, status: 403, body: { error: { code: "forbidden", message: "grant lacks forge:execute" } } };
    }
    if (method === "GET" && path === "/state") return { id, status: 200, body: forgeState };
    const mTranscript = /^\/threads\/([^/]+)\/transcript/.exec(path);
    if (method === "GET" && mTranscript) {
      const tid = decodeURIComponent(mTranscript[1] ?? "");
      const items = threadItems.get(tid);
      if (!items) return { id, status: 404, body: { error: { code: "not_found", message: "no such thread" } } };
      const u = new URL(path, "http://mock");
      const after = Number(u.searchParams.get("after") ?? "0") || 0;
      const limit = Math.min(Number(u.searchParams.get("limit") ?? "100") || 100, 100);
      const fresh = items.filter((i) => (i.position as number) > after).slice(0, limit);
      return { id, status: 200, body: { items: fresh, more: items.some((i) => (i.position as number) > after + fresh.length), runs: [] } };
    }
    const mMsg = /^\/threads\/([^/]+)\/messages$/.exec(path);
    if (method === "POST" && mMsg) {
      const tid = decodeURIComponent(mMsg[1] ?? "");
      const items = threadItems.get(tid);
      if (!items) return { id, status: 404, body: { error: { code: "not_found", message: "no such thread" } } };
      const b = (r.body ?? {}) as { id?: unknown; text?: unknown };
      const position = (items[items.length - 1]?.position as number ?? 0) + 1;
      const item = { id: typeof b.id === "string" ? b.id : `item_mock_${position}`, thread_id: tid, position, seq: position + 100, run_id: null, parent_id: null, status: "running", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), kind: { type: "user_message", text: b.text ?? "" } };
      items.push(item);
      // Live-fanout: every subscription on this thread gets an $event.
      const envelope = { seq: nextEventSeq(item.id as string), type: "item", item };
      for (const [stream, sub] of roomSubs) {
        if (sub.thread === tid) emitApp(sub.c, sub.ws, sub.channel, { $event: { stream, envelope } });
      }
      return { id, status: 200, body: item };
    }
    if (method === "POST" && /\/threads\/[^/]+\/(cancel|continue)$/.exec(path)) return { id, status: 204, body: null };
    if (method === "POST" && /^\/items\/[^/]+\/answer$/.exec(path)) return { id, status: 204, body: null };
    const mBlob = /^\/blobs\/([0-9a-f]{64})$/.exec(path);
    if (method === "GET" && mBlob) {
      if (mBlob[1] !== webpHash) return { id, status: 404, body: { error: { code: "not_found", message: "no such blob" } } };
      return {
        id,
        status: 200,
        body: { $bytes: { content_type: "image/webp", b64u: Buffer.from(webpBytes).toString("base64url") } },
        content_type: "image/webp",
      };
    }
    const mSub = /^\/events\?/.exec(path);
    if (method === "SUBSCRIBE" && mSub) {
      const u = new URL(path, "http://mock");
      const since = Number(u.searchParams.get("since") ?? "0") || 0;
      const thread = u.searchParams.get("thread") ?? "";
      if (!threadItems.has(thread)) return { id, status: 404, body: { error: { code: "not_found", message: "no such thread" } } };
      const stream = `st-mock-${++subSeq}`;
      roomSubs.set(stream, { ws, c, channel, thread });
      const response = { id, status: 200, body: { $stream: { stream } } };
      // Backlog first (same `since` cursor semantics), then live.
      const backlog = (threadItems.get(thread) ?? [])
        .filter((item) => (itemEventSeq.get(item.id as string) ?? 0) > since)
        .map((item) => {
          const itemId = item.id as string;
          const seq = itemEventSeq.get(itemId) ?? nextEventSeq(itemId);
          return { $event: { stream, envelope: { seq, type: "item", item } } };
        });
      queueMicrotask(() => {
        for (const ev of backlog) emitApp(c, ws, channel, ev);
      });
      return response;
    }
    const mUnsub = /^\/events\/([^/]+)$/.exec(path);
    if (method === "UNSUBSCRIBE" && mUnsub) {
      roomSubs.delete(decodeURIComponent(mUnsub[1] ?? ""));
      return { id, status: 200, body: { ok: true } };
    }
    return { id, status: 404, body: { error: { code: "not_found", message: `mock: no route ${method} ${path}` } } };
  };

  const emitApp = (c: Conn, ws: WebSocket, channel: string, value: unknown) => {
    const raw = new TextEncoder().encode(JSON.stringify(value));
    const n = c.noise.get(channel);
    if (!n) return;
    const v = value as { id?: unknown; $event?: { stream?: unknown; envelope?: { seq?: unknown } } };
    const transfer =
      typeof v.id === "string" ? v.id : `ev-${String(v.$event?.stream ?? "x")}-${String(v.$event?.envelope?.seq ?? rid(6))}`;
    if (raw.length > SINGLE_FRAME_BYTES) {
      for (const chunk of chunkBytes(transfer, raw)) {
        const { ct } = n.seal(new TextEncoder().encode(JSON.stringify(chunk)));
        dataOut(c, ws, channel, ct);
      }
      return;
    }
    const { ct } = n.seal(raw);
    dataOut(c, ws, channel, ct);
  };

  async function handleRelayConn(ws: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url ?? "/", "http://mock");
    const m = /^\/v1\/route\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!m) return ws.close(4401, "bad room path");
    const account = decodeURIComponent(m[1]!);
    const machine = decodeURIComponent(m[2]!);
    if (account !== accountId || machine !== machineId) return ws.close(4403, "no such room");
  const c: Conn = {
      account, machine, grant: { jti: "", cnfPk: new Uint8Array(0), scope: [] },
      nonce: randomBytes(32), challengedAt: Date.now(), authed: false,
      seqOut: 0, seqIn: new Map(), noise: new Map(), asm: new Map(),
    };
    // Honest transport window (mirrors Relay room.ts): 64 frames / 1 MiB
    // per channel per direction. A compliant Forge acks promptly but
    // asynchronously, so synchronous blasts overflow while paced sends
    // pass. Overflow → `backpressure` error, frame dropped.
    const win = new Map<string, { frames: number; bytes: number }>();
    const winOf = (channel: string) => {
      let w = win.get(channel);
      if (!w) {
        w = { frames: 0, bytes: 0 };
        win.set(channel, w);
      }
      return w;
    };
    let gotHello = false;
    ws.on("message", (data) => {
      void (async () => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(String(data)) as Record<string, unknown>;
        } catch {
          return ws.close(4408, "bad frame");
        }
        if (!gotHello) {
          if (frame.type !== "hello" || frame.v !== 1 || typeof frame.grant !== "string") return ws.close(4401, "hello first");
          gotHello = true;
          try {
            const g = await verifyAdmissionGrant(frame.grant, account, machine);
            c.grant = { jti: g.jti, cnfPk: g.cnfPk, scope: [] };
            // Re-read scope for app-layer checks.
            const [, p] = frame.grant.split(".");
            c.grant.scope = (JSON.parse(Buffer.from(p ?? "", "base64url").toString("utf8")) as { scope: string[] }).scope;
          } catch {
            return ws.close(4401, "bad grant");
          }
          c.challengedAt = Date.now();
          return send(ws, { v: 1, type: "challenge", nonce: Buffer.from(c.nonce).toString("base64url"), timeout_ms: 60000 });
        }
        if (!c.authed) {
          if (frame.type !== "authenticate" || frame.jti !== c.grant.jti || typeof frame.sig !== "string") {
            return ws.close(4401, "bad authenticate");
          }
          if (Date.now() - c.challengedAt > 60_000) return ws.close(4401, "challenge expired");
          if (!popVerify(c.grant.cnfPk, c.nonce, c.grant.jti, b64uDecode(frame.sig))) return ws.close(4401, "bad pop");
          c.authed = true;
          send(ws, { v: 1, type: "ready", role: "client", account, machine, forge_online: true });
          return send(ws, { v: 1, type: "presence", forge_online: true, clients: 1 });
        }
        if (frame.v !== 1) return;
        if (frame.type === "pong") return;
        if (frame.type === "ack") return; // flow control observed, nothing queued
        if (frame.type === "open") {
          const channel = String(frame.channel ?? "");
          if (!/^[A-Za-z0-9][A-Za-z0-9._~:-]{0,63}$/.test(channel)) return send(ws, { v: 1, type: "error", code: "bad_channel", message: "bad channel" });
          if (!c.noise.has(channel)) {
            c.noise.set(channel, new NoiseChannel({
              initiator: false,
              staticKeypair: staticKeypairFromSecret(randomBytes(32)),
              cnfSignKey: forgeCnfSk,
              verifyChannelJwt: channelVerify,
              ctx: { account, machine, channel },
            }));
          }
          return send(ws, { v: 1, type: "channel-opened", channel, peer: "forge" });
        }
        if (frame.type === "data") {
          const channel = String(frame.channel ?? "");
          const n = c.noise.get(channel);
          if (!n) return;
          const seq = frame.seq as number;
          const last = c.seqIn.get(channel) ?? -1;
          if (!(Number.isInteger(seq) && seq === last + 1)) return ws.close(4408, "seq gap");
          c.seqIn.set(channel, seq);
          // Window accounting is on the BASE64 STRING length (room basis),
          // not decoded raw bytes. Keep the seq high-water even on drops so
          // replays of a dropped frame fail.
          const wireLen = String(frame.body ?? "").length;
          const body = Buffer.from(String(frame.body ?? ""), "base64url");
          const w = winOf(channel);
          if (w.frames >= 64 || w.bytes + wireLen > 1_048_576) {
            send(ws, { v: 1, type: "error", code: "backpressure", message: "recipient window full; frame dropped" });
            return;
          }
          w.frames += 1;
          w.bytes += wireLen;
          // Compliant-forge ack: prompt but asynchronous — paced sends fit,
          // synchronous blasts overflow. Forward the cumulative ack so the
          // sender's window slides (room behavior).
          setImmediate(() => {
            w.frames = Math.max(0, w.frames - 1);
            w.bytes = Math.max(0, w.bytes - wireLen);
            send(ws, { v: 1, type: "ack", channel, seq });
          });
          try {
            if (n.getPhase() === "handshake") {
              n.receiveHandshakeMessage(new Uint8Array(body));
            } else {
              const app = n.receiveTransport(new Uint8Array(body));
              if (app) {
                const text = new TextDecoder().decode(app);
                const parsed = JSON.parse(text) as Record<string, unknown>;
                if (typeof parsed.transfer === "string" && typeof parsed.bytes_b64u === "string") {
                  const key = parsed.transfer;
                  let asm = c.asm.get(key);
                  if (!asm) {
                    asm = new ChunkReassembly();
                    c.asm.set(key, asm);
                  }
                  const out = asm.feed(parsed as never);
                  if (out.done) {
                    c.asm.delete(key);
                    const full = JSON.parse(new TextDecoder().decode(out.bytes));
                    emitApp(c, ws, channel, answerTunnel(c, ws, channel, full));
                  }
                } else {
                  emitApp(c, ws, channel, answerTunnel(c, ws, channel, parsed));
                }
              }
            }
          } catch (e) {
            send(ws, { v: 1, type: "error", code: "channel_failed", message: (e as Error).message });
            return;
          }
          pumpResponder(c, ws, channel);
          // The responder confirm emits asynchronously (JWT verify inside
          // Noise confirm); flush again on short delays so the browser's
          // handshake completes without polling the relay.
          setTimeout(() => pumpResponder(c, ws, channel), 10);
          setTimeout(() => pumpResponder(c, ws, channel), 100);
          return;
        }
        if (frame.type === "close") {
          const channel = String(frame.channel ?? "");
          c.noise.get(channel)?.destroy();
          c.noise.delete(channel);
          for (const [stream, sub] of roomSubs) {
            if (sub.channel === channel) roomSubs.delete(stream);
          }
          return send(ws, { v: 1, type: "channel-closed", channel, reason: "bye" });
        }
      })().catch(() => ws.close(4408, "mock failure"));
    });
  }

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    coreSk,
    corePk,
    forgeCnfSk,
    forgeCnfPk,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Terminate clients first so the HTTP server can actually close:
        // wss.close() alone only stops accepting.
        for (const client of wss.clients) {
          try {
            client.terminate();
          } catch {
            // ignore
          }
        }
        wss.close(() => server.close((e) => (e ? reject(e) : resolve())));
      }),
  };
}
