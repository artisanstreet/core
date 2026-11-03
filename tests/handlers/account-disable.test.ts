import { describe, expect, it } from "vitest";
import { api, enroll_machine, machine_headers, setup_rig, signup } from "../helpers/http.ts";

describe("account disabling", () => {
  it("revokes sessions and suspends machines until successful sign-in", async () => {
    const rig = await setup_rig();
    const first = await signup(rig, "disable@example.com");
    const second = await signup(rig, "disable@example.com");
    const machine = await enroll_machine(rig, first, "test");
    const path = "/v1/vault/connections";
    const machine_request = async () => api(rig.app, "GET", path, { headers: await machine_headers(machine.machine_id, machine.keys, "GET", path, "") });
    expect((await machine_request()).status).toBe(200);
    const disabled = await api(rig.app, "POST", "/v1/account/disable", { headers: { cookie: first.cookie, origin: "http://localhost" }, body: {} });
    expect(disabled.status).toBe(200);
    expect((await api(rig.app, "GET", "/v1/me", { headers: { cookie: first.cookie } })).status).toBe(401);
    expect((await api(rig.app, "GET", "/v1/me", { headers: { cookie: second.cookie } })).status).toBe(401);
    expect((await machine_request()).status).toBe(401);
    const revoked = await api(rig.app, "GET", "/v1/grants/revocations");
    expect((revoked.json as { revoked_machine_ids: string[] }).revoked_machine_ids).toContain(machine.machine_id);
    const signed_in = await signup(rig, "disable@example.com");
    expect((await api(rig.app, "GET", "/v1/me", { headers: { cookie: signed_in.cookie } })).status).toBe(200);
    expect((await api(rig.app, "GET", "/v1/me", { headers: { cookie: first.cookie } })).status).toBe(401);
    expect((await machine_request()).status).toBe(200);
    const restored = await api(rig.app, "GET", "/v1/grants/revocations");
    expect((restored.json as { revoked_machine_ids: string[] }).revoked_machine_ids).not.toContain(machine.machine_id);
  });
});
