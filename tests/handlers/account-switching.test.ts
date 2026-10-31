import { describe, expect, it } from "vitest";
import { api, setup_rig, signup, type TestRig } from "../helpers/http.ts";

const cookie_of = (headers: Headers) => (headers.get("set-cookie") ?? "").split(";")[0]!;

async function sign_in_beside(rig: TestRig, email: string, cookie: string) {
  const requested = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email } });
  const { request_id, request_secret } = requested.json as { request_id: string; request_secret: string };
  await api(rig.app, "POST", "/v1/auth/magic/consume", { body: { token: rig.token_for_email(email) } });
  const done = await api(rig.app, "POST", "/v1/auth/magic/finalize", {
    headers: { cookie },
    body: { requestId: request_id, requestSecret: request_secret } });
  expect(done.status).toBe(200);
  return { account_id: (done.json as { account_id: string }).account_id, cookie: cookie_of(done.headers) };
}

const me = async (rig: TestRig, cookie: string, account?: string) =>
  api(rig.app, "GET", "/v1/me", { headers: { cookie, ...(account ? { "x-ast-account": account } : {}) } });

describe("account switching", () => {
  it("keeps several accounts signed in on one browser and serves the one asked for", async () => {
    const rig = await setup_rig();
    const ada = await signup(rig, "ada@example.com");
    await signup(rig, "grace@example.com");
    const grace = await sign_in_beside(rig, "grace@example.com", ada.cookie);

    const listed = await api(rig.app, "GET", "/v1/sessions/accounts", { headers: { cookie: grace.cookie } });
    expect((listed.json as { accounts: Array<{ email: string }> }).accounts.map((a) => a.email)).toEqual([
      "grace@example.com",
      "ada@example.com",
    ]);

    expect((await me(rig, grace.cookie)).json).toMatchObject({ email: "grace@example.com" });
    expect((await me(rig, grace.cookie, ada.account_id)).json).toMatchObject({ email: "ada@example.com" });
    expect((await me(rig, grace.cookie, "acct_01M6NOTSIGNEDINHERE0000000")).status).toBe(401);
  });

  it("signing one account out leaves the other signed in", async () => {
    const rig = await setup_rig();
    const ada = await signup(rig, "ada@example.com");
    await signup(rig, "grace@example.com");
    const both = await sign_in_beside(rig, "grace@example.com", ada.cookie);

    const out = await api(rig.app, "POST", "/v1/sessions/current/revoke", {
      headers: { cookie: both.cookie, origin: "http://localhost", "x-ast-account": both.account_id },
      body: {} });
    expect(out.status).toBe(200);
    const left = cookie_of(out.headers);

    const listed = await api(rig.app, "GET", "/v1/sessions/accounts", { headers: { cookie: left } });
    expect((listed.json as { accounts: Array<{ email: string }> }).accounts.map((a) => a.email)).toEqual([
      "ada@example.com",
    ]);
    expect((await me(rig, left)).json).toMatchObject({ email: "ada@example.com" });
    expect((await me(rig, both.cookie, both.account_id)).status).toBe(401);
  });
});
