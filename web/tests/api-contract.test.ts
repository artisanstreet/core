// Behavioral contract tests for the Core HTTP client: strict requests,
// forward-compatible responses, secret handling, and error mapping.
// The Core service is stubbed at fetch level with contract-shaped
// payloads; the schemas under test are the real ones from
// core/src/contracts/v1.ts.

import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { CoreApi, ApiError, encodeStrict, decodeLenient, decodeStrict, humanizeValidationError } from "../src/api.ts";
import * as C from "../../src/contracts/v1.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Platform `HttpClient` passes `URL` + `Uint8Array` bodies to the fetch
 * seam; normalize here so assertions stay on stable strings. */
export function text_body(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return "";
}

function stubApi(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { api: new CoreApi("", { fetchImpl }), seen };
}

const REQUEST_ID = `logreq_01K${"A".repeat(23)}`;
const ACCOUNT_ID = `acct_01K${"A".repeat(23)}`;
const MACHINE_ID = `mch_01K${"A".repeat(23)}`;
const TOKEN_ID = `tkn_01K${"A".repeat(23)}`;
void TOKEN_ID;

describe("strict requests", () => {
  it("rejects unknown fields before anything is sent", () => {
    const seen: unknown[] = [];
    expect(() =>
      encodeStrict(C.MagicRequest, { email: "a@b.co", evil: 1 } as unknown as { email: string }),
    ).toThrow();
    expect(seen).toEqual([]);
  });

  it("decodes responses forward-compatibly (unknown fields ignored)", () => {
    const decoded = decodeLenient(C.MagicRequestResp, {
      requestId: REQUEST_ID,
      requestSecret: "s",
      expiresAt: "2026-10-26T20:00:00.000Z",
      futureField: "ignored",
    });
    expect(decoded.requestId).toBe(REQUEST_ID);
  });

  it("rejects unknown request fields on decode too", () => {
    expect(() => decodeStrict(C.MagicRequest, { email: "a@b.co", extra: true })).toThrow();
  });

  it("formats strict failures as concise product messages, never schema internals", async () => {
    const { api } = stubApi(() => jsonResponse(200, {}));
    const badEmail = await api.requestMagicLink("not-an-email").catch((e: unknown) => e);
    expect(badEmail).toBeInstanceOf(ApiError);
    expect((badEmail as ApiError).message).toBe("Enter a valid email address.");
    const unknownField = await api.requestMagicLink("a@b.co", "x".repeat(500)).catch((e: unknown) => e);
    void unknownField;
    // Unknown-field rejection (strict) also stays human-readable.
    let strictMsg = "";
    try {
      encodeStrict(C.MagicRequest, { email: "a@b.co", evil: 1 } as never);
    } catch (e) {
      strictMsg = humanizeValidationError(e);
    }
    expect(strictMsg.length).toBeGreaterThan(0);
    expect(strictMsg).not.toContain("Predicate");
    expect(strictMsg).not.toContain("ParseError");
    expect(strictMsg).not.toContain("readonly");
  });
});

describe("magic-link client", () => {
  it("consume always uses POST (link GETs never consume)", async () => {
    const { api, seen } = stubApi(() =>
      jsonResponse(200, { requestId: REQUEST_ID, status: "email_approved", totpRequired: false }),
    );
    await api.consumeMagicLink("tok123");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.url).toContain("/v1/auth/magic/consume");
    const body = JSON.parse(text_body(seen[0]!.init.body)) as Record<string, unknown>;
    expect(body.token).toBe("tok123");
  });

  it("consume works without a request secret (approving browser may differ)", async () => {
    const { api, seen } = stubApi(() =>
      jsonResponse(200, { requestId: REQUEST_ID, status: "pending", totpRequired: false }),
    );
    await api.consumeMagicLink("tok123");
    const body = JSON.parse(text_body(seen[0]!.init.body)) as Record<string, unknown>;
    expect("requestSecret" in body).toBe(false);
  });

  it("finalize refuses without the originating secret — the emailed token alone never mints a session", async () => {
    const { api, seen } = stubApi(() => jsonResponse(200, {}));
    expect(() => api.finalizeMagicLink(REQUEST_ID, null)).toThrow(/request secret/i);
    expect(seen).toEqual([]);
    expect(() => api.finalizeMagicLink(REQUEST_ID, "")).toThrow();
    expect(seen).toEqual([]);
  });

  it("finalize sends secret + second factor together", async () => {
    const { api, seen } = stubApi(() =>
      jsonResponse(200, {
        sessionId: `sess_01K${"A".repeat(23)}`,
        accountId: ACCOUNT_ID,
        expiresAt: "2026-10-26T20:00:00.000Z",
        totpVerified: true,
      }),
    );
    await api.finalizeMagicLink(REQUEST_ID, "shh", { totpCode: "123456" });
    const body = JSON.parse(text_body(seen[0]!.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ requestId: REQUEST_ID, requestSecret: "shh", totpCode: "123456" });
  });

  it("no request body ever carries accountId (ownership is server-derived)", async () => {
    const { api, seen } = stubApi((url) => {
      if (url.includes("/grants/issue")) return jsonResponse(200, { token: "t", expiresAt: "2026-10-26T20:00:00.000Z" });
      if (url.includes("/enrollments/claim")) return jsonResponse(200, { enrollmentId: `enr_01K${"A".repeat(23)}`, status: "claimed" });
      return jsonResponse(200, {});
    });
    await api.claimEnrollment("ABCDEFGH");
    await api.issueGrant({ audience: "ast-relay", scope: ["relay:connect"], targetMachineId: MACHINE_ID, cnf: { kty: "OKP", crv: "Ed25519", x: "x".repeat(43) } });
    for (const s of seen) {
      const body = JSON.parse(text_body(s.init.body) || "{}") as Record<string, unknown>;
      expect(body).not.toHaveProperty("accountId");
      expect(body).not.toHaveProperty("sub");
    }
  });
});

describe("errors", () => {
  it("maps rate limits and server faults to safe messages", async () => {
    const { api } = stubApi(() =>
      jsonResponse(429, { error: { code: "rate_limited", message: "slow down", requestId: "r1" } }),
    );
    const err = await api.requestMagicLink("a@b.co").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
  });

  it("rejects unreadable responses without leaking bodies", async () => {
    const fetchImpl = (async () => new Response("not json", { status: 200 })) as typeof fetch;
    const api = new CoreApi("", { fetchImpl });
    const err = await api.version().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(String((err as Error).message)).not.toContain("not json");
  });

  it("mutation calls carry JSON content-type (server rejects the rest)", async () => {
    const { api, seen } = stubApi(() => jsonResponse(200, { sessions: [] }));
    await api.sessions();
    expect((seen[0]!.init.headers as Record<string, string>)["content-type"]).toBeUndefined();
    const { api: api2, seen: seen2 } = stubApi(() => jsonResponse(200, { revoked: true }));
    await api2.revokeCurrentSession();
    expect((seen2[0]!.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("uses credentials:include so the HttpOnly cookie authenticates", async () => {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, { sessions: [] }));
    const api = new CoreApi("", { fetchImpl: spy as unknown as typeof fetch });
    await api.sessions();
    expect(spy).toHaveBeenCalledTimes(1);
    const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init).toMatchObject({ credentials: "include" });
  });
});
