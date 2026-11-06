import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes as random_bytes, utf8ToBytes as utf8_to_bytes } from "@noble/hashes/utils.js";
import { api, b64url, setup_rig, signup, totp_code_at, type TestRig } from "../helpers/http.ts";
import { fake_provider, provider_profile } from "../helpers/oauth.ts";

interface Pkce {
  verifier: string;
  challenge: string;
}

interface Grant {
  code: string;
  expires_at: string;
}

const new_pkce = (): Pkce => {
  const verifier = b64url(random_bytes(32));
  return { verifier, challenge: b64url(sha256(utf8_to_bytes(verifier))) };
};

const browser = (cookie: string) => ({ cookie, origin: "http://localhost" });

const cookie_of = (headers: Headers) => (headers.get("set-cookie") ?? "").split(";")[0]!;

const grant = (rig: TestRig, cookie: string, challenge: string) =>
  api(rig.app, "POST", "/v1/auth/desktop/grant", { headers: browser(cookie), body: { challenge } });

const granted = async (rig: TestRig, cookie: string, challenge: string) => {
  const res = await grant(rig, cookie, challenge);
  expect(res.status).toBe(200);
  return res.json as Grant;
};

const redeem = (rig: TestRig, code: string, verifier: string) =>
  api(rig.app, "POST", "/v1/auth/desktop/redeem", {
    headers: { "user-agent": "ArtisanEditor/1.0" },
    body: { code, verifier } });

const invalid_sign_in = { error: { code: "unauthorized", message: "invalid or expired sign-in" } };

const enroll_totp = async (rig: TestRig, cookie: string) => {
  const en = await api(rig.app, "POST", "/v1/auth/totp/enroll", { headers: browser(cookie) });
  const { otpauth_url } = en.json as { otpauth_url: string };
  const verified = await api(rig.app, "POST", "/v1/auth/totp/verify", {
    headers: browser(cookie),
    body: { code: totp_code_at(otpauth_url, rig.now()) } });
  expect(verified.status).toBe(200);
  return otpauth_url;
};

describe("desktop sign-in handoff", () => {
  it("hands a provider sign-in to the desktop app as a separate session", async () => {
    const fake = fake_provider();
    const rig = await setup_rig({ oauth: fake.client });
    const start = await api(rig.app, "POST", "/v1/auth/oauth/start", { body: { provider: "google" } });
    const flow = start.json as { flow_id: string; flow_secret: string; authorize_url: string };
    const { state, code } = fake.approve(flow.authorize_url, provider_profile());
    await api(rig.app, "POST", "/v1/auth/oauth/callback", {
      body: { flowId: flow.flow_id, flowSecret: flow.flow_secret, state, code } });
    const signed_up = await api(rig.app, "POST", "/v1/auth/oauth/signup", {
      body: { flowId: flow.flow_id, flowSecret: flow.flow_secret, displayName: "Ada" } });
    const web = signed_up.json as { session_id: string; account_id: string };
    const web_cookie = cookie_of(signed_up.headers);

    const pkce = new_pkce();
    const handoff = await granted(rig, web_cookie, pkce.challenge);
    expect(handoff.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(handoff.expires_at) - rig.now()).toBe(120_000);

    const redeemed = await redeem(rig, handoff.code, pkce.verifier);
    expect(redeemed.status).toBe(200);
    const desktop = redeemed.json as { session_id: string; account_id: string; totp_verified: boolean };
    expect(desktop).toMatchObject({ account_id: web.account_id, totp_verified: false });
    expect(desktop.session_id).not.toBe(web.session_id);

    const desktop_cookie = cookie_of(redeemed.headers);
    expect(desktop_cookie).toMatch(/^ast_session=/);
    const me = await api(rig.app, "GET", "/v1/me", { headers: { cookie: desktop_cookie } });
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({ account_id: web.account_id, email: "ada@example.com" });

    const sessions = await api(rig.app, "GET", "/v1/sessions", { headers: { cookie: desktop_cookie } });
    const listed = (sessions.json as { sessions: Array<{ id: string; is_current: boolean }> }).sessions;
    expect(listed.map((s) => s.id).sort()).toEqual([web.session_id, desktop.session_id].sort());

    const activity = await api(rig.app, "GET", "/v1/activity", { headers: { cookie: desktop_cookie } });
    const kinds = (activity.json as { events: Array<{ kind: string }> }).events.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["login.desktop_granted", "login.desktop"]));
  });

  it("keeps the code alive after a wrong verifier and spends it on the first success", async () => {
    const rig = await setup_rig();
    const account = await signup(rig, "verifier@example.com");
    const pkce = new_pkce();
    const handoff = await granted(rig, account.cookie, pkce.challenge);

    const wrong = await redeem(rig, handoff.code, new_pkce().verifier);
    expect(wrong.status).toBe(401);
    expect(wrong.json).toMatchObject(invalid_sign_in);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    expect((await redeem(rig, handoff.code, pkce.verifier)).status).toBe(200);

    const again = await redeem(rig, handoff.code, pkce.verifier);
    expect(again.status).toBe(401);
    expect(again.json).toMatchObject(invalid_sign_in);
  });

  it("refuses unknown and expired codes the same way", async () => {
    const rig = await setup_rig();
    const account = await signup(rig, "expired@example.com");
    const pkce = new_pkce();
    const handoff = await granted(rig, account.cookie, pkce.challenge);

    const unknown = await redeem(rig, b64url(random_bytes(32)), pkce.verifier);
    expect(unknown.status).toBe(401);
    expect(unknown.json).toMatchObject(invalid_sign_in);

    rig.set_now(Date.parse(handoff.expires_at));
    const expired = await redeem(rig, handoff.code, pkce.verifier);
    expect(expired.status).toBe(401);
    expect(expired.json).toMatchObject(invalid_sign_in);
  });

  it("refuses a code whose account was disabled after the grant", async () => {
    const rig = await setup_rig();
    const account = await signup(rig, "disabled@example.com");
    const pkce = new_pkce();
    const handoff = await granted(rig, account.cookie, pkce.challenge);
    const disabled = await api(rig.app, "POST", "/v1/account/disable", { headers: browser(account.cookie), body: {} });
    expect(disabled.status).toBe(200);

    const redeemed = await redeem(rig, handoff.code, pkce.verifier);
    expect(redeemed.status).toBe(401);
    expect(redeemed.json).toMatchObject(invalid_sign_in);
  });

  it("grants only to a cookie session from an allowed origin", async () => {
    const rig = await setup_rig();
    const account = await signup(rig, "origin@example.com");
    const { challenge } = new_pkce();

    const anonymous = await api(rig.app, "POST", "/v1/auth/desktop/grant", {
      headers: { origin: "http://localhost" },
      body: { challenge } });
    expect(anonymous.status).toBe(401);

    const no_origin = await api(rig.app, "POST", "/v1/auth/desktop/grant", {
      headers: { cookie: account.cookie },
      body: { challenge } });
    expect(no_origin.status).toBe(403);

    const foreign = await api(rig.app, "POST", "/v1/auth/desktop/grant", {
      headers: { cookie: account.cookie, origin: "https://evil.test" },
      body: { challenge } });
    expect(foreign.status).toBe(403);
  });

  it("never hands off a session weaker than a full sign-in on a TOTP account", async () => {
    const rig = await setup_rig();
    const account = await signup(rig, "totp@example.com");
    const otpauth_url = await enroll_totp(rig, account.cookie);

    const unverified = await grant(rig, account.cookie, new_pkce().challenge);
    expect(unverified.status).toBe(403);

    rig.set_now(rig.now() + 60_000);
    const request = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email: "totp@example.com" } });
    const { request_id, request_secret } = request.json as { request_id: string; request_secret: string };
    await api(rig.app, "POST", "/v1/auth/magic/consume", { body: { token: rig.token_for_email("totp@example.com") } });
    const finalized = await api(rig.app, "POST", "/v1/auth/magic/finalize", {
      body: { requestId: request_id, requestSecret: request_secret, totpCode: totp_code_at(otpauth_url, rig.now()) } });
    expect(finalized.status).toBe(200);
    const verified_cookie = cookie_of(finalized.headers);

    const pkce = new_pkce();
    const handoff = await granted(rig, verified_cookie, pkce.challenge);
    const redeemed = await redeem(rig, handoff.code, pkce.verifier);
    expect(redeemed.status).toBe(200);
    expect((redeemed.json as { totp_verified: boolean }).totp_verified).toBe(true);
  });

  it("decodes grant and redeem requests strictly", async () => {
    const rig = await setup_rig();
    const account = await signup(rig, "strict@example.com");
    const pkce = new_pkce();

    const bad_grants = [
      {},
      { challenge: pkce.challenge, accountId: account.account_id },
      { challenge: pkce.challenge.slice(1) },
      { challenge: `${pkce.challenge.slice(1)}=` },
      { challenge: 43 },
    ];
    for (const body of bad_grants) {
      const res = await api(rig.app, "POST", "/v1/auth/desktop/grant", { headers: browser(account.cookie), body });
      expect(res.status).toBe(400);
    }

    const handoff = await granted(rig, account.cookie, pkce.challenge);
    const bad_redeems = [
      { code: handoff.code },
      { verifier: pkce.verifier },
      { code: handoff.code, verifier: pkce.verifier, accountId: account.account_id },
      { code: handoff.code, verifier: `${pkce.verifier}A` },
      { code: handoff.code, verifier: pkce.verifier.replace(/^./, "+") },
    ];
    for (const body of bad_redeems) {
      const res = await api(rig.app, "POST", "/v1/auth/desktop/redeem", { body });
      expect(res.status).toBe(400);
    }

    expect((await redeem(rig, handoff.code, pkce.verifier)).status).toBe(200);
  });
});
