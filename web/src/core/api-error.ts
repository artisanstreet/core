// Typed browser API errors. Effect `Data.TaggedError` variants carry
// `status`/`code`/`request_id` for the UI; the Promise facade rethrows
// them as `ApiError` (existing import surface preserved).

import { Data } from "effect";

export class ApiErrorShape {
  constructor(
    readonly code: string,
    readonly message: string,
    readonly request_id: string,
  ) {}
}

export class ApiFailure extends Data.TaggedError("ApiFailure")<{
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly request_id: string;
}> {}

export class TransportFailure extends Data.TaggedError("TransportFailure")<{
  readonly reason: string;
}> {}

export class DecodeFailure extends Data.TaggedError("DecodeFailure")<{
  readonly reason: string;
}> {}

export type BrowserApiError = ApiFailure | TransportFailure | DecodeFailure;

/** Legacy `Error` subclass kept for pages/tests (`err instanceof ApiError`). */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly request_id: string;
  constructor(status: number, body: { code: string; message: string; requestId: string }) {
    super(body.message || body.code);
    this.name = "ApiError";
    this.code = body.code;
    this.status = status;
    this.request_id = body.requestId;
  }
}

/** Convert a typed Effect failure into the legacy `ApiError` at the Promise boundary. */
export function to_legacy_error(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ApiFailure) {
    return new ApiError(err.status, { code: err.code, message: err.message, requestId: err.request_id });
  }
  if (err instanceof TransportFailure) {
    return new ApiError(0, { code: "transport_error", message: "The account service is unreachable. Try again in a bit.", requestId: "" });
  }
  if (err instanceof DecodeFailure) {
    return new ApiError(0, { code: "bad_response", message: "Account service answered with an unreadable shape.", requestId: "" });
  }
  return new ApiError(0, { code: "internal", message: err instanceof Error ? err.message : "Something went wrong.", requestId: "" });
}

export function error_shape(input: unknown): { code: string; message: string; requestId: string } {
  if (typeof input === "object" && input !== null && "error" in input) {
    const e = (input as { error: Record<string, unknown> }).error;
    if (typeof e?.code === "string" && typeof e?.message === "string") {
      return { code: e.code, message: e.message, requestId: typeof e?.requestId === "string" ? e.requestId : "" };
    }
  }
  return { code: "bad_response", message: "Unexpected response from the account service.", requestId: "" };
}
