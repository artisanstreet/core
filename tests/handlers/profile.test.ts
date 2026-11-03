import { describe, expect, it } from "vitest";
import { api, setup_rig, signup } from "../helpers/http.ts";

describe("account profile", () => {
  it("updates only the signed-in account and enforces unique usernames", async () => {
    const rig = await setup_rig();
    const owner = await signup(rig, "profile-owner@example.com");
    const other = await signup(rig, "profile-other@example.com");
    const post = (cookie: string, path: string, body: object, origin = "http://localhost") =>
      api(rig.app, "POST", `/v1/account/profile/${path}`, { headers: { cookie, origin }, body });
    expect((await post(owner.cookie, "name", { displayName: "  New Name  " })).json).toMatchObject({ display_name: "New Name" });
    expect((await post(owner.cookie, "username", { username: "new-name" })).json).toMatchObject({ username: "new-name" });
    expect((await post(other.cookie, "username", { username: "new-name" })).status).toBe(409);
    expect((await post(other.cookie, "username", { username: "Bad Name" })).status).toBe(400);
    expect((await post(other.cookie, "username", { username: "x" })).json).toMatchObject({ username: "x" });
    expect((await post(owner.cookie, "name", { displayName: "Wrong" }, "https://untrusted.invalid")).status).toBe(403);
    expect((await api(rig.app, "GET", "/v1/account/profile", { headers: { cookie: owner.cookie } })).json).toMatchObject({ display_name: "New Name", username: "new-name" });
    expect((await api(rig.app, "GET", "/v1/account/profile", { headers: { cookie: other.cookie } })).json).toMatchObject({ username: "x" });
    expect((await api(rig.app, "GET", "/v1/account/profile")).status).toBe(401);
  });

  it("rejects invalid avatar data and saves a valid JPEG", async () => {
    const rig = await setup_rig();
    const owner = await signup(rig, "avatar-owner@example.com");
    const post = (avatar: string) => api(rig.app, "POST", "/v1/account/profile/avatar", { headers: { cookie: owner.cookie, origin: "http://localhost" }, body: { avatar } });
    expect((await post("data:image/jpeg;base64,aGVsbG8=")).status).toBe(400);
    const avatar = "data:image/jpeg;base64,/9j/2Q==";
    expect((await post(avatar)).json).toMatchObject({ avatar_url: avatar });
    expect((await api(rig.app, "GET", "/v1/account/profile", { headers: { cookie: owner.cookie } })).json).toMatchObject({ avatar_url: avatar });
  });
  it("saves and clears an account's contact phone without affecting another account", async () => {
    const rig = await setup_rig();
    const owner = await signup(rig, "phone-owner@example.com");
    const other = await signup(rig, "phone-other@example.com");
    const post = (phone: string | null, origin = "http://localhost") => api(rig.app, "POST", "/v1/account/profile/phone", { headers: { cookie: owner.cookie, origin }, body: { phone } });
    expect((await post("1234")).status).toBe(400);
    expect((await post("+14155552671", "https://untrusted.invalid")).status).toBe(403);
    expect((await post("+14155552671")).json).toMatchObject({ phone: "+14155552671" });
    expect((await api(rig.app, "GET", "/v1/account/profile", { headers: { cookie: other.cookie } })).json).toMatchObject({ phone: null });
    expect((await post(null)).json).toMatchObject({ phone: null });
  });

});
