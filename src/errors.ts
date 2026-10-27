import { Match } from "effect";

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "payload_too_large"
  | "gone"
  | "internal";

const status_for_code = Match.type<ErrorCode>().pipe(
  Match.when("bad_request", () => 400 as const),
  Match.when("unauthorized", () => 401 as const),
  Match.when("forbidden", () => 403 as const),
  Match.when("not_found", () => 404 as const),
  Match.when("conflict", () => 409 as const),
  Match.when("rate_limited", () => 429 as const),
  Match.when("payload_too_large", () => 413 as const),
  Match.when("gone", () => 410 as const),
  Match.when("internal", () => 500 as const),
  Match.exhaustive,
);

export class CoreError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.status = status_for_code(code);
  }
}

export const bad_request = (m = "bad request", options?: { cause?: unknown }) => new CoreError("bad_request", m, options);
export const unauthorized = (m = "unauthorized", options?: { cause?: unknown }) => new CoreError("unauthorized", m, options);
export const forbidden = (m = "forbidden", options?: { cause?: unknown }) => new CoreError("forbidden", m, options);
export const not_found = (m = "not found", options?: { cause?: unknown }) => new CoreError("not_found", m, options);
export const conflict = (m = "conflict", options?: { cause?: unknown }) => new CoreError("conflict", m, options);
export const gone = (m = "gone", options?: { cause?: unknown }) => new CoreError("gone", m, options);
export const rate_limited = (m = "rate limited") => new CoreError("rate_limited", m);
export const payload_too_large = (m = "body too large") => new CoreError("payload_too_large", m);
export const internal = (m = "internal error", options?: { cause?: unknown }) => new CoreError("internal", m, options);
