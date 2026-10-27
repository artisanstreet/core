// Sign-in binding rules: the emailed token alone never signs in, the
// originating secret is required, TOTP cannot be skipped when enrolled.

import { describe, expect, it } from "vitest";
import {
  clear_request_secret,
  finalize_payload,
  load_request_secret,
  next_login_state,
  store_request_secret,
  type LoginState,
} from "../src/auth.ts";

const base: LoginState = {
  request_id: "logreq_01KAAAAAAAAAAAAAAAAAAAAAAAAA",
  email: "a@example.com",
  expires_at: "2026-10-26T20:00:00.000Z",
  phase: "requested",
  totp_required: false,
};

describe("request secret storage", () => {
  it("round-trips within the tab and clears", () => {
    store_request_secret(base.request_id, "shh");
    expect(load_request_secret(base.request_id)).toBe("shh");
    clear_request_secret(base.request_id);
    expect(load_request_secret(base.request_id)).toBeNull();
  });
});

describe("finalize guard", () => {
  const fin = (state: LoginState, opts: { request_secret: string | null; totp_code?: string; recovery_code?: string }) =>
    finalize_payload({ state, opts });

  it("refuses before the emailed link is approved", () => {
    expect(() => fin(base, { request_secret: "shh" })).toThrow(/approved/i);
    expect(() => fin({ ...base, phase: "expired" }, { request_secret: "shh" })).toThrow(/expired/i);
  });

  it("refuses without the originating secret, even when approved", () => {
    const approved = { ...base, phase: "email_approved" as const };
    expect(() => fin(approved, { request_secret: null })).toThrow(/did not start/i);
    expect(() => fin(approved, { request_secret: "" })).toThrow();
  });

  it("requires the second factor when the account is TOTP-enrolled", () => {
    const approved = { ...base, phase: "email_approved" as const, totp_required: true };
    expect(() => fin(approved, { request_secret: "shh" })).toThrow(/authenticator|recovery/i);
    expect(fin(approved, { request_secret: "shh", totp_code: "123456" })).toEqual({
      request_id: base.request_id,
      request_secret: "shh",
      totp_code: "123456",
    });
    expect(fin(approved, { request_secret: "shh", recovery_code: "r1" }).recovery_code).toBe("r1");
  });

  it("passes the plain case through untouched", () => {
    const approved = { ...base, phase: "email_approved" as const };
    expect(fin(approved, { request_secret: "shh" })).toEqual({ request_id: base.request_id, request_secret: "shh" });
  });
});

describe("status mapping", () => {
  it("tracks pending -> approved -> completed without inventing fields", () => {
    let s = next_login_state(base, { status: "pending", totp_required: false, email: base.email, expires_at: base.expires_at });
    expect(s.phase).toBe("pending");
    s = next_login_state(s, { status: "email_approved", totp_required: true, email: base.email, expires_at: base.expires_at });
    expect(s.phase).toBe("email_approved");
    expect(s.totp_required).toBe(true);
  });
});
