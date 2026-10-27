import { assert, describe, expect, it } from "vitest";
import { Cause, Effect, Exit } from "effect";
import { api, setup_rig, signup, totp_code_at, totp_code_for } from "../helpers/http.ts";
import { TxTag } from "../../src/services/deps.ts";
import { record } from "../../src/services/activity.ts";
import { CoreError, forbidden } from "../../src/errors.ts";

describe("magic link sign-in", () => {
  it("scanner-safe: GET confirm page never consumes; explicit POST approves", async () => {
    const rig = await setup_rig();
    const r1 = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email: "a@example.com" } });
    expect(r1.status).toBe(200);
    const { request_id, request_secret } = r1.json as { request_id: string; request_secret: string };
    const token = rig.token_for_email("a@example.com");

    // Mail-scanner behavior: plain GETs only.
    const page = await api(rig.app, "GET", `/v1/auth/magic/confirm?token=${token}`);
    expect(page.status).toBe(200);
    expect((page.json as { status: string }).status).toBe("confirmation_required");
    expect(page.headers.get("content-type")).toContain("application/json");
    const bad = await api(rig.app, "GET", "/v1/auth/magic/confirm?token=short");
    expect(bad.status).toBe(400);
    const st1 = await api(rig.app, "POST", "/v1/auth/magic/status", { body: { requestId: request_id, requestSecret: request_secret } });
    expect((st1.json as { status: string }).status).toBe("pending");

    // Finalize before approval is refused.
    const early = await api(rig.app, "POST", "/v1/auth/magic/finalize", { body: { requestId: request_id, requestSecret: request_secret } });
    expect(early.status).toBe(403);

    // Explicit approval from the email.
    const c = await api(rig.app, "POST", "/v1/auth/magic/consume", { body: { token } });
    expect(c.status).toBe(200);
    expect((c.json as { status: string }).status).toBe("email_approved");

    // Re-consuming the same link is idempotent, never a second session.
    const c2 = await api(rig.app, "POST", "/v1/auth/magic/consume", { body: { token } });
    expect(c2.status).toBe(200);

    const f = await api(rig.app, "POST", "/v1/auth/magic/finalize", { body: { requestId: request_id, requestSecret: request_secret } });
    expect(f.status).toBe(200);
    expect((f.json as { totp_verified: boolean }).totp_verified).toBe(false);
    expect(f.headers.get("set-cookie") ?? "").toContain("ast_session=");
  });

  it("unknown tokens reveal nothing", async () => {
    const rig = await setup_rig();
    const c = await api(rig.app, "POST", "/v1/auth/magic/consume", { body: { token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } });
    expect(c.status).toBe(401);
    expect(JSON.stringify(c.json)).not.toContain("a@example.com");
  });

  it("cross-browser: email device approves, original session completes", async () => {
    const rig = await setup_rig();
    const r1 = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email: "b@example.com" } });
    const { request_id, request_secret } = r1.json as { request_id: string; request_secret: string };
    const token = rig.token_for_email("b@example.com");

    // Phone browser: no request secret, marks approval only.
    const phone = await api(rig.app, "POST", "/v1/auth/magic/consume", { body: { token } });
    expect(phone.status).toBe(200);

    // Attacker-style finalize without the secret fails.
    const noSecret = await api(rig.app, "POST", "/v1/auth/magic/finalize", { body: { requestId: request_id, requestSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } });
    expect(noSecret.status).toBe(401);

    // Original session explicitly completes (safe binding: session lands here).
    const done = await api(rig.app, "POST", "/v1/auth/magic/finalize", { body: { requestId: request_id, requestSecret: request_secret } });
    expect(done.status).toBe(200);
    const me = await api(rig.app, "GET", "/v1/me", { headers: { cookie: (done.headers.get("set-cookie") ?? "").split(";")[0]! } });
    expect(me.status).toBe(200);
    expect((me.json as { email: string }).email).toBe("b@example.com");
  });

  it("finalize is single-use under concurrency", async () => {
    const rig = await setup_rig();
    const r1 = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email: "c@example.com" } });
    const { request_id, request_secret } = r1.json as { request_id: string; request_secret: string };
    await api(rig.app, "POST", "/v1/auth/magic/consume", { body: { token: rig.token_for_email("c@example.com") } });
    const [a, b] = await Promise.all([
      api(rig.app, "POST", "/v1/auth/magic/finalize", { body: { requestId: request_id, requestSecret: request_secret } }),
      api(rig.app, "POST", "/v1/auth/magic/finalize", { body: { requestId: request_id, requestSecret: request_secret } }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 403]);
  });

  it("transaction rolls back writes on typed failure", async () => {
    const rig = await setup_rig();
    const acct = await signup(rig, "txrb@example.com");
    const count_probe = async () =>
      ((await rig.db.query("select count(*)::int as n from activity_events where account_id = $1 and kind = 'test.rollback_probe'", [acct.account_id])) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
    expect(await count_probe()).toBe(0);
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(TxTag, (tx) =>
        tx.transaction(
          Effect.gen(function* () {
            yield* record(acct.account_id, "test.rollback_probe", {});
            return yield* Effect.fail(forbidden("boom"));
          }),
        ),
      ).pipe(Effect.provide(rig.layers)),
    );
    expect(exit._tag).toBe("Failure");
    assert(Exit.isFailure(exit));
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).toBe("Some");
    if (failure._tag === "Some") {
      expect(failure.value).toBeInstanceOf(CoreError);
      expect((failure.value as CoreError).code).toBe("forbidden");
    }
    expect(await count_probe()).toBe(0);
  });
});

describe("TOTP second factor", () => {
  it("email alone never bypasses TOTP; codes are single-use with budgets", async () => {
    const rig = await setup_rig();
    rig.set_now(Date.now());
    const T0 = rig.now();
    const acct = await signup(rig, "d@example.com");
    const en = await api(rig.app, "POST", "/v1/auth/totp/enroll", { headers: { cookie: acct.cookie, origin: "http://localhost" } });
    expect(en.status).toBe(200);
    const { otpauth_url, recovery_codes } = en.json as { otpauth_url: string; recovery_codes: string[] };
    expect(recovery_codes).toHaveLength(10);
    // Enrollment confirmation consumes the current step.
    const v = await api(rig.app, "POST", "/v1/auth/totp/verify", {
      headers: { cookie: acct.cookie, origin: "http://localhost" },
      body: { code: totp_code_at(otpauth_url, T0) } });
    expect(v.status).toBe(200);

    // The just-consumed code is dead even though cryptographically valid.
    const r0 = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email: "d@example.com" } });
    const j0 = r0.json as { request_id: string; request_secret: string };
    await api(rig.app, "POST", "/v1/auth/magic/consume", { body: { token: rig.token_for_email("d@example.com") } });
    const replay0 = await api(rig.app, "POST", "/v1/auth/magic/finalize", { body: { requestId: j0.request_id, requestSecret: j0.request_secret, totpCode: totp_code_at(otpauth_url, T0) } });
    expect(replay0.status).toBe(403);

    // New login now requires the factor.
    rig.set_now(T0 + 120_000);
    const r1 = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email: "d@example.com" } });
    const { request_id, request_secret } = r1.json as { request_id: string; request_secret: string };
    await api(rig.app, "POST", "/v1/auth/magic/consume", { body: { token: rig.token_for_email("d@example.com") } });
    const noCode = await api(rig.app, "POST", "/v1/auth/magic/finalize", { body: { requestId: request_id, requestSecret: request_secret } });
    expect(noCode.status).toBe(403);
    const badCode = await api(rig.app, "POST", "/v1/auth/magic/finalize", { body: { requestId: request_id, requestSecret: request_secret, totpCode: "000000" } });
    expect(badCode.status).toBe(403);

    // Valid code works (single-use proven by the replay legs around it).
    const code = totp_code_at(otpauth_url, rig.now());
    const ok = await api(rig.app, "POST", "/v1/auth/magic/finalize", { body: { requestId: request_id, requestSecret: request_secret, totpCode: code } });
    expect(ok.status).toBe(200);
    expect((ok.json as { totp_verified: boolean }).totp_verified).toBe(true);

    // Reusing the just-consumed TOTP code fails even though still in-window.
    const r2 = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email: "d@example.com" } });
    const j2 = r2.json as { request_id: string; request_secret: string };
    await api(rig.app, "POST", "/v1/auth/magic/consume", { body: { token: rig.token_for_email("d@example.com") } });
    const replay = await api(rig.app, "POST", "/v1/auth/magic/finalize", { body: { requestId: j2.request_id, requestSecret: j2.request_secret, totpCode: code } });
    expect(replay.status).toBe(403);

    // Recovery code works once, then dies. (Six requests total including
    // signup; the per-email budget is 10/hour to leave headroom for the
    // legitimate re-request pattern this flow exercises.)
    const r3 = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email: "d@example.com" } });
    const j3 = r3.json as { request_id: string; request_secret: string };
    await api(rig.app, "POST", "/v1/auth/magic/consume", { body: { token: rig.token_for_email("d@example.com") } });
    const rec = await api(rig.app, "POST", "/v1/auth/magic/finalize", { body: { requestId: j3.request_id, requestSecret: j3.request_secret, recoveryCode: recovery_codes[0] } });
    expect(rec.status).toBe(200);
    const r4 = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email: "d@example.com" } });
    const j4 = r4.json as { request_id: string; request_secret: string };
    await api(rig.app, "POST", "/v1/auth/magic/consume", { body: { token: rig.token_for_email("d@example.com") } });
    const rec2 = await api(rig.app, "POST", "/v1/auth/magic/finalize", { body: { requestId: j4.request_id, requestSecret: j4.request_secret, recoveryCode: recovery_codes[0] } });
    expect(rec2.status).toBe(403);
  });

  it("TOTP attempts are budget-limited per account", async () => {
    const rig = await setup_rig();
    const acct = await signup(rig, "e@example.com");
    const en = await api(rig.app, "POST", "/v1/auth/totp/enroll", { headers: { cookie: acct.cookie, origin: "http://localhost" } });
    const { otpauth_url } = en.json as { otpauth_url: string };
    await api(rig.app, "POST", "/v1/auth/totp/verify", {
      headers: { cookie: acct.cookie, origin: "http://localhost" },
      body: { code: totp_code_for(otpauth_url) } });
    const r1 = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email: "e@example.com" } });
    const { request_id, request_secret } = r1.json as { request_id: string; request_secret: string };
    await api(rig.app, "POST", "/v1/auth/magic/consume", { body: { token: rig.token_for_email("e@example.com") } });
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const r = await api(rig.app, "POST", "/v1/auth/magic/finalize", { body: { requestId: request_id, requestSecret: request_secret, totpCode: "000000" } });
      if (r.status === 429) limited++;
      else expect(r.status).toBe(403);
    }
    expect(limited).toBeGreaterThan(0);
  });

  it("enroll-while-enrolled is rejected; outstanding logins follow factor changes", async () => {
    const rig = await setup_rig();
    rig.set_now(Date.now());
    const T0 = rig.now();
    const acct = await signup(rig, "f@example.com");

    // Outstanding login created BEFORE the factor exists.
    const r1 = await api(rig.app, "POST", "/v1/auth/magic/request", { body: { email: "f@example.com" } });
    const j1 = r1.json as { request_id: string; request_secret: string };
    await api(rig.app, "POST", "/v1/auth/magic/consume", { body: { token: rig.token_for_email("f@example.com") } });

    const en = await api(rig.app, "POST", "/v1/auth/totp/enroll", { headers: { cookie: acct.cookie, origin: "http://localhost" } });
    void (en.json as { otpauth_url: string });

    // Re-enrolling while only PENDING replaces the pending secret (no
    // active factor exists yet to protect); the latest secret wins.
    const en2 = await api(rig.app, "POST", "/v1/auth/totp/enroll", { headers: { cookie: acct.cookie, origin: "http://localhost" } });
    expect(en2.status).toBe(200); // staged pending, not yet active
    const { otpauth_url: url2 } = en2.json as { otpauth_url: string };
    const v = await api(rig.app, "POST", "/v1/auth/totp/verify", {
      headers: { cookie: acct.cookie, origin: "http://localhost" },
      body: { code: totp_code_at(url2, T0) } });
    expect(v.status).toBe(200);

    // The outstanding request was approved pre-enrollment but finalizes
    // against CURRENT factor state: code required now.
    const noCode = await api(rig.app, "POST", "/v1/auth/magic/finalize", { body: { requestId: j1.request_id, requestSecret: j1.request_secret } });
    expect(noCode.status).toBe(403);
    rig.set_now(T0 + 120_000);
    const withCode = await api(rig.app, "POST", "/v1/auth/magic/finalize", {
      body: { requestId: j1.request_id, requestSecret: j1.request_secret, totpCode: totp_code_at(url2, rig.now()) } });
    expect(withCode.status).toBe(200);

    // Enrolling again while active is a conflict (disable first).
    const en3 = await api(rig.app, "POST", "/v1/auth/totp/enroll", { headers: { cookie: acct.cookie, origin: "http://localhost" } });
    expect(en3.status).toBe(409);

    // Disable requires the live code; wrong code fails.
    const disBad = await api(rig.app, "POST", "/v1/auth/totp/disable", {
      headers: { cookie: acct.cookie, origin: "http://localhost" },
      body: { code: "000000" } });
    expect(disBad.status).toBe(403);
    rig.set_now(T0 + 240_000);
    const dis = await api(rig.app, "POST", "/v1/auth/totp/disable", {
      headers: { cookie: acct.cookie, origin: "http://localhost" },
      body: { code: totp_code_at(url2, rig.now()) } });
    expect(dis.status).toBe(200);
  });
});
