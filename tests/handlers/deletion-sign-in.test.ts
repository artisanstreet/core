import { describe, expect, it } from "vitest";
import { api, setup_rig, signup } from "../helpers/http.ts";

describe("deletion recovery on sign-in", () => {
  it("cancels a pending deletion when the account signs in again", async () => {
    const rig = await setup_rig();
    const first = await signup(rig, "recovery@example.com");
    const request = await api(rig.app, "POST", "/v1/account/deletion/request", { headers: { cookie: first.cookie, origin: "http://localhost" }, body: {} });
    expect(request.status).toBe(200);
    const next = await signup(rig, "recovery@example.com");
    const status = await api(rig.app, "GET", "/v1/account/deletion", { headers: { cookie: next.cookie } });
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ status: "cancelled" });
  });
});
