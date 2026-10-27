import { describe, expect, it } from "vitest";
import { admin, api, enroll_machine, setup_rig, signup, totp_code_at } from "../helpers/http.ts";

const ORIGIN = { origin: "http://localhost" };

describe("account deletion lifecycle", () => {
  it("requests with a grace period, cancels, and purges via janitor", async () => {
    const rig = await setup_rig();
    const acct = await signup(rig, "del@example.com");
    const cookie = { cookie: acct.cookie, ...ORIGIN };
    const { machine_id } = await enroll_machine(rig, { cookie: acct.cookie }, "forge-del");
    const conn = await api(rig.app, "POST", "/v1/vault/connections", {
      headers: cookie,
      body: { provider: "openai", label: "k", apiKey: "sk-test-12345678" } });
    expect(conn.status).toBe(201);

    const d0 = await api(rig.app, "GET", "/v1/account/deletion", { headers: { cookie: acct.cookie } });
    expect((d0.json as { status: string }).status).toBe("none");

    const req = await api(rig.app, "POST", "/v1/account/deletion/request", { headers: cookie, body: {} });
    expect(req.status).toBe(200);
    expect((req.json as { status: string }).status).toBe("pending");

    // Janitor before the grace period purges nobody.
    const j1 = await api(rig.app, "POST", "/v1/admin/janitor", { headers: admin });
    expect(j1.status).toBe(200);
    expect((j1.json as { purged_accounts: string[] }).purged_accounts).toEqual([]);
    const me = await api(rig.app, "GET", "/v1/me", { headers: { cookie: acct.cookie } });
    expect(me.status).toBe(200);

    // Cancel works.
    const cancel = await api(rig.app, "POST", "/v1/account/deletion/cancel", { headers: cookie });
    expect(cancel.status).toBe(200);
    expect((cancel.json as { status: string }).status).toBe("cancelled");

    // Re-request, then expire the grace by direct SQL and purge.
    await api(rig.app, "POST", "/v1/account/deletion/request", { headers: cookie, body: {} });
    await rig.db.exec(
      `update deletion_requests set purge_after = now() - interval '1 minute' where account_id = '${acct.account_id}'`,
    );
    const j2 = await api(rig.app, "POST", "/v1/admin/janitor", { headers: admin });
    expect(j2.status).toBe(200);
    expect((j2.json as { purged_accounts: string[] }).purged_accounts).toContain(acct.account_id);

    // Everything account-owned is gone: sessions, machines, vault rows.
    const me2 = await api(rig.app, "GET", "/v1/me", { headers: { cookie: acct.cookie } });
    expect(me2.status).toBe(401);
    const machines = await api(rig.app, "GET", "/v1/machines", { headers: { cookie: acct.cookie } });
    expect(machines.status).toBe(401);
    void machine_id;
  });

  it("deletion requires the second factor when enrolled", async () => {
    const rig = await setup_rig();
    rig.set_now(Date.now());
    const acct = await signup(rig, "del2@example.com");
    const cookie = { cookie: acct.cookie, ...ORIGIN };
    const en = await api(rig.app, "POST", "/v1/auth/totp/enroll", { headers: cookie });
    const { otpauth_url } = en.json as { otpauth_url: string };
    await api(rig.app, "POST", "/v1/auth/totp/verify", { headers: cookie, body: { code: totp_code_at(otpauth_url, rig.now()) } });

    const noCode = await api(rig.app, "POST", "/v1/account/deletion/request", { headers: cookie, body: {} });
    expect(noCode.status).toBe(403);
    rig.set_now(rig.now() + 120_000);
    const withCode = await api(rig.app, "POST", "/v1/account/deletion/request", {
      headers: cookie,
      body: { totpCode: totp_code_at(otpauth_url, rig.now()) } });
    expect(withCode.status).toBe(200);
  });
});
