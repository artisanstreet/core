// Sign-in binding rules: the emailed token alone never signs in, the
// originating secret is required, TOTP cannot be skipped when enrolled.

import { describe, expect, it } from "vitest";
import {
  clearRequestSecret,
  finalizePayload,
  loadRequestSecret,
  nextLoginState,
  storeRequestSecret,
  type LoginState,
} from "../src/auth.ts";

const base: LoginState = {
  requestId: "logreq_01KAAAAAAAAAAAAAAAAAAAAAAAAA",
  email: "a@example.com",
  expiresAt: "2026-10-26T20:00:00.000Z",
  phase: "requested",
  totpRequired: false,
};

describe("request secret storage", () => {
  it("round-trips within the tab and clears", () => {
    storeRequestSecret(base.requestId, "shh");
    expect(loadRequestSecret(base.requestId)).toBe("shh");
    clearRequestSecret(base.requestId);
    expect(loadRequestSecret(base.requestId)).toBeNull();
  });
});

describe("finalize guard", () => {
  const fin = (state: LoginState, opts: { requestSecret: string | null; totpCode?: string; recoveryCode?: string }) =>
    finalizePayload({ state, opts });

  it("refuses before the emailed link is approved", () => {
    expect(() => fin(base, { requestSecret: "shh" })).toThrow(/approved/i);
    expect(() => fin({ ...base, phase: "expired" }, { requestSecret: "shh" })).toThrow(/expired/i);
  });

  it("refuses without the originating secret, even when approved", () => {
    const approved = { ...base, phase: "email_approved" as const };
    expect(() => fin(approved, { requestSecret: null })).toThrow(/did not start/i);
    expect(() => fin(approved, { requestSecret: "" })).toThrow();
  });

  it("requires the second factor when the account is TOTP-enrolled", () => {
    const approved = { ...base, phase: "email_approved" as const, totpRequired: true };
    expect(() => fin(approved, { requestSecret: "shh" })).toThrow(/authenticator|recovery/i);
    expect(fin(approved, { requestSecret: "shh", totpCode: "123456" })).toEqual({
      requestId: base.requestId,
      requestSecret: "shh",
      totpCode: "123456",
    });
    expect(fin(approved, { requestSecret: "shh", recoveryCode: "r1" }).recoveryCode).toBe("r1");
  });

  it("passes the plain case through untouched", () => {
    const approved = { ...base, phase: "email_approved" as const };
    expect(fin(approved, { requestSecret: "shh" })).toEqual({ requestId: base.requestId, requestSecret: "shh" });
  });
});

describe("status mapping", () => {
  it("tracks pending -> approved -> completed without inventing fields", () => {
    let s = nextLoginState(base, { status: "pending", totpRequired: false, email: base.email, expiresAt: base.expiresAt });
    expect(s.phase).toBe("pending");
    s = nextLoginState(s, { status: "email_approved", totpRequired: true, email: base.email, expiresAt: base.expiresAt });
    expect(s.phase).toBe("email_approved");
    expect(s.totpRequired).toBe(true);
  });
});
