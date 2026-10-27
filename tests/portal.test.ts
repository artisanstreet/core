import { describe, expect, it } from "vitest";
import { api, setupRig, signup } from "./helpers.js";

function memoryAssets(files: Record<string, { body: string; contentType: string; cache?: string }>) {
  return {
    fetch: async (request: Request): Promise<Response> => {
      const path = new URL(request.url).pathname;
      const f = files[path];
      if (!f) return new Response("not found", { status: 404 });
      const headers: Record<string, string> = { "Content-Type": f.contentType };
      if (f.cache) headers["Cache-Control"] = f.cache;
      return new Response(f.body, { status: 200, headers });
    },
  };
}

const INDEX = "<!doctype html><html><body>spa</body></html>";

describe("portal confirm entry", () => {
  it("backend page by default; SPA redirect when the approve path is configured", async () => {
    const rig = await setupRig();
    await signup(rig, "spa@example.com");
    const token = rig.tokenForEmail("spa@example.com");

    const page = await api(rig.app, "GET", `/v1/auth/magic/confirm?token=${token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Approve this request");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'unsafe-inline'");
    expect(page.headers.get("cache-control")).toContain("no-store");

    rig.setVar("CORE_SPA_APPROVE_PATH", "/#/approve");
    const redir = await api(rig.app, "GET", `/v1/auth/magic/confirm?token=${token}`);
    expect(redir.status).toBe(302);
    expect(redir.headers.get("location")).toBe(`/#/approve?token=${token}`);
    expect(redir.headers.get("cache-control")).toContain("no-store");

    // Invalid tokens never redirect anywhere.
    const bad = await api(rig.app, "GET", "/v1/auth/magic/confirm?token=short");
    expect(bad.status).toBe(400);
    expect(bad.headers.get("location")).toBeNull();
  });

  it("same-browser/new-tab completion works through the real HTTP service", async () => {
    const rig = await setupRig();
    rig.setVar("CORE_SPA_APPROVE_PATH", "/#/approve");
    const r1 = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email: "span@example.com" } });
    const { requestId, requestSecret } = r1.json as { requestId: string; requestSecret: string };
    const redir = await api(rig.app, "GET", `/v1/auth/magic/confirm?token=${rig.tokenForEmail("span@example.com")}`);
    expect(redir.status).toBe(302);
    // The SPA then calls the same consume/finalize API (simulated here).
    const c = await api(rig.app, "POST", "/v1/auth/magic/consume", { body: { token: rig.tokenForEmail("span@example.com") } });
    expect(c.status).toBe(200);
    const f = await api(rig.app, "POST", "/v1/auth/magic/finalize", { body: { requestId, requestSecret } });
    expect(f.status).toBe(200);
    expect(f.headers.get("set-cookie")).toContain("ast_session=");
  });
});

describe("portal asset hosting", () => {
  it("serves SPA shell with strict CSP + no-store; keeps API 404s JSON", async () => {
    const rig = await setupRig({
      assets: memoryAssets({
        "/index.html": { body: INDEX, contentType: "text/html" },
        "/assets/app-abc123.js": { body: "console.log(1)", contentType: "text/javascript", cache: "public, max-age=31536000, immutable" },
      }),
    });

    const shell = await api(rig.app, "GET", "/dash/projects");
    expect(shell.status).toBe(200);
    expect(shell.text).toBe(INDEX);
    expect(shell.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(shell.headers.get("content-security-policy")).toContain("'wasm-unsafe-eval'");
    // Narrow scope: Wasm compilation allowed, string-eval stays blocked.
    expect(shell.headers.get("content-security-policy")).not.toMatch(/'unsafe-eval'(?!.*wasm)/);
    expect(shell.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(shell.headers.get("cache-control")).toContain("no-store");

    const js = await api(rig.app, "GET", "/assets/app-abc123.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("cache-control")).toContain("immutable");

    // API paths never fall through to the shell.
    const nope = await api(rig.app, "GET", "/v1/nope");
    expect(nope.status).toBe(404);
    expect((nope.json as { error: { code: string } }).error.code).toBe("not_found");
    const ui = await api(rig.app, "GET", "/ui/signin");
    expect(ui.status).toBe(200);
  });

  it("without assets, unknown paths stay JSON 404", async () => {
    const rig = await setupRig();
    const r = await api(rig.app, "GET", "/dash/projects");
    expect(r.status).toBe(404);
    expect((r.json as { error: { code: string } }).error.code).toBe("not_found");
  });
});
