import { Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  MAX_ACCOUNTS,
  parse_session_cookie,
  pick_session,
  tokens_after_sign_in,
  tokens_without_account,
} from "../../src/http/session-cookie.ts";

const held = [
  { token: "ast_sess_a1", account_id: "acct_a" },
  { token: "ast_sess_b1", account_id: "acct_b" },
];

describe("parse_session_cookie", () => {
  it("reads dot-separated tokens, dropping junk and duplicates", () => {
    expect(parse_session_cookie("ast_sess_a1.ast_sess_b1")).toEqual(["ast_sess_a1", "ast_sess_b1"]);
    expect(parse_session_cookie("ast_sess_a1..nope.ast_sess_a1")).toEqual(["ast_sess_a1"]);
    expect(parse_session_cookie("%E0%A4%A")).toEqual([]);
    expect(parse_session_cookie(undefined)).toEqual([]);
  });

  it("never holds more than the account limit", () => {
    const many = Array.from({ length: MAX_ACCOUNTS + 3 }, (_, i) => `ast_sess_${i}`).join(".");
    expect(parse_session_cookie(many)).toHaveLength(MAX_ACCOUNTS);
  });
});

describe("pick_session", () => {
  it("uses the first account unless one is asked for, and nothing for an account not held", () => {
    expect(pick_session(held, Option.none())).toEqual(Option.some(held[0]));
    expect(pick_session(held, Option.some("acct_b"))).toEqual(Option.some(held[1]));
    expect(pick_session(held, Option.some("acct_c"))).toEqual(Option.none());
  });
});

describe("cookie updates", () => {
  it("puts a new sign-in first and replaces that account's older session", () => {
    expect(tokens_after_sign_in(held, { token: "ast_sess_c1", account_id: "acct_c" })).toEqual([
      "ast_sess_c1",
      "ast_sess_a1",
      "ast_sess_b1",
    ]);
    expect(tokens_after_sign_in(held, { token: "ast_sess_b2", account_id: "acct_b" })).toEqual([
      "ast_sess_b2",
      "ast_sess_a1",
    ]);
  });

  it("signing one account out keeps the others", () => {
    expect(tokens_without_account(held, "acct_a")).toEqual(["ast_sess_b1"]);
    expect(tokens_without_account([held[0]!], "acct_a")).toEqual([]);
  });
});
