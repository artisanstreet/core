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

export class CoreError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.status =
      code === "bad_request" ? 400
      : code === "unauthorized" ? 401
      : code === "forbidden" ? 403
      : code === "not_found" ? 404
      : code === "conflict" ? 409
      : code === "rate_limited" ? 429
      : code === "payload_too_large" ? 413
      : code === "gone" ? 410
      : 500;
  }
}

export const badRequest = (m = "bad request", options?: { cause?: unknown }) => new CoreError("bad_request", m, options);
export const unauthorized = (m = "unauthorized", options?: { cause?: unknown }) => new CoreError("unauthorized", m, options);
export const forbidden = (m = "forbidden", options?: { cause?: unknown }) => new CoreError("forbidden", m, options);
export const notFound = (m = "not found", options?: { cause?: unknown }) => new CoreError("not_found", m, options);
export const conflict = (m = "conflict", options?: { cause?: unknown }) => new CoreError("conflict", m, options);
export const gone = (m = "gone", options?: { cause?: unknown }) => new CoreError("gone", m, options);
export const rateLimited = (m = "rate limited") => new CoreError("rate_limited", m);
export const payloadTooLarge = (m = "body too large") => new CoreError("payload_too_large", m);
export const internal = (m = "internal error", options?: { cause?: unknown }) => new CoreError("internal", m, options);
