import { describe, expect, it } from "vitest";
import { api, setup_rig, signup } from "../helpers/http.ts";

describe("browser auth: AUTH_PUBLIC_BASE_URL approve + CORS + CSRF allowlist", () => {
  it("mails /approve on the auth origin when configured, legacy confirm otherwise", async () => {
    const rig = await setup_rig({
      vars: {
        AUTH_PUBLIC_BASE_URL: "https://auth.example.invalid",
        DASHBOARD_PUBLIC_BASE_URL: "https://dashboard.example.invalid" } });
    const r1 = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email: "approve@example.com" } });
    expect(r1.status).toBe(200);
    const mailed = rig.mail[rig.mail.length - 1]!;
    expect(mailed.confirm_url.startsWith("https://auth.example.invalid/approve?token=")).toBe(true);

    const plain = await setup_rig();
    const r2 = await api(plain.app, "POST", "/v1/auth/magic/request", { body: { email: "legacy@example.com" } });
    expect(r2.status).toBe(200);
    const mailed_legacy = plain.mail[plain.mail.length - 1]!;
    expect(mailed_legacy.confirm_url.startsWith("http://test.invalid/v1/auth/magic/confirm?token=")).toBe(true);
  });

  it("email approve page POSTs consume; GET confirm never consumes and JSON is stable", async () => {
    const rig = await setup_rig({
      vars: { AUTH_PUBLIC_BASE_URL: "https://auth.example.invalid" } });
    const r1 = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email: "g@example.com" } });
    const { request_id, request_secret } = r1.json as { request_id: string; request_secret: string };
    const token = rig.token_for_email("g@example.com");
    const page = await api(rig.app, "GET", `/v1/auth/magic/confirm?token=${token}`);
    expect(page.status).toBe(200);
    expect((page.json as { status: string }).status).toBe("confirmation_required");
    const st1 = await api(rig.app, "POST", "/v1/auth/magic/status", {
      body: { requestId: request_id, requestSecret: request_secret } });
    expect((st1.json as { status: string }).status).toBe("pending");
    const consume = await api(rig.app, "POST", "/v1/auth/magic/consume", { body: { token } });
    expect(consume.status).toBe(200);
    expect((consume.json as { status: string }).status).toBe("email_approved");
    const done = await api(rig.app, "POST", "/v1/auth/magic/finalize", {
      body: { requestId: request_id, requestSecret: request_secret } });
    expect(done.status).toBe(200);
  });

  it("exact credentialed CORS on success, preflight, and errors with Vary: Origin", async () => {
    const rig = await setup_rig({
      vars: {
        AUTH_PUBLIC_BASE_URL: "https://auth.example.invalid",
        DASHBOARD_PUBLIC_BASE_URL: "https://dashboard.example.invalid" } });
    const pre = await api(rig.app, "OPTIONS", "/v1/me", {
      headers: {
        origin: "https://auth.example.invalid",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization, content-type, if-none-match" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://auth.example.invalid");
    expect(pre.headers.get("access-control-allow-credentials")).toBe("true");
    expect(pre.headers.get("access-control-allow-methods")).toContain("GET");
    expect(pre.headers.get("access-control-allow-headers")).toMatch(/If-None-Match/i);
    expect(pre.headers.get("vary")).toMatch(/Origin/i);

    const ok = await api(rig.app, "GET", "/v1/version", {
      headers: { origin: "https://dashboard.example.invalid" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://dashboard.example.invalid");
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    expect(ok.headers.get("access-control-expose-headers")).toMatch(/ETag/i);
    expect(ok.headers.get("access-control-expose-headers")).toMatch(/X-Request-Id/i);
    expect(ok.headers.get("vary")).toMatch(/Origin/i);

    const evil = await api(rig.app, "GET", "/v1/version", { headers: { origin: "https://evil.invalid" } });
    expect(evil.status).toBe(200);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    expect(evil.headers.get("vary")).toMatch(/Origin/i);

    const err = await api(rig.app, "GET", "/v1/me", {
      headers: { origin: "https://auth.example.invalid", authorization: "Bearer ast_sess_nope" } });
    expect(err.status).toBe(401);
    expect(err.headers.get("access-control-allow-origin")).toBe("https://auth.example.invalid");
    expect(err.headers.get("vary")).toMatch(/Origin/i);

    const missing = await api(rig.app, "GET", "/v1/version", { headers: { origin: "https://evil.invalid" } });
    expect(missing.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("cookie mutations allow same-origin or explicit browser allowlist, bearer exempt", async () => {
    const rig = await setup_rig({
      vars: {
        AUTH_PUBLIC_BASE_URL: "https://auth.example.invalid",
        DASHBOARD_PUBLIC_BASE_URL: "https://dashboard.example.invalid" } });
    const acct = await signup(rig, "csrf-browser@example.com");

    const via_auth = await api(rig.app, "POST", "/v1/auth/totp/enroll", {
      headers: { cookie: acct.cookie, origin: "https://auth.example.invalid" } });
    expect([200, 409]).toContain(via_auth.status);

    const evil = await api(rig.app, "POST", "/v1/auth/totp/enroll", {
      headers: { cookie: acct.cookie, origin: "https://evil.invalid" } });
    expect(evil.status).toBe(403);

    const no_origin = await api(rig.app, "POST", "/v1/auth/totp/enroll", {
      headers: { cookie: acct.cookie } });
    expect(no_origin.status).toBe(403);

    const bearer = await api(rig.app, "POST", "/v1/auth/totp/enroll", {
      headers: { authorization: `Bearer ${acct.token}` } });
    expect([200, 409]).toContain(bearer.status);

    const via_dash = await api(rig.app, "POST", "/v1/sessions/revoke-all", {
      headers: { cookie: acct.cookie, origin: "https://dashboard.example.invalid" } });
    expect(via_dash.status).toBe(200);
  });

  it("bundle ETag conditional reads work cross-origin with exposed validators", async () => {
    const rig = await setup_rig({
      vars: {
        AUTH_PUBLIC_BASE_URL: "https://auth.example.invalid",
        DASHBOARD_PUBLIC_BASE_URL: "https://dashboard.example.invalid" } });
    const acct = await signup(rig, "etag-browser@example.com");
    const browser_cookie = { cookie: acct.cookie, origin: "https://auth.example.invalid" };
    const manifest = {
      format: "ast-editor-config/1",
      mcpServers: [{ name: "x", command: "x" }],
      skills: [{ name: "s", source: "local" }] };
    const pub = await api(rig.app, "POST", "/v1/config/bundles", {
      headers: browser_cookie,
      body: { manifest } });
    expect(pub.status).toBe(201);

    const latest = await api(rig.app, "GET", "/v1/config/bundles/latest", {
      headers: { cookie: acct.cookie, origin: "https://auth.example.invalid" } });
    expect(latest.status).toBe(200);
    const etag = latest.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(latest.headers.get("access-control-allow-origin")).toBe("https://auth.example.invalid");
    expect(latest.headers.get("access-control-expose-headers")).toMatch(/ETag/i);

    const revalidate = await api(rig.app, "GET", "/v1/config/bundles/latest", {
      headers: {
        cookie: acct.cookie,
        origin: "https://auth.example.invalid",
        "if-none-match": etag! } });
    expect(revalidate.status).toBe(304);
    expect(revalidate.headers.get("etag")).toBe(etag);
    expect(revalidate.headers.get("access-control-allow-origin")).toBe("https://auth.example.invalid");
  });

  it("production defaults to known auth/dashboard only when API is prod", async () => {    const { config_from_env } = await import("../../src/services/deps.ts");
    const master = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI";
    const prod = config_from_env({
      CORE_ENV: "production",
      CORE_PUBLIC_BASE_URL: "https://api.artisan.st",
      CORE_MASTER_KEY: master,
      MAIL_PROVIDER: "cloudflare",
      MAIL_FROM: "auth@mail.artisan.st" } as Record<string, string | undefined>);
    expect(prod.auth_public_base_url).toBe("https://auth.artisan.st");
    expect(prod.dashboard_public_base_url).toBe("https://dashboard.artisan.st");
    expect(prod.allowed_browser_origins).toContain("https://api.artisan.st");
    expect(prod.allowed_browser_origins).toContain("https://auth.artisan.st");
    expect(prod.allowed_browser_origins).toContain("https://dashboard.artisan.st");

    const non_prod = config_from_env({
      CORE_ENV: "dev",
      CORE_PUBLIC_BASE_URL: "http://127.0.0.1:8787",
      CORE_MASTER_KEY: master,
      MAIL_PROVIDER: "log" } as Record<string, string | undefined>);
    expect(non_prod.auth_public_base_url).toBeNull();
    expect(non_prod.dashboard_public_base_url).toBeNull();
  });
});
