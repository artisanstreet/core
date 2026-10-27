import { Either, ParseResult, type Schema } from "effect";
import { Context, Effect } from "effect";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Headers from "@effect/platform/Headers";
import * as Option from "effect/Option";
import * as Url from "@effect/platform/Url";
import { CoreError } from "../errors.ts";
import * as C from "../contracts/v1.ts";
import { AppConfigTag } from "../services/deps.ts";

export const max_body_bytes = 1 << 20;

export class RequestIdTag extends Context.Tag("RequestId")<RequestIdTag, string>() {}

export const current_request_id: Effect.Effect<string, never, RequestIdTag> = RequestIdTag;

export function encode_ok<A, I>(schema: Schema.Schema<A, I>, value: NoInfer<A>, status: number = 200) {
  const encoded = C.encode_response(schema, value);
  return HttpServerResponse.unsafeJson(encoded, { status });
}

export function encode_fail(e: unknown, request_id: string) {
  if (e instanceof CoreError) {
    return HttpServerResponse.unsafeJson(
      { error: { code: e.code, message: e.message, request_id: request_id } },
      { status: e.status },
    );
  }
  if (ParseResult.isParseError(e)) {
    return HttpServerResponse.unsafeJson(
      { error: { code: "bad_request", message: "invalid request", request_id: request_id } },
      { status: 400 },
    );
  }
  return HttpServerResponse.unsafeJson(
    { error: { code: "internal", message: "internal error", request_id: request_id } },
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

const get_origin_header = (req: HttpServerRequest.HttpServerRequest): string | null => {
  const found = Headers.get(req.headers, "origin");
  if (Option.isNone(found)) return null;
  const trimmed = found.value.trim();
  return trimmed ? trimmed : null;
};

const ensure_vary_origin = (
  res: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const found = Headers.get(res.headers, "vary");
  if (Option.isNone(found)) return res.pipe(HttpServerResponse.setHeader("Vary", "Origin"));
  const parts = found.value.split(",").map((part) => part.trim().toLowerCase());
  if (parts.includes("origin")) return res;
  return res.pipe(HttpServerResponse.setHeader("Vary", `${found.value}, Origin`));
};

const cors_headers = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const cfg = yield* AppConfigTag;
  const origin = get_origin_header(req);
  if (!origin) return { allowed_origin: null as string | null };
  const parsed = Url.fromString(origin);
  if (Either.isLeft(parsed)) return { allowed_origin: null as string | null };
  if (!cfg.allowed_browser_origins.includes(parsed.right.origin)) {
    return { allowed_origin: null as string | null };
  }
  return { allowed_origin: origin };
});

export const with_cors_headers = (res: HttpServerResponse.HttpServerResponse) =>
  cors_headers.pipe(
    Effect.map(({ allowed_origin }) => {
      const with_vary = ensure_vary_origin(res);
      if (!allowed_origin) return with_vary;
      return with_vary.pipe(
        HttpServerResponse.setHeader("Access-Control-Allow-Origin", allowed_origin),
        HttpServerResponse.setHeader("Access-Control-Allow-Credentials", "true"),
        HttpServerResponse.setHeader(
          "Access-Control-Expose-Headers",
          "ETag, X-Content-Sha256, X-Request-Id",
        ),
      );
    }),
  );

export const preflight_response: Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  AppConfigTag | HttpServerRequest.HttpServerRequest | RequestIdTag
> = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const cfg = yield* AppConfigTag;
  const request_id = yield* RequestIdTag;
  const base = HttpServerResponse.empty({ status: 204 });
  const secured = with_security_headers(base, request_id);
  const with_vary = secured.pipe(
    HttpServerResponse.setHeader("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"),
  );
  const origin = get_origin_header(req);
  if (!origin) return with_vary;
  const parsed = Url.fromString(origin);
  if (Either.isLeft(parsed)) return with_vary;
  if (!cfg.allowed_browser_origins.includes(parsed.right.origin)) return with_vary;
  return with_vary.pipe(
    HttpServerResponse.setHeader("Access-Control-Allow-Origin", origin),
    HttpServerResponse.setHeader("Access-Control-Allow-Credentials", "true"),
    HttpServerResponse.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
    HttpServerResponse.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-AST-Machine, X-AST-Timestamp, X-AST-Nonce, X-Admin-Token, If-None-Match",
    ),
    HttpServerResponse.setHeader("Access-Control-Max-Age", "600"),
  );
});

export function session_cookie_value(token: string | null, max_age: number, secure: boolean): string {
  return `ast_session=${token ? encodeURIComponent(token) : ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${max_age}${secure ? "; Secure" : ""}`;
}
