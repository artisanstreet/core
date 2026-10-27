import { Effect } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { AppConfigTag } from "../services/deps.ts";
import { signinPage, confirmPage, claimPage } from "../ui.ts";

export const router = HttpRouter.empty.pipe(
  HttpRouter.get(
    "/ui/signin",
      Effect.gen(function* () {
        return HttpServerResponse.text(signinPage(), { status: 200 }).pipe(
          HttpServerResponse.setHeader("Content-Type", "text/html; charset=utf-8"),
          HttpServerResponse.setHeader(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
          ),
        );
      }),
  ),
  HttpRouter.get(
    "/ui/claim",
      Effect.gen(function* () {
        return HttpServerResponse.text(claimPage(), { status: 200 }).pipe(
          HttpServerResponse.setHeader("Content-Type", "text/html; charset=utf-8"),
          HttpServerResponse.setHeader(
            "Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
          ),
        );
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
          return HttpServerResponse.text("<p>Invalid link.</p>", { status: 400 }).pipe(
            HttpServerResponse.setHeader("Content-Type", "text/html; charset=utf-8"),
            HttpServerResponse.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"),
          );
        }
        const spa = cfg.env.CORE_SPA_APPROVE_PATH;
        if (spa) {
          return HttpServerResponse.empty({ status: 302 }).pipe(
            HttpServerResponse.setHeader("Location", `${spa}?token=${token}`),
            HttpServerResponse.setHeader("Cache-Control", "no-store"),
            HttpServerResponse.setHeader("Referrer-Policy", "no-referrer"),
          );
        }
        return HttpServerResponse.text(confirmPage(token), { status: 200 }).pipe(
          HttpServerResponse.setHeader("Content-Type", "text/html; charset=utf-8"),
          HttpServerResponse.setHeader(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
          ),
        );
      }),
  ),
);
