import { describe, expect, it } from "vitest";
import { api, setup_rig, signup } from "../helpers/http.ts";

// API-only surface: no SPA shell, no static assets, no HTML pages. Every
// unknown, root, asset, or legacy UI path returns JSON 404 with the shared
// error body; the versioned auth API is unchanged.
describe("api-only surface", () => {
  it("unknown root, app, and asset paths stay JSON 404", async () => {
    const rig = await setup_rig();
    for (const path of ["/", "/dash/projects", "/assets/app-abc123.js", "/index.html", "/ui/signin", "/ui/claim", "/ui/magic/consume", "/v1/nope"]) {
      const res = path === "/ui/magic/consume"
        ? await api(rig.app, "POST", path, { body: { token: "x" } })
        : await api(rig.app, "GET", path);
      expect(res.status).toBe(404);
      expect((res.json as { error: { code: string } }).error.code).toBe("not_found");
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });

  it("confirm GET never consumes", async () => {
    const rig = await setup_rig();
    await signup(rig, "surface@example.com");
    const token = rig.token_for_email("surface@example.com");
    const ok = await api(rig.app, "GET", `/v1/auth/magic/confirm?token=${token}`);
    expect(ok.status).toBe(200);
    expect((ok.json as { status: string }).status).toBe("confirmation_required");
    expect(ok.headers.get("content-type")).toContain("application/json");

    const fresh = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email: "surface-fresh@example.com" } });
    const { requestId: fresh_id, requestSecret: fresh_secret } = fresh.json as { requestId: string; requestSecret: string };
    const fresh_token = rig.token_for_email("surface-fresh@example.com");
    const peek = await api(rig.app, "GET", `/v1/auth/magic/confirm?token=${fresh_token}`);
    expect(peek.status).toBe(200);
    const pending = await api(rig.app, "POST", "/v1/auth/magic/status", { body: { requestId: fresh_id, requestSecret: fresh_secret } });
    expect((pending.json as { status: string }).status).toBe("pending");
  });

  it("same-browser/new-tab completion works through the JSON API", async () => {
    const rig = await setup_rig();
    const r1 = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email: "span@example.com" } });
    const { requestId, requestSecret } = r1.json as { requestId: string; requestSecret: string };
    const token = rig.token_for_email("span@example.com");
    const peek = await api(rig.app, "GET", `/v1/auth/magic/confirm?token=${token}`);
    expect(peek.status).toBe(200);
    const c = await api(rig.app, "POST", "/v1/auth/magic/consume", { body: { token } });
    expect(c.status).toBe(200);
    const f = await api(rig.app, "POST", "/v1/auth/magic/finalize", { body: { requestId, requestSecret } });
    expect(f.status).toBe(200);
    expect(f.headers.get("set-cookie")).toContain("ast_session=");
  });
});
