import { describe, expect, it } from "vitest";
import { api, setup_rig, signup, totp_code_at, type Account, type TestRig } from "../helpers/http.ts";
import { fake_provider, provider_profile, type FakeProvider } from "../helpers/oauth.ts";
import type { OauthProfile } from "../../src/services/oauth.ts";

interface Flow {
  flow_id: string;
  flow_secret: string;
  authorize_url: string;
}

const browser = (account: Account) => ({ cookie: account.cookie, origin: "http://localhost" });

async function start(rig: TestRig, provider: "google" | "github", account?: Account): Promise<Flow> {
  const res = account
    ? await api(rig.app, "POST", "/v1/account/sign-in-methods/link", { headers: browser(account), body: { provider } })
    : await api(rig.app, "POST", "/v1/auth/oauth/start", { body: { provider } });
  expect(res.status).toBe(200);
  return res.json as Flow;
}

async function callback(rig: TestRig, fake: FakeProvider, flow: Flow, profile: OauthProfile) {
  const { state, code } = fake.approve(flow.authorize_url, profile);
  return api(rig.app, "POST", "/v1/auth/oauth/callback", {
    body: { flowId: flow.flow_id, flowSecret: flow.flow_secret, state, code } });
}

const cookie_of = (headers: Headers) => (headers.get("set-cookie") ?? "").split(";")[0]!;

async function methods(rig: TestRig, cookie: string) {
  const res = await api(rig.app, "GET", "/v1/account/sign-in-methods", { headers: { cookie } });
  expect(res.status).toBe(200);
  return (res.json as { methods: Array<{ kind: string }> }).methods.map((m) => m.kind);
}

async function oauth_rig() {
  const fake = fake_provider();
  const rig = await setup_rig({ oauth: fake.client });
  return { rig, fake };
}

describe("OAuth sign-up", () => {
  it("prefills the form from the provider and creates an account whose only method is the provider", async () => {
    const { rig, fake } = await oauth_rig();
    const flow = await start(rig, "google");
    expect(new URL(flow.authorize_url).searchParams.get("redirect_uri")).toBe("http://test.invalid/oauth/callback");

    const cb = await callback(rig, fake, flow, provider_profile());
    expect(cb.status).toBe(200);
    expect(cb.json).toEqual({
      outcome: "signup_required",
      email: "ada@example.com",
      display_name: "Ada Lovelace",
      avatar_url: "https://avatars.test/ada.png" });
    expect(cb.headers.get("set-cookie")).toBeNull();

    const done = await api(rig.app, "POST", "/v1/auth/oauth/signup", {
      body: { flowId: flow.flow_id, flowSecret: flow.flow_secret, displayName: "Ada" } });
    expect(done.status).toBe(200);
    const cookie = cookie_of(done.headers);
    const me = await api(rig.app, "GET", "/v1/me", { headers: { cookie } });
    expect(me.json).toMatchObject({ email: "ada@example.com", display_name: "Ada" });
    expect(await methods(rig, cookie)).toEqual(["google"]);

    const again = await api(rig.app, "POST", "/v1/auth/oauth/signup", {
      body: { flowId: flow.flow_id, flowSecret: flow.flow_secret, displayName: "Ada" } });
    expect(again.status).toBe(401);
  });

  it("signs straight back in on the next visit", async () => {
    const { rig, fake } = await oauth_rig();
    const first = await start(rig, "google");
    await callback(rig, fake, first, provider_profile());
    const created = await api(rig.app, "POST", "/v1/auth/oauth/signup", {
      body: { flowId: first.flow_id, flowSecret: first.flow_secret, displayName: "Ada" } });

    const second = await callback(rig, fake, await start(rig, "google"), provider_profile({ verified_email: "renamed@example.com" }));
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ outcome: "signed_in", account_id: (created.json as { account_id: string }).account_id });
    expect(cookie_of(second.headers)).toContain("ast_session=");
  });

  it("refuses to take over an email that already has an account", async () => {
    const { rig, fake } = await oauth_rig();
    const owner = await signup(rig, "ada@example.com");
    const cb = await callback(rig, fake, await start(rig, "google"), provider_profile());
    expect(cb.json).toEqual({ outcome: "email_taken", email: "ada@example.com" });
    expect(await methods(rig, owner.cookie)).toEqual(["email"]);
  });

  it("requires a verified email from the provider", async () => {
    const { rig, fake } = await oauth_rig();
    const cb = await callback(rig, fake, await start(rig, "github"), provider_profile({ verified_email: null }));
    expect(cb.json).toEqual({ outcome: "no_verified_email" });
  });
});

describe("OAuth flow binding", () => {
  it("only the browser holding the flow secret can complete it, once", async () => {
    const { rig, fake } = await oauth_rig();
    const flow = await start(rig, "google");
    const { state, code } = fake.approve(flow.authorize_url, provider_profile());

    const stolen = await api(rig.app, "POST", "/v1/auth/oauth/callback", {
      body: { flowId: flow.flow_id, flowSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", state, code } });
    expect(stolen.status).toBe(401);

    const forged = await api(rig.app, "POST", "/v1/auth/oauth/callback", {
      body: { flowId: flow.flow_id, flowSecret: flow.flow_secret, state: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", code } });
    expect(forged.status).toBe(401);

    const real = await api(rig.app, "POST", "/v1/auth/oauth/callback", {
      body: { flowId: flow.flow_id, flowSecret: flow.flow_secret, state, code } });
    expect((real.json as { outcome: string }).outcome).toBe("signup_required");

    const replay = await api(rig.app, "POST", "/v1/auth/oauth/callback", {
      body: { flowId: flow.flow_id, flowSecret: flow.flow_secret, state, code } });
    expect(replay.status).toBe(401);
  });

  it("is unavailable when the provider has no client credentials", async () => {
    const rig = await setup_rig();
    const res = await api(rig.app, "POST", "/v1/auth/oauth/start", { body: { provider: "github" } });
    expect(res.status).toBe(503);
  });
});

describe("linking and removing sign-in methods", () => {
  it("links GitHub to an email account, then signs in with either", async () => {
    const { rig, fake } = await oauth_rig();
    const account = await signup(rig, "grace@example.com");
    const github = provider_profile({ subject: "gh-42", verified_email: "other@example.com" });

    const linked = await callback(rig, fake, await start(rig, "github", account), github);
    expect(linked.json).toEqual({ outcome: "linked", provider: "github" });
    expect(await methods(rig, account.cookie)).toEqual(["email", "github"]);

    const signed_in = await callback(rig, fake, await start(rig, "github"), github);
    expect(signed_in.json).toMatchObject({ outcome: "signed_in", account_id: account.account_id });
  });

  it("will not link a provider account that belongs to someone else", async () => {
    const { rig, fake } = await oauth_rig();
    const first = await signup(rig, "one@example.com");
    const second = await signup(rig, "two@example.com");
    const github = provider_profile({ subject: "gh-7" });
    await callback(rig, fake, await start(rig, "github", first), github);

    const stolen = await callback(rig, fake, await start(rig, "github", second), github);
    expect(stolen.json).toEqual({ outcome: "linked_elsewhere" });
    expect(await methods(rig, second.cookie)).toEqual(["email"]);
  });

  it("keeps at least one method, and turning email off stops email links", async () => {
    const { rig, fake } = await oauth_rig();
    const account = await signup(rig, "kat@example.com");
    const last = await api(rig.app, "POST", "/v1/account/sign-in-methods/email/remove", { headers: browser(account), body: {} });
    expect(last.status).toBe(409);

    await callback(rig, fake, await start(rig, "google", account), provider_profile({ verified_email: "kat@example.com" }));
    const removed = await api(rig.app, "POST", "/v1/account/sign-in-methods/email/remove", { headers: browser(account), body: {} });
    expect(removed.status).toBe(200);
    expect(await methods(rig, account.cookie)).toEqual(["google"]);

    const request = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email: "kat@example.com" } });
    expect(request.status).toBe(200);
    const notice = rig.mail.at(-1)!;
    expect(notice.to).toBe("kat@example.com");
    expect(notice.text).toContain("email sign-in is off");
    expect(new URL(notice.confirm_url).searchParams.get("token")).toBeNull();

    const back_on = await api(rig.app, "POST", "/v1/account/sign-in-methods/email", { headers: browser(account) });
    expect((back_on.json as { methods: Array<{ kind: string }> }).methods.map((m) => m.kind)).toEqual(["google", "email"]);
    await signup(rig, "kat@example.com");
  });
});

describe("second factor", () => {
  it("a provider sign-in never skips TOTP", async () => {
    const { rig, fake } = await oauth_rig();
    const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);
    rig.set_now(T0);
    const account = await signup(rig, "tess@example.com");
    const en = await api(rig.app, "POST", "/v1/auth/totp/enroll", { headers: browser(account) });
    const { otpauth_url } = en.json as { otpauth_url: string };
    await api(rig.app, "POST", "/v1/auth/totp/verify", { headers: browser(account), body: { code: totp_code_at(otpauth_url, T0) } });
    const github = provider_profile({ subject: "gh-9", verified_email: "tess@example.com" });
    await callback(rig, fake, await start(rig, "github", account), github);

    rig.set_now(T0 + 60_000);
    const flow = await start(rig, "github");
    const cb = await callback(rig, fake, flow, github);
    expect(cb.json).toEqual({ outcome: "second_factor_required" });
    expect(cb.headers.get("set-cookie")).toBeNull();

    const wrong = await api(rig.app, "POST", "/v1/auth/oauth/second-factor", {
      body: { flowId: flow.flow_id, flowSecret: flow.flow_secret, totpCode: "000000" } });
    expect(wrong.status).toBe(403);

    const right = await api(rig.app, "POST", "/v1/auth/oauth/second-factor", {
      body: { flowId: flow.flow_id, flowSecret: flow.flow_secret, totpCode: totp_code_at(otpauth_url, T0 + 60_000) } });
    expect(right.status).toBe(200);
    expect(right.json).toMatchObject({ account_id: account.account_id, totp_verified: true });
  });
});
