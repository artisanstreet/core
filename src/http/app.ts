import { Effect } from "effect";
import type * as Scope from "effect/Scope";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import { compiled_app } from "./router.ts";
import type { ServiceEnv } from "./context.ts";
import { encode_fail, RequestIdTag, with_security_headers } from "./response.ts";
import { CoreError } from "../errors.ts";
import type { Layer } from "effect";

export const http_effect = (
  request: Request,
  layers: Layer.Layer<ServiceEnv, never, never>,
): Effect.Effect<Response, never, Scope.Scope> => {
  const request_id = crypto.randomUUID();
  const req = HttpServerRequest.fromWeb(request);
  return compiled_app.pipe(
    Effect.provide(layers),
    Effect.provideService(HttpServerRequest.HttpServerRequest, req),
    Effect.provideService(RequestIdTag, request_id),
    Effect.catchTag("RouteNotFound", () =>
      Effect.succeed(
        HttpServerResponse.unsafeJson(
          { error: { code: "not_found", message: "not found", requestId: request_id } },
          { status: 404 },
        ),
      ),
    ),
    Effect.catchAll((e) => Effect.succeed(encode_fail(e, request_id))),
    Effect.catchAllDefect(() =>
      Effect.succeed(encode_fail(new CoreError("internal", "internal error"), request_id)),
    ),
    Effect.map((res) => with_security_headers(res, request_id)),
    Effect.map((res) => HttpServerResponse.toWeb(res)),
  );
};
