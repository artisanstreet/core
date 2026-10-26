import { Cause, Effect, Layer, ParseResult, Schema } from "effect";
import { Hono } from "hono";
import { CoreError, forbidden, notFound, payloadTooLarge, unauthorized } from "./errors.js";
import { configFromEnv, AppConfigTag, DbTag, TxTag, type TxRunner } from "./services/deps.js";
import { MailTag } from "./services/mail.js";
import { StorageTag } from "./services/storage.js";
import type { AppEnv, Db, R2Like } from "./db.js";
import * as C from "./contracts/v1.js";
import { R, ROUTES, type AnySchema, type RouteDef } from "./contracts/registry.js";
import * as Auth from "./services/auth.js";
import * as Machines from "./services/machines.js";
import * as Grants from "./services/grants.js";
import * as Vault from "./services/vault.js";
import * as ConfigSvc from "./products/editor/config.js";
import * as Activity from "./services/activity.js";
import * as Deletion from "./services/deletion.js";
import { janitor } from "./services/janitor.js";
import { signinPage, confirmPage, claimPage } from "./ui.js";
import openapiDoc from "../contracts/v1.openapi.json";
import { registerEditorRoutes } from "./products/editor/routes.js";

export type ServiceEnv = DbTag | AppConfigTag | MailTag | StorageTag | TxTag;

export interface RequestContext {
  readonly db: Db;
  readonly env: AppEnv;
  readonly mailer: "log" | "resend";
  readonly resendApiKey?: string;
  readonly r2: R2Like;
  readonly txRunner: TxRunner;
  /** Test-only capture for delivered mail (never set in production). */
  readonly mailSink?: (m: { to: string; subject: string; text: string; confirmUrl: string }) => void;
  /** Optional static asset backend (portal web/dist via Workers Assets). */
  readonly assets?: { fetch(request: Request): Promise<Response> };
  /** Explicit clock (tests inject a mutable fake; production omits it). */
  readonly now?: () => number;
}

export interface H {
  req: {
    header(name: string): string | undefined;
    text(): Promise<string>;
    json(): Promise<unknown>;
    param(name: string): string;
    query(name: string): string | undefined;
    path: string;
    method: string;
    url: string;
    raw: { body: ReadableStream<Uint8Array> | null };
  };
  json(body: unknown, status?: number): Response;
  html(body: string, status?: number): Response;
  header(name: string, value: string): void;
  get(key: "requestId"): string;
  set(key: string, value: unknown): void;
}

export interface RouteScope {
  readonly run: <A, E>(eff: Effect.Effect<A, E, ServiceEnv>) => Promise<A>;
  readonly ok: (c: H, schema: AnySchema, value: unknown, status?: number) => Response;
  readonly fail: (c: H, e: unknown) => Response;
  readonly readBody: (c: H) => Promise<unknown>;
  readonly sessionOf: (c: H) => Promise<{ principal: Auth.SessionPrincipal; via: "bearer" | "cookie" }>;
  readonly sessionForMutation: (c: H) => Promise<Auth.SessionPrincipal>;
  readonly proofForMachine: (c: H) => Promise<{
    principal: { machineId: string; accountId: string };
    publicKeyX: string;
    subjectId: string;
    rawBody: string;
  }>;
  readonly proofForEnrollment: (c: H) => Promise<{
    principal: { machineId: string; accountId: string } | null;
    publicKeyX: string;
    subjectId: string;
    rawBody: string;
  }>;
  readonly clientIp: (c: H) => string | null;
  readonly ifNoneMatch: (c: H, currentHash: string) => boolean;
}

const MAX_BODY_BYTES = 1 << 20; // 1 MiB: envelopes cap at 256 KiB + JSON frame.

export function createApp(ctx: RequestContext) {
  const app = new Hono<{ Variables: { requestId: string } }>();
  const cfg = configFromEnv(ctx.env.vars, ctx.now);
  const layers: Layer.Layer<ServiceEnv, never, never> = Layer.mergeAll(
    Layer.succeed(DbTag, { db: ctx.db }),
    Layer.succeed(AppConfigTag, cfg),
    Layer.succeed(TxTag, ctx.txRunner),
    Layer.succeed(MailTag, {
      send: (m) => {
        if (ctx.mailSink) {
          ctx.mailSink(m);
          return Effect.void;
        }
        return Effect.tryPromise({
          try: async () => {
            if (ctx.mailer === "log") {
              console.log(`[ast-core mail] to=${m.to} subject=${m.subject} confirm=${m.confirmUrl}`);
              return;
            }
            if (!ctx.resendApiKey) throw new Error("RESEND_API_KEY is not set");
            const from = ctx.env.vars.MAIL_FROM ?? "Ast <noreply@example.invalid>";
            const res = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { Authorization: `Bearer ${ctx.resendApiKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text }),
            });
            if (!res.ok) throw new Error(`mail provider answered ${res.status}`);
          },
          catch: () => new CoreError("internal", "mail delivery failed"),
        });
      },
    }),
    Layer.succeed(StorageTag, { r2: ctx.r2 }),
  );

  // Typed failures propagate as the thrown value (never FiberFailure), so
  // the boundary below can match CoreError directly. Defects still become
  // a generic 500 with no detail leaked.
  const run = async <A, E>(eff: Effect.Effect<A, E, ServiceEnv>): Promise<A> => {
    const exit = await Effect.runPromiseExit(Effect.provide(eff, layers));
    if (exit._tag === "Success") return exit.value;
    const f = Cause.failureOption(exit.cause);
    if (f._tag === "Some") throw f.value as E;
    throw new CoreError("internal", "internal error");
  };

  const fail = (c: H, e: unknown): Response => {
    const requestId = c.get("requestId");
    if (e instanceof CoreError) {
      return c.json({ error: { code: e.code, message: e.message, requestId } }, e.status as 400);
    }
    if (ParseResult.isParseError(e)) {
      return c.json({ error: { code: "bad_request", message: "invalid request", requestId } }, 400);
    }
    return c.json({ error: { code: "internal", message: "internal error", requestId } }, 500);
  };

  const ok = (c: H, schema: AnySchema, value: unknown, status?: number): Response => {
    const encoded = C.encodeResponse(schema as Schema.Schema<unknown, unknown>, value);
    return c.json(encoded, (status ?? 200) as 200);
  };

  const readBounded = async (body: ReadableStream<Uint8Array> | null): Promise<string> => {
    if (!body) return "";
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw payloadTooLarge();
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const ch of chunks) {
      buf.set(ch, off);
      off += ch.byteLength;
    }
    return new TextDecoder().decode(buf);
  };

  const readBody = async (c: H): Promise<unknown> => {
    const ct = c.req.header("content-type") ?? "";
    if (!ct.includes("application/json")) throw new CoreError("bad_request", "content-type must be application/json");
    const text = await readBounded(c.req.raw.body);
    c.set("rawBody", text);
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CoreError("bad_request", "invalid json");
    }
  };

  // Trusted client IP: Cloudflare's header in production, where XFF is
  // client-controlled and ignored. XFF only in dev/test (explicit override).
  const clientIp = (c: H): string | null => {
    const cf = c.req.header("cf-connecting-ip")?.trim() || null;
    if (cfg.coreEnv === "production") return cf;
    return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || cf;
  };

  const sessionOf = async (c: H): Promise<{ principal: Auth.SessionPrincipal; via: "bearer" | "cookie" }> => {
    const auth = c.req.header("authorization") ?? "";
    const cookie = c.req.header("cookie") ?? "";
    let token: string | null = null;
    let via: "bearer" | "cookie" = "cookie";
    const m = /^Bearer\s+(.+)$/.exec(auth);
    if (m?.[1]) {
      token = m[1].trim();
      via = "bearer";
    }
    if (!token) {
      const part = cookie.split(";").map((s) => s.trim()).find((s) => s.startsWith("ast_session="));
      if (part) token = decodeURIComponent(part.slice("ast_session=".length));
    }
    if (!token) throw unauthorized("authentication required");
    return { principal: await run(Auth.requireSession(token)), via };
  };

  // Cookie-authenticated mutations require a same-origin Origin (CSRF).
  // Bearer-authenticated calls are explicit and exempt.
  const sessionForMutation = async (c: H): Promise<Auth.SessionPrincipal> => {
    const { principal, via } = await sessionOf(c);
    if (via === "cookie") {
      const origin = c.req.header("origin");
      if (!origin) throw forbidden("origin required");
      let o: URL;
      try {
        o = new URL(origin);
      } catch {
        throw forbidden("bad origin");
      }
      if (o.origin !== new URL(c.req.url).origin) throw forbidden("cross-origin forbidden");
    }
    return principal;
  };

  const proofFor = async (c: H, kind: "machine" | "enrollment") => {
    const subjectId = c.req.header("x-ast-machine") ?? "";
    const timestamp = c.req.header("x-ast-timestamp") ?? "";
    const nonce = c.req.header("x-ast-nonce") ?? "";
    const m = /^AST-Machine\s+(.+)$/.exec(c.req.header("authorization") ?? "");
    const rawBody = await readBounded(c.req.raw.body);
    const url = new URL(c.req.url);
    const who = await run(
      Machines.authenticateMachineProof({
        subjectId,
        timestamp,
        nonce,
        signature: (m?.[1] ?? "").trim(),
        method: c.req.method,
        pathAndQuery: url.pathname + url.search,
        rawBody,
      }),
    );
    if (kind === "machine" && (!who.machineId || !who.accountId)) {
      throw unauthorized("machine authentication required");
    }
    if (kind === "enrollment" && !subjectId.startsWith("enr_")) {
      throw unauthorized("enrollment authentication required");
    }
    return {
      principal: who.machineId && who.accountId ? { machineId: who.machineId, accountId: who.accountId } : null,
      publicKeyX: who.publicKeyX,
      subjectId,
      rawBody,
    };
  };

  const proofForMachine = async (c: H) => {
    const r = await proofFor(c, "machine");
    if (!r.principal) throw unauthorized("machine authentication required");
    return { principal: r.principal, publicKeyX: r.publicKeyX, subjectId: r.subjectId, rawBody: r.rawBody };
  };
  const proofForEnrollment = (c: H) => proofFor(c, "enrollment");

  const sessionCookie = (c: H, token: string | null, maxAge: number) => {
    const secure = cfg.publicBaseUrl.startsWith("https://") ? "; Secure" : "";
    c.header("Set-Cookie", `ast_session=${token ? encodeURIComponent(token) : ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
  };

  // Checksum precondition: If-None-Match carries a previously seen content
  // hash (strong ETag, quoted, or *). Evaluated only after authentication.
  const ifNoneMatch = (c: H, currentHash: string): boolean => {
    const header = c.req.header("if-none-match");
    if (!header) return false;
    for (const part of header.split(",")) {
      const t = part.trim().replace(/^W\//, "");
      if (t === "*") return true;
      if (t.length >= 2 && t.startsWith('"') && t.endsWith('"') && t.slice(1, -1) === currentHash) {
        return true;
      }
    }
    return false;
  };

  app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    await next();
    c.header("X-Request-Id", c.get("requestId") as string);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    // Credential-bearing responses are never cached. Public metadata
    // handlers below opt into short caching explicitly.
    if (!c.res.headers.get("cache-control")) c.header("Cache-Control", "no-store");
  });

  const cached = (c: H, seconds: number) => c.header("Cache-Control", `public, max-age=${seconds}`);

  // -- meta ---------------------------------------------------------------
  app.get("/v1/version", (c) => {
    const h = c as unknown as H;
    cached(h, 60);
    return ok(h, C.VersionResp as AnySchema, { api: "1", contracts: "1.0.0", jwksUri: "/.well-known/jwks.json", openapi: "/v1/openapi.json" });
  });
  app.get("/v1/openapi.json", (c) => {
    const h = c as unknown as H;
    cached(h, 300);
    return h.json(openapiDoc);
  });
  app.get("/.well-known/jwks.json", async (c) => {
    const h = c as unknown as H;
    try {
      cached(h, 600);
      return ok(h, C.JwksResp as AnySchema, await run(Grants.jwks()));
    } catch (e) {
      return fail(h, e);
    }
  });
  app.get("/v1/grants/revocations", async (c) => {
    const h = c as unknown as H;
    try {
      cached(h, 60);
      return ok(h, C.RevocationsResp as AnySchema, await run(Grants.revocations()));
    } catch (e) {
      return fail(h, e);
    }
  });

  // -- magic link ----------------------------------------------------------
  app.post("/v1/auth/magic/request", async (c) => {
    const h = c as unknown as H;
    try {
      const input = C.decodeRequest(C.MagicRequest, await readBody(h));
      return ok(h, C.MagicRequestResp as AnySchema, await run(Auth.requestMagicLink({ ...input, ip: clientIp(h) })));
    } catch (e) {
      return fail(h, e);
    }
  });
  app.post("/v1/auth/magic/status", async (c) => {
    const h = c as unknown as H;
    try {
      const input = C.decodeRequest(C.MagicStatusReq, await readBody(h));
      return ok(h, C.MagicStatusResp as AnySchema, await run(Auth.loginRequestStatus(input)));
    } catch (e) {
      return fail(h, e);
    }
  });
  app.post("/v1/auth/magic/consume", async (c) => {
    const h = c as unknown as H;
    try {
      const input = C.decodeRequest(C.MagicConsumeReq, await readBody(h));
      return ok(h, C.MagicConsumeResp as AnySchema, await run(Auth.consumeMagicLink({ ...input, ip: clientIp(h) })));
    } catch (e) {
      return fail(h, e);
    }
  });
  app.post("/v1/auth/magic/finalize", async (c) => {
    const h = c as unknown as H;
    try {
      const input = C.decodeRequest(C.MagicFinalizeReq, await readBody(h));
      const r = await run(Auth.finalizeMagicLink({ ...input, ip: clientIp(h), userAgent: h.req.header("user-agent") ?? null }));
      sessionCookie(h, r.rawToken, 30 * 24 * 60 * 60);
      const { rawToken: _t, ...rest } = r;
      void _t;
      return ok(h, C.MagicFinalizeResp as AnySchema, rest);
    } catch (e) {
      return fail(h, e);
    }
  });

  // -- totp / sessions / me -------------------------------------------------
  app.post("/v1/auth/totp/enroll", async (c) => {
    const h = c as unknown as H;
    try {
      const s = await sessionForMutation(h);
      return ok(h, C.TotpEnrollResp as AnySchema, await run(Auth.enrollTotp(s.accountId)));
    } catch (e) {
      return fail(h, e);
    }
  });
  app.post("/v1/auth/totp/verify", async (c) => {
    const h = c as unknown as H;
    try {
      const s = await sessionForMutation(h);
      const input = C.decodeRequest(C.TotpVerifyReq, await readBody(h));
      return ok(h, C.TotpVerifyResp as AnySchema, await run(Auth.verifyTotpEnroll(s.accountId, input.code)));
    } catch (e) {
      return fail(h, e);
    }
  });
  app.post("/v1/auth/totp/disable", async (c) => {
    const h = c as unknown as H;
    try {
      const s = await sessionForMutation(h);
      const input = C.decodeRequest(C.TotpDisableReq, await readBody(h));
      return ok(h, C.TotpDisableResp as AnySchema, await run(Auth.disableTotp(s.accountId, input.code)));
    } catch (e) {
      return fail(h, e);
    }
  });
  app.get("/v1/me", async (c) => {
    const h = c as unknown as H;
    try {
      const { principal: s } = await sessionOf(h);
      const [machines, providers, latest] = await Promise.all([
        run(Machines.listMachines(s.accountId)),
        run(Vault.listProviderConnections(s.accountId)),
        run(ConfigSvc.latestBundle(s.accountId)),
      ]);
      return ok(h, C.MeResp as AnySchema, {
        accountId: s.accountId,
        email: s.email,
        displayName: s.displayName,
        totpEnrolled: s.totpEnrolled,
        machines: machines.machines,
        providerConnections: providers.connections.map((p) => ({
          id: p.id,
          provider: p.provider,
          label: p.label,
          revokedAt: p.revokedAt,
          assignedMachineIds: p.assignedMachineIds,
        })),
        latestConfigVersion: latest.bundle?.version ?? null,
      });
    } catch (e) {
      return fail(h, e);
    }
  });
  app.get("/v1/sessions", async (c) => {
    const h = c as unknown as H;
    try {
      const { principal: s } = await sessionOf(h);
      return ok(h, C.SessionListResp as AnySchema, await run(Auth.listSessions(s.accountId, 50)));
    } catch (e) {
      return fail(h, e);
    }
  });

  const currentToken = (h: H): string => {
    const auth = h.req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/.exec(auth);
    if (m?.[1]?.trim()) return m[1].trim();
    const cookie = h.req.header("cookie") ?? "";
    const part = cookie.split(";").map((x) => x.trim()).find((x) => x.startsWith("ast_session="));
    if (part) return decodeURIComponent(part.slice("ast_session=".length));
    throw unauthorized("authentication required");
  };

  app.post("/v1/sessions/current/revoke", async (c) => {
    const h = c as unknown as H;
    try {
      if ((await sessionOf(h)).via === "cookie") await sessionForMutation(h);
      await run(Auth.revokeCurrentSession(currentToken(h)));
      sessionCookie(h, null, 0);
      return ok(h, R.logout.responseSchema, { revoked: true });
    } catch (e) {
      return fail(h, e);
    }
  });
  app.post("/v1/sessions/revoke-all", async (c) => {
    const h = c as unknown as H;
    try {
      const s = await sessionForMutation(h);
      await run(Auth.revokeAllSessions(s.accountId));
      sessionCookie(h, null, 0);
      return ok(h, R.sessionsRevokeAll.responseSchema, { revoked: true });
    } catch (e) {
      return fail(h, e);
    }
  });

  // -- machines ---------------------------------------------------------------
  app.post("/v1/machines/enrollments", async (c) => {
    const h = c as unknown as H;
    try {
      const input = C.decodeRequest(C.EnrollmentStartReq, await readBody(h));
      return ok(
        h,
        C.EnrollmentStartResp as unknown as AnySchema,
        await run(Machines.startEnrollment({ publicKeyX: input.publicKey.x, label: input.label, timestamp: input.timestamp, proof: input.proof, ip: clientIp(h) })),
        201,
      );
    } catch (e) {
      return fail(h, e);
    }
  });
  app.post("/v1/machines/enrollments/claim", async (c) => {
    const h = c as unknown as H;
    try {
      const s = await sessionForMutation(h);
      const input = C.decodeRequest(C.EnrollmentClaimReq, await readBody(h));
      return ok(
        h,
        C.EnrollmentClaimResp as AnySchema,
        await run(Machines.claimEnrollmentWithCode({ code: input.code, accountId: s.accountId, email: s.email, ip: clientIp(h) })),
      );
    } catch (e) {
      return fail(h, e);
    }
  });
  app.get("/v1/machines/enrollments/:id/status", async (c) => {
    const h = c as unknown as H;
    try {
      const { publicKeyX, subjectId } = await proofForEnrollment(h);
      const id = h.req.param("id");
      if (subjectId !== id) throw unauthorized("subject mismatch");
      return ok(h, C.EnrollmentStatusResp as unknown as AnySchema, await run(Machines.enrollmentStatus(id, publicKeyX)));
    } catch (e) {
      return fail(h, e);
    }
  });
  app.post("/v1/machines/enrollments/confirm", async (c) => {
    const h = c as unknown as H;
    try {
      const { subjectId, rawBody } = await proofForEnrollment(h);
      const input = C.decodeRequest(C.EnrollmentConfirmReq, rawBody ? (JSON.parse(rawBody) as unknown) : {});
      if (subjectId !== input.enrollmentId) throw unauthorized("subject mismatch");
      return ok(h, C.EnrollmentConfirmResp as AnySchema, await run(Machines.confirmEnrollmentWithKey(input)), 201);
    } catch (e) {
      return fail(h, e);
    }
  });
  app.get("/v1/machines", async (c) => {
    const h = c as unknown as H;
    try {
      const { principal: s } = await sessionOf(h);
      return ok(h, C.MachineListResp as AnySchema, await run(Machines.listMachines(s.accountId)));
    } catch (e) {
      return fail(h, e);
    }
  });
  app.post("/v1/machines/:id/revoke", async (c) => {
    const h = c as unknown as H;
    try {
      const s = await sessionForMutation(h);
      return ok(h, R.machineRevoke.responseSchema, await run(Machines.revokeMachineById(s.accountId, h.req.param("id"))));
    } catch (e) {
      return fail(h, e);
    }
  });

  // -- grants ------------------------------------------------------------------
  app.post("/v1/grants/issue", async (c) => {
    const h = c as unknown as H;
    try {
      if ((h.req.header("x-ast-machine") ?? "").trim()) {
        // Forge path: machine proof, cnf defaults to the enrolled key.
        const { principal, publicKeyX, rawBody } = await proofForMachine(h);
        const input = C.decodeRequest(C.GrantIssueReq, rawBody ? (JSON.parse(rawBody) as unknown) : {});
        const issued = await run(
          Grants.issueGrant({
            accountId: principal.accountId,
            audience: input.audience,
            scope: [...input.scope],
            ttlSeconds: input.ttlSeconds,
            role: "forge",
            mid: input.targetMachineId ?? principal.machineId,
            cnf: { kty: "OKP", crv: "Ed25519", x: publicKeyX },
          }),
        );
        return ok(h, C.GrantIssueResp as AnySchema, { token: issued.token, expiresAt: issued.expiresAt });
      }
      // Editor path: authenticated session, explicit target + ephemeral cnf.
      const s = await sessionForMutation(h);
      const input = C.decodeRequest(C.GrantIssueReq, await readBody(h));
      if (!input.targetMachineId) throw new CoreError("bad_request", "targetMachineId is required");
      if (!input.cnf) throw new CoreError("bad_request", "cnf is required");
      const issued = await run(
        Grants.issueGrant({
          accountId: s.accountId,
          audience: input.audience,
          scope: [...input.scope],
          ttlSeconds: input.ttlSeconds,
          role: "client",
          mid: input.targetMachineId,
          cnf: input.cnf,
        }),
      );
      return ok(h, C.GrantIssueResp as AnySchema, { token: issued.token, expiresAt: issued.expiresAt });
    } catch (e) {
      return fail(h, e);
    }
  });
  app.post("/v1/admin/keys/rotate", async (c) => {
    const h = c as unknown as H;
    try {
      if (!ctx.env.adminToken || h.req.header("x-admin-token") !== ctx.env.adminToken) throw notFound("not found");
      return ok(h, R.keyRotate.responseSchema, await run(Grants.rotateKeys()));
    } catch (e) {
      return fail(h, e);
    }
  });
  app.post("/v1/admin/janitor", async (c) => {
    const h = c as unknown as H;
    try {
      if (!ctx.env.adminToken || h.req.header("x-admin-token") !== ctx.env.adminToken) throw notFound("not found");
      return ok(h, R.janitorRun.responseSchema, await run(janitor(cfg.now())));
    } catch (e) {
      return fail(h, e);
    }
  });

  const scope: RouteScope = {
    run, ok, fail, readBody, sessionOf, sessionForMutation,
    proofForMachine, proofForEnrollment, clientIp, ifNoneMatch,
  };
  registerEditorRoutes(app, scope);

  // -- activity + deletion -------------------------------------------------------------------
  app.get("/v1/activity", async (c) => {
    const h = c as unknown as H;
    try {
      const { principal: s } = await sessionOf(h);
      const limit = Math.min(Math.max(Number(h.req.query("limit") ?? "50") || 50, 1), 200);
      return ok(h, C.ActivityResp as AnySchema, await run(Activity.listForAccount(s.accountId, limit)));
    } catch (e) {
      return fail(h, e);
    }
  });
  app.post("/v1/account/deletion/request", async (c) => {
    const h = c as unknown as H;
    try {
      const s = await sessionForMutation(h);
      const input = C.decodeRequest(C.DeletionRequestReq, await readBody(h));
      if (s.totpEnrolled) {
        await run(Auth.assertSecondFactor(s.accountId, { totpCode: input.totpCode }));
      }
      const opened = await run(Deletion.requestAccountDeletion(s.accountId));
      return ok(h, C.DeletionStatusResp as unknown as AnySchema, { status: opened.status, requestedAt: opened.requestedAt, purgeAfter: opened.purgeAfter, completedAt: null });
    } catch (e) {
      return fail(h, e);
    }
  });
  app.get("/v1/account/deletion", async (c) => {
    const h = c as unknown as H;
    try {
      const { principal: s } = await sessionOf(h);
      return ok(h, C.DeletionStatusResp as AnySchema, await run(Deletion.deletionStatus(s.accountId)));
    } catch (e) {
      return fail(h, e);
    }
  });
  app.post("/v1/account/deletion/cancel", async (c) => {
    const h = c as unknown as H;
    try {
      const s = await sessionForMutation(h);
      await run(Deletion.cancelAccountDeletion(s.accountId));
      return ok(h, C.DeletionStatusResp as AnySchema, await run(Deletion.deletionStatus(s.accountId)));
    } catch (e) {
      return fail(h, e);
    }
  });

  // -- sign-in UI -----------------------------------------------------------------------------
  app.get("/ui/signin", (c) => {
    const h = c as unknown as H;
    h.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    return h.html(signinPage());
  });
  app.get("/ui/claim", (c) => {
    const h = c as unknown as H;
    h.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    return h.html(claimPage());
  });
  app.get("/v1/auth/magic/confirm", (c) => {
    const h = c as unknown as H;
    const token = new URL(h.req.url).searchParams.get("token") ?? "";
    if (!/^[A-Za-z0-9_-]{10,128}$/.test(token)) {
      h.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      return h.html("<p>Invalid link.</p>", 400);
    }
    // Shipped email links enter the correct UI: when the portal SPA is
    // deployed (CORE_SPA_APPROVE_PATH set, e.g. "/#/approve"), redirect
    // there with the token preserved; same-browser/new-tab completion then
    // happens in the SPA via the same consume/finalize API. Otherwise serve
    // the minimal backend approval page (safe fallback, no SPA required).
    const spa = ctx.env.vars.CORE_SPA_APPROVE_PATH;
    if (spa) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${spa}?token=${token}`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    h.header(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    return h.html(confirmPage(token));
  });

  // -- portal SPA hosting (optional) -------------------------------------------------
  // Serves the portal build (web/dist) when the ASSETS binding is present.
  // API, UI, and metadata paths never fall through. Unknown app paths serve
  // the SPA shell (index.html) with no-store + strict CSP so routing stays
  // client-side; hashed static assets keep their upstream cache headers.
  app.get("*", async (c) => {
    const h = c as unknown as H;
    const url = new URL(h.req.url);
    const p = url.pathname;
    if (p.startsWith("/v1/") || p.startsWith("/.well-known/") || p.startsWith("/ui/")) {
      return h.json({ error: { code: "not_found", message: "not found", requestId: h.get("requestId") } }, 404);
    }
    if (!ctx.assets) {
      return h.json({ error: { code: "not_found", message: "not found", requestId: h.get("requestId") } }, 404);
    }
    const direct = await ctx.assets.fetch(c.req.raw);
    if (direct.status !== 404) return direct;
    const shell = await ctx.assets.fetch(new Request(new URL("/index.html", url), { headers: { accept: "text/html" } }));
    if (shell.status === 200) {
      const body = await shell.arrayBuffer();
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
          "Referrer-Policy": "no-referrer",
        },
      });
    }
    return h.json({ error: { code: "not_found", message: "not found", requestId: h.get("requestId") } }, 404);
  });

  return app;
}
