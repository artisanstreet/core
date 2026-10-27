import { Effect } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import { register_route } from "../http/register.ts";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as C from "../contracts/v1.ts";
import { R } from "../contracts/registry.ts";
import * as Grants from "../services/grants.ts";
import { encode_ok } from "../http/response.ts";
import openapi_doc from "../../contracts/v1.openapi.json";

const version_handler = Effect.gen(function* () {
  const res = encode_ok(C.VersionResp, {
    api: "1",
    contracts: "1.0.0",
    jwks_uri: "/.well-known/jwks.json",
    openapi: "/v1/openapi.json" });
  return res.pipe(HttpServerResponse.setHeader("Cache-Control", "public, max-age=60"));
});
const openapi_handler = Effect.gen(function* () {
  return HttpServerResponse.unsafeJson(openapi_doc, { status: 200 }).pipe(
    HttpServerResponse.setHeader("Cache-Control", "public, max-age=300"),
  );
});
const jwks_handler = Effect.gen(function* () {
  const data = yield* Grants.jwks;
  const ok = encode_ok(C.JwksResp, data);
  return ok.pipe(HttpServerResponse.setHeader("Cache-Control", "public, max-age=600"));
});
const revocations_handler = Effect.gen(function* () {
  const data = yield* Grants.revocations;
  const ok = encode_ok(C.RevocationsResp, data);
  return ok.pipe(HttpServerResponse.setHeader("Cache-Control", "public, max-age=60"));
});

export const router = HttpRouter.empty.pipe(
  register_route(
    R.version,
      version_handler,
  ),
  register_route(
    R.openapi,
      openapi_handler,
  ),
  register_route(
    R.jwks,
      jwks_handler,
  ),
  register_route(
    R.revocations,
      revocations_handler,
  ),
);
