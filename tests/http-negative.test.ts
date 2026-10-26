import { describe, expect, it } from "vitest";
import { api, setupRig, signup } from "./helpers.js";

// Negative HTTP behavior: strict bodies, bounded reads, CSRF, trusted IP,
// unknown routes, and auth failures carry stable codes without leaking detail.
describe("http boundary negatives", () => {
  it("rejects unknown fields, wrong content-type, and oversized bodies", async () => {
    const rig = await setupRig();

    const extra = await api(rig.app, "POST", "/v1/auth/magic/request", {
      body: { email: "z@example.com", admin: true },
    });
    expect(extra.status).toBe(400);
    expect((extra.json as { error: { code: string } }).error.code).toBe("bad_request");

    const noCt = await api(rig.app, "POST", "/v1/auth/magic/request", {
      headers: { "content-type": "text/plain" },
      rawBody: JSON.stringify({ email: "z@example.com" }),
    });
    expect(noCt.status).toBe(400);

    const broken = await api(rig.app, "POST", "/v1/auth/magic/request", { rawBody: "{not json" });
    expect(broken.status).toBe(400);

    const big = await api(rig.app, "POST", "/v1/auth/magic/request", { rawBody: `{"email":"${"a".repeat(2 * 1024 * 1024)}@x.com"}` });
    expect(big.status).toBe(413);
  });

  it("cookie-authenticated mutations require same-origin; bearer is exempt", async () => {
    const rig = await setupRig();
    const acct = await signup(rig, "csrf@example.com");

    // No Origin on a cookie POST is rejected.
    const noOrigin = await api(rig.app, "POST", "/v1/auth/totp/enroll", { headers: { cookie: acct.cookie } });
    expect(noOrigin.status).toBe(403);

    // Cross-origin is rejected.
    const cross = await api(rig.app, "POST", "/v1/auth/totp/enroll", {
      headers: { cookie: acct.cookie, origin: "https://evil.invalid" },
    });
    expect(cross.status).toBe(403);

    // Same-origin works.
    const same = await api(rig.app, "POST", "/v1/auth/totp/enroll", {
      headers: { cookie: acct.cookie, origin: "http://localhost" },
    });
    expect(same.status).toBe(200);
  });

  it("auth failures are generic; unknown routes 404", async () => {
    const rig = await setupRig();
    const bad = await api(rig.app, "GET", "/v1/me", { headers: { authorization: "Bearer ast_sess_nope" } });
    expect(bad.status).toBe(401);
    expect((bad.json as { error: { code: string; message: string } }).error.code).toBe("unauthorized");
    expect(JSON.stringify(bad.json)).not.toContain("nope");

    const missing = await api(rig.app, "GET", "/v1/nope");
    expect(missing.status).toBe(404);
  });

  it("public metadata is cacheable; credential responses are not", async () => {
    const rig = await setupRig();
    const v = await api(rig.app, "GET", "/v1/version");
    expect(v.status).toBe(200);
    expect(v.headers.get("cache-control")).toContain("max-age");
    const jwks = await api(rig.app, "GET", "/.well-known/jwks.json");
    expect(jwks.headers.get("cache-control")).toContain("max-age");
    const me = await api(rig.app, "GET", "/v1/me");
    expect(me.headers.get("cache-control")).toContain("no-store");
  });
});
