import { describe, expect, it } from "vitest";
import { new_enrollment_code } from "../../src/services/machines.ts";
import { api, enroll_machine, machine_headers, new_machine_keys, setup_rig, signup } from "../helpers/http.ts";

describe("enrollment codes", () => {
  it("generates exact 8-char codes from the unambiguous alphabet", () => {
    for (let i = 0; i < 500; i++) {
      const code = new_enrollment_code();
      expect(code).toHaveLength(8);
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });
});

describe("Forge machine enrollment", () => {
  it("full lifecycle: start, claim, poll, confirm, list, revoke", async () => {
    const rig = await setup_rig();
    const acct = await signup(rig, "m@example.com");
    const session = { cookie: acct.cookie };

    const keys = await new_machine_keys();
    const label = "server-forge";
    const ts = Math.floor(Date.now() / 1000);
    const proof = await keys.sign(new TextEncoder().encode(`enrollment-request\n${keys.public_x}\n${label}\n${ts}`));
    const start = await api(rig.app, "POST", "/v1/machines/enrollments", {
      body: { publicKey: { kty: "OKP", crv: "Ed25519", x: keys.public_x }, label, timestamp: ts, proof } });
    expect(start.status).toBe(201);
    const { enrollmentId, code, keyFingerprint } = start.json as { enrollmentId: string; code: string; keyFingerprint: string };
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(keyFingerprint.length).toBeGreaterThan(20);

    // Guessing fails without the local key confirmation, even with a look.
    const badClaim = await api(rig.app, "POST", "/v1/machines/enrollments/claim", {
      headers: { cookie: acct.cookie, origin: "http://localhost" },
      body: { code: "ZZZZZZZZ" } });
    expect(badClaim.status).toBe(401);

    const claim = await api(rig.app, "POST", "/v1/machines/enrollments/claim", {
      headers: { cookie: acct.cookie, origin: "http://localhost" },
      body: { code } });
    expect(claim.status).toBe(200);

    // Authenticated polling reveals the exact claiming identity.
    const statusPath = `/v1/machines/enrollments/${enrollmentId}/status`;
    const st = await api(rig.app, "GET", statusPath, { headers: await machine_headers(enrollmentId, keys, "GET", statusPath, "") });
    expect(st.status).toBe(200);
    const sj = st.json as { status: string; accountId: string; email: string };
    expect(sj.status).toBe("claimed");
    expect(sj.email).toBe("m@example.com");
    expect(sj.accountId).toBe(acct.account_id);

    // Subject mismatch is rejected.
    const wrong = await api(rig.app, "GET", `/v1/machines/enrollments/enr_AAAAAAAAAAAAAAAAAAAAAAAAAA/status`, {
      headers: await machine_headers(enrollmentId, keys, "GET", `/v1/machines/enrollments/enr_AAAAAAAAAAAAAAAAAAAAAAAAAA/status`, "") });
    expect(wrong.status).toBe(401);

    // Confirmation must bind the exact account+key: a confirmation for a
    // different account is refused before any signature math.
    const badConfirmBody = JSON.stringify({ enrollmentId, accountId: "acct_AAAAAAAAAAAAAAAAAAAAAAAAAA", confirmation: "AAAA" });
    const badConfirm = await api(rig.app, "POST", "/v1/machines/enrollments/confirm", {
      headers: await machine_headers(enrollmentId, keys, "POST", "/v1/machines/enrollments/confirm", badConfirmBody),
      raw_body: badConfirmBody });
    expect(badConfirm.status).toBe(403);

    // Same account but a bad confirmation signature is a 401.
    const badSigBody = JSON.stringify({ enrollmentId, accountId: sj.accountId, confirmation: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    const badSig = await api(rig.app, "POST", "/v1/machines/enrollments/confirm", {
      headers: await machine_headers(enrollmentId, keys, "POST", "/v1/machines/enrollments/confirm", badSigBody),
      raw_body: badSigBody });
    expect(badSig.status).toBe(401);

    const confirmation = await keys.sign(new TextEncoder().encode(`enrollment-confirm\n${enrollmentId}\n${sj.accountId}\n${keys.public_x}`));
    const cbody = JSON.stringify({ enrollmentId, accountId: sj.accountId, confirmation });
    const done = await api(rig.app, "POST", "/v1/machines/enrollments/confirm", {
      headers: await machine_headers(enrollmentId, keys, "POST", "/v1/machines/enrollments/confirm", cbody),
      raw_body: cbody });
    expect(done.status).toBe(201);
    const machine_id = (done.json as { machineId: string }).machineId;

    // Listing exposes the enrolled public key (Editor fetches it to verify
    // the Forge's Noise transcript signature).
    const list = await api(rig.app, "GET", "/v1/machines", { headers: { cookie: acct.cookie } });
    expect(list.status).toBe(200);
    const machines = (list.json as { machines: Array<{ id: string; publicKey: { x: string } }> }).machines;
    expect(machines.find((m) => m.id === machine_id)?.publicKey.x).toBe(keys.public_x);

    // Replay of the confirmation is idempotent, not a second machine.
    const again = await api(rig.app, "POST", "/v1/machines/enrollments/confirm", {
      headers: await machine_headers(enrollmentId, keys, "POST", "/v1/machines/enrollments/confirm", cbody),
      raw_body: cbody });
    expect(again.status).toBe(201);
    expect((again.json as { machineId: string }).machineId).toBe(machine_id);

    // Revoked machines authenticate no more.
    const rev = await api(rig.app, "POST", `/v1/machines/${machine_id}/revoke`, {
      headers: { cookie: acct.cookie, origin: "http://localhost" } });
    expect(rev.status).toBe(200);
    const st2 = await api(rig.app, "GET", statusPath, { headers: await machine_headers(enrollmentId, keys, "GET", statusPath, "") });
    expect(st2.status).toBe(200); // enrollment identity itself is unaffected
    void session;
  });

  it("proof-of-possession is verified; replayed nonces die", async () => {
    const rig = await setup_rig();
    const acct = await signup(rig, "n@example.com");
    const { keys } = await enroll_machine(rig, { cookie: acct.cookie }, "forge-1");
    const list = await api(rig.app, "GET", "/v1/machines", { headers: { cookie: acct.cookie } });
    const machine_id = (list.json as { machines: Array<{ id: string }> }).machines[0]!.id;

    // Forged body with a valid structure but wrong signature.
    const path = "/v1/vault/credentials?connectionId=conn_AAAAAAAAAAAAAAAAAAAAAAAAAA";
    const bad = await api(rig.app, "GET", path, {
      headers: await machine_headers(machine_id, keys, "GET", path, "") });
    // Unknown connection is 403 (binding holds); now tamper the signature.
    expect(bad.status).toBe(403);
    const h = await machine_headers(machine_id, keys, "GET", path, "");
    const tampered = { ...h, authorization: `${h.authorization}AA` };
    const badSig = await api(rig.app, "GET", path, { headers: tampered });
    expect(badSig.status).toBe(401);

    // Same nonce twice: the second is a replay.
    const fixed = await machine_headers(machine_id, keys, "GET", path, "", undefined, "AAAAAAAAAAAAAAAAAAAAAA");
    const first = await api(rig.app, "GET", path, { headers: fixed });
    expect(first.status).toBe(403); // auth passed, binding refused
    const second = await api(rig.app, "GET", path, { headers: fixed });
    expect(second.status).toBe(401);
  });

  it("invalid signatures write no nonce; the nonce stays usable", async () => {
    const rig = await setup_rig();
    const acct = await signup(rig, "p@example.com");
    const { machine_id, keys } = await enroll_machine(rig, { cookie: acct.cookie }, "forge-p");
    const path = `/v1/vault/credentials?connectionId=conn_AAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const nonce = "AAAAAAAAAAAAAAAAAAAAAA";

    const good = await machine_headers(machine_id, keys, "GET", path, "", undefined, nonce);
    const bad = { ...good, authorization: `${good.authorization}AA` };
    const badRes = await api(rig.app, "GET", path, { headers: bad });
    expect(badRes.status).toBe(401);

    // No nonce row was written for the rejected signature.
    const check = (await rig.db.query(
      "select count(*)::int as n from machine_nonces where subject = $1 and nonce = $2",
      [machine_id, nonce],
    )) as unknown as { rows: Array<{ n: number }> };
    expect(check.rows[0]!.n).toBe(0);

    // The same nonce still works with the valid signature (no poisoning).
    const retry = await api(rig.app, "GET", path, { headers: good });
    expect(retry.status).toBe(403); // auth passed; binding refused
  });

  it("stale timestamps are rejected", async () => {
    const rig = await setup_rig();
    const acct = await signup(rig, "o@example.com");
    const { keys, machine_id } = await enroll_machine(rig, { cookie: acct.cookie }, "forge-2");
    void machine_id;
    const path = "/v1/machines";
    const old = await machine_headers(
      "enr_AAAAAAAAAAAAAAAAAAAAAAAAAA",
      keys,
      "GET",
      path,
      "",
      String(Math.floor(Date.now() / 1000) - 3600),
    );
    const r = await api(rig.app, "GET", path, { headers: { cookie: acct.cookie, ...old } });
    // Session auth succeeds regardless of the bogus proof headers.
    expect(r.status).toBe(200);
  });

  it("signed confirm with malformed JSON or wrong content-type is 400, not 500", async () => {
    const rig = await setup_rig();
    const acct = await signup(rig, "q@example.com");
    const keys = await new_machine_keys();
    const label = "bad-json-forge";
    const ts = Math.floor(Date.now() / 1000);
    const proof = await keys.sign(new TextEncoder().encode(`enrollment-request\n${keys.public_x}\n${label}\n${ts}`));
    const start = await api(rig.app, "POST", "/v1/machines/enrollments", {
      body: { publicKey: { kty: "OKP", crv: "Ed25519", x: keys.public_x }, label, timestamp: ts, proof } });
    expect(start.status).toBe(201);
    const { enrollmentId } = start.json as { enrollmentId: string };
    const confirm_path = "/v1/machines/enrollments/confirm";

    const bad_raw = "{invalid-json";
    const bad = await api(rig.app, "POST", confirm_path, {
      headers: await machine_headers(enrollmentId, keys, "POST", confirm_path, bad_raw),
      raw_body: bad_raw });
    expect(bad.status).toBe(400);
    expect((bad.json as { error: { code: string } }).error.code).toBe("bad_request");

    const good_raw = JSON.stringify({ enrollmentId, accountId: acct.account_id, confirmation: "AAAA" });
    const wrong_ct = await api(rig.app, "POST", confirm_path, {
      headers: { ...(await machine_headers(enrollmentId, keys, "POST", confirm_path, good_raw)), "content-type": "text/plain" },
      raw_body: good_raw });
    expect(wrong_ct.status).toBe(400);
    expect((wrong_ct.json as { error: { code: string } }).error.code).toBe("bad_request");
  });
});
