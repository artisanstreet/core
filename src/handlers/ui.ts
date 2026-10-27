import { Effect } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { AppConfigTag } from "../services/deps.ts";
import { AssetsTag } from "../http/assets.ts";
import { confirmPage, unavailablePage } from "../ui.ts";

const ui_csp = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";

function html_page(body: string, status: number = 200) {
  return HttpServerResponse.text(body, { status, contentType: "text/html; charset=utf-8" }).pipe(
    HttpServerResponse.setHeader("Content-Security-Policy", ui_csp),
  );
}

function spa_redirect(location: string) {
  return HttpServerResponse.empty({ status: 302 }).pipe(
    HttpServerResponse.setHeader("Location", location),
    HttpServerResponse.setHeader("Cache-Control", "no-store"),
    HttpServerResponse.setHeader("Referrer-Policy", "no-referrer"),
  );
}

const shell_is_deployed = (
  fetch_fn: (request: Request) => Promise<Response>,
  url: URL,
) =>
  Effect.promise(() =>
    fetch_fn(new Request(new URL("/index.html", url), { headers: { accept: "text/html" } })),
  ).pipe(
    Effect.map((res) => res.status === 200),
    Effect.catchAll(() => Effect.succeed(false)),
    Effect.catchAllDefect(() => Effect.succeed(false)),
  );

const default_approve_path = "/#/approve";

export const router = HttpRouter.empty.pipe(
  HttpRouter.get(
    "/ui/signin",
    Effect.gen(function* () {
      const assets = yield* AssetsTag;
      const req = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(req.originalUrl);
      if (yield* shell_is_deployed(assets.fetch, url)) {
        return spa_redirect("/#/signin");
      }
      return html_page(unavailablePage(), 503);
    }),
  ),
  HttpRouter.get(
    "/ui/claim",
    Effect.gen(function* () {
      const assets = yield* AssetsTag;
      const req = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(req.originalUrl);
      if (yield* shell_is_deployed(assets.fetch, url)) {
        return spa_redirect("/#/machines");
      }
      return html_page(unavailablePage(), 503);
    }),
  ),
  HttpRouter.get(
    "/v1/auth/magic/confirm",
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const cfg = yield* AppConfigTag;
      const url = new URL(req.originalUrl);
      const token = url.searchParams.get("token") ?? "";
      if (!/^[A-Za-z0-9_-]{10,128}$/.test(token)) {
        return html_page("<p>Invalid link.</p>", 400);
      }
      const assets = yield* AssetsTag;
      // Shipped email links enter the canonical SPA approve flow. An
      // explicitly configured approve path wins; otherwise the default
      // fragment is used when the portal shell is deployed. The GET itself
      // never consumes: approval happens only via the POST consume API.
      const spa = cfg.env.CORE_SPA_APPROVE_PATH ?? default_approve_path;
      if (cfg.env.CORE_SPA_APPROVE_PATH || (yield* shell_is_deployed(assets.fetch, url))) {
        return spa_redirect(`${spa}?token=${token}`);
      }
      return html_page(confirmPage());
    }),
  ),
);
