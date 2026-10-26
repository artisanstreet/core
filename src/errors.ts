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
  constructor(code: ErrorCode, message: string) {
    super(message);
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

export const badRequest = (m = "bad request") => new CoreError("bad_request", m);
export const unauthorized = (m = "unauthorized") => new CoreError("unauthorized", m);
export const forbidden = (m = "forbidden") => new CoreError("forbidden", m);
export const notFound = (m = "not found") => new CoreError("not_found", m);
export const conflict = (m = "conflict") => new CoreError("conflict", m);
export const gone = (m = "gone") => new CoreError("gone", m);
export const rateLimited = (m = "rate limited") => new CoreError("rate_limited", m);
export const payloadTooLarge = (m = "body too large") => new CoreError("payload_too_large", m);
export const internal = (m = "internal error") => new CoreError("internal", m);
