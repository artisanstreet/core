import { Effect, Either } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { AssetsTag } from "../http/assets.ts";
import { AppConfigTag } from "../services/deps.ts";
import { CoreError } from "../errors.ts";
import { current_request_id } from "../http/response.ts";

export const shell_content_type = "text/html; charset=utf-8";

export function shell_headers_for(relay_origin_raw: string | undefined): Record<string, string> {
  const raw = (relay_origin_raw ?? "").trim().replace(/\/+$/, "");
  let allowlist = "";
  if (raw && !raw.includes("*")) {
    const parsed = Either.getOrNull(Either.try(() => new URL(raw)));
    const u = parsed ?? null;
    if (
      u &&
      (u.protocol === "https:" || u.protocol === "http:") &&
      !u.username && !u.password &&
      (u.pathname === "/" || u.pathname === "") &&
      !u.search && !u.hash &&
      u.hostname
    ) {
      const host = u.hostname.toLowerCase();
      const def_port = u.protocol === "https:" ? "443" : "80";
      const port = u.port && u.port !== def_port ? `:${u.port}` : "";
      const secure = u.protocol === "https:";
      allowlist = ` ${secure ? "https" : "http"}://${host}${port} ${secure ? "wss" : "ws"}://${host}${port}`;
    }
  }
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;` +
      ` connect-src 'self'${allowlist}; frame-ancestors 'none'; base-uri 'none'`,
    "Referrer-Policy": "no-referrer" };
}

const fetch_asset = (
  fetch_fn: (request: Request) => Promise<Response>,
  request: Request,
) =>
  Effect.tryPromise({
    try: () => fetch_fn(request),
    catch: () => new CoreError("not_found", "not found") });

const serve_shell = (
  fetch_fn: (request: Request) => Promise<Response>,
  url: URL,
  relay_origin: string | undefined,
) =>
  Effect.gen(function* () {
    const shell = yield* fetch_asset(fetch_fn, new Request(new URL("/index.html", url), { headers: { accept: "text/html" } }));
    if (shell.status !== 200) {
      return yield* Effect.fail(new CoreError("not_found", "not found"));
    }
    const body = yield* Effect.tryPromise({
      try: () => shell.arrayBuffer(),
      catch: () => new CoreError("internal", "internal error") });
    let res = HttpServerResponse.uint8Array(new Uint8Array(body), { status: 200, contentType: shell_content_type });
    for (const [k, v] of Object.entries(shell_headers_for(relay_origin))) {
      res = res.pipe(HttpServerResponse.setHeader(k, v));
    }
    return res;
  });

const portal_fallback_handler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const cfg = yield* AppConfigTag;
  const assets = yield* AssetsTag;
  const request_id = yield* current_request_id;
  const url = new URL(req.originalUrl);
  const p = url.pathname;
  if (p.startsWith("/v1/") || p.startsWith("/.well-known/") || p.startsWith("/ui/")) {
    return HttpServerResponse.unsafeJson(
      { error: { code: "not_found", message: "not found", requestId: request_id } },
      { status: 404 },
    );
  }
  const original = req.source as unknown as Request;
  if (p === "/" || p === "/index.html") {
    return yield* serve_shell(assets.fetch, url, cfg.env.CORE_RELAY_ORIGIN).pipe(
      Effect.catchAll((e) =>
        Effect.succeed(
          HttpServerResponse.unsafeJson(
            { error: { code: e.code, message: e.message, requestId: request_id } },
            { status: e.status },
          ),
        ),
      ),
    );
  }
  const direct = yield* fetch_asset(assets.fetch, original).pipe(
    Effect.catchAll(() => Effect.succeed(new Response("not found", { status: 404 }))),
  );
  if (direct.status !== 404) {
    return HttpServerResponse.fromWeb(direct);
  }
  const last_segment = p.split("/").pop() ?? "";
  if (last_segment.includes(".")) {
    return HttpServerResponse.unsafeJson(
      { error: { code: "not_found", message: "not found", requestId: request_id } },
      { status: 404 },
    );
  }
  return yield* serve_shell(assets.fetch, url, cfg.env.CORE_RELAY_ORIGIN).pipe(
    Effect.catchAll((e) =>
      Effect.succeed(
        HttpServerResponse.unsafeJson(
          { error: { code: e.code, message: e.message, requestId: request_id } },
          { status: e.status },
        ),
      ),
    ),
  );
});

export const router = HttpRouter.empty.pipe(
  HttpRouter.get(
    "*",
      portal_fallback_handler,
  ),
);
