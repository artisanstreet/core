import { ParseResult, type Schema } from "effect";
import { Context, Effect } from "effect";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Headers from "@effect/platform/Headers";
import { CoreError } from "../errors.ts";
import * as C from "../contracts/v1.ts";

export const max_body_bytes = 1 << 20;

export class RequestIdTag extends Context.Tag("RequestId")<RequestIdTag, string>() {}

export const current_request_id: Effect.Effect<string, never, RequestIdTag> = RequestIdTag;

export function encode_ok<A, I>(schema: Schema.Schema<A, I>, value: NoInfer<A>, status: number = 200) {
  const encoded = C.encodeResponse(schema, value);
  return HttpServerResponse.unsafeJson(encoded, { status });
}

export function encode_fail(e: unknown, request_id: string) {
  if (e instanceof CoreError) {
    return HttpServerResponse.unsafeJson(
      { error: { code: e.code, message: e.message, requestId: request_id } },
      { status: e.status },
    );
  }
  if (ParseResult.isParseError(e)) {
    return HttpServerResponse.unsafeJson(
      { error: { code: "bad_request", message: "invalid request", requestId: request_id } },
      { status: 400 },
    );
  }
  return HttpServerResponse.unsafeJson(
    { error: { code: "internal", message: "internal error", requestId: request_id } },
    { status: 500 },
  );
}

export function with_security_headers(
  res: HttpServerResponse.HttpServerResponse,
  request_id: string,
): HttpServerResponse.HttpServerResponse {
  let out = res.pipe(
    HttpServerResponse.setHeader("X-Request-Id", request_id),
    HttpServerResponse.setHeader("X-Content-Type-Options", "nosniff"),
    HttpServerResponse.setHeader("Referrer-Policy", "no-referrer"),
    HttpServerResponse.setHeader("X-Frame-Options", "DENY"),
  );
  const has_cache = Headers.get(out.headers, "cache-control");
  if (has_cache._tag === "None") {
    out = out.pipe(HttpServerResponse.setHeader("Cache-Control", "no-store"));
  }
  return out;
}

export function session_cookie_value(token: string | null, max_age: number, secure: boolean): string {
  return `ast_session=${token ? encodeURIComponent(token) : ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${max_age}${secure ? "; Secure" : ""}`;
}
