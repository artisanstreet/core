import { describe, expect, it } from "vitest";
import { api, setup_rig, signup } from "../helpers/http.ts";

describe("current session", () => {
  it("identifies the requesting session independently for each browser", async () => {
    const rig = await setup_rig();
    const first = await signup(rig, "sessions@example.com");
    const second = await signup(rig, "sessions@example.com");
    const list = async (cookie: string) => {
      const response = await api(rig.app, "GET", "/v1/sessions", { headers: { cookie } });
      expect(response.status).toBe(200);
      return (response.json as { sessions: Array<{ id: string; is_current: boolean }> }).sessions;
    };
    const first_list = await list(first.cookie);
    const second_list = await list(second.cookie);
    expect(first_list.filter((session) => session.is_current)).toHaveLength(1);
    expect(second_list.filter((session) => session.is_current)).toHaveLength(1);
    expect(first_list[0]?.is_current).toBe(true);
    expect(second_list[0]?.is_current).toBe(true);
    expect(first_list[0]?.id).not.toBe(second_list[0]?.id);
  });

  it("records activity and country for the session that made the request", async () => {
    const rig = await setup_rig();
    const first = await signup(rig, "activity@example.com");
    const second = await signup(rig, "activity@example.com");
    const response = await api(rig.app, "GET", "/v1/sessions", { headers: { cookie: first.cookie, "cf-ipcountry": "US" } });
    expect(response.status).toBe(200);
    const sessions = (response.json as { sessions: Array<{ is_current: boolean; last_seen_at: string | null; country_code: string | null }> }).sessions;
    expect(sessions[0]).toMatchObject({ is_current: true, country_code: "US" });
    expect(sessions[0]?.last_seen_at).not.toBeNull();
    expect(sessions.find((session) => !session.is_current)?.country_code).toBeNull();
    const other = await api(rig.app, "GET", "/v1/sessions", { headers: { cookie: second.cookie, "cf-ipcountry": "NO" } });
    expect((other.json as { sessions: Array<{ is_current: boolean; country_code: string | null }> }).sessions[0]).toMatchObject({ is_current: true, country_code: "NO" });
  });

  it("revokes only another session belonging to the authenticated account", async () => {
    const rig = await setup_rig();
    const first = await signup(rig, "owner@example.com");
    const second = await signup(rig, "owner@example.com");
    const outsider = await signup(rig, "other@example.com");
    const owner_list = await api(rig.app, "GET", "/v1/sessions", { headers: { cookie: first.cookie } });
    const sessions = (owner_list.json as { sessions: Array<{ id: string; is_current: boolean }> }).sessions;
    const current = sessions.find((session) => session.is_current)!;
    const other = sessions.find((session) => !session.is_current)!;
    const outsider_list = await api(rig.app, "GET", "/v1/sessions", { headers: { cookie: outsider.cookie } });
    const outsider_id = (outsider_list.json as { sessions: Array<{ id: string }> }).sessions[0]!.id;
    const revoke = (id: string, origin = "http://localhost") => api(rig.app, "POST", `/v1/sessions/${id}/revoke`, { headers: { cookie: first.cookie, origin }, body: {} });
    expect((await revoke(other.id, "https://untrusted.invalid")).status).toBe(403);
    expect((await revoke(outsider_id)).status).toBe(404);
    expect((await revoke(current.id)).status).toBe(404);
    expect((await revoke(other.id)).status).toBe(200);
    expect((await api(rig.app, "GET", "/v1/me", { headers: { cookie: second.cookie } })).status).toBe(401);
    expect((await api(rig.app, "GET", "/v1/me", { headers: { cookie: first.cookie } })).status).toBe(200);
    expect((await api(rig.app, "GET", "/v1/me", { headers: { cookie: outsider.cookie } })).status).toBe(200);
  });
});
