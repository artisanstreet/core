import { Effect } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import { register_route } from "../../http/register.ts";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as C from "../../contracts/v1.ts";
import { R } from "../../contracts/registry.ts";
import * as Auth from "../../services/auth.ts";
import { client_ip, decode_request, read_json_body } from "../../http/request.ts";
import { encode_ok, session_cookie_value } from "../../http/response.ts";
import { AppConfigTag } from "../../services/deps.ts";

const finalize_cookie_max_age = 30 * 24 * 60 * 60;

const magic_request_handler = Effect.gen(function* () {
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.MagicRequest, json);
  const ip = yield* client_ip;
  const data = yield* Auth.requestMagicLink({ ...input, ip });
  return encode_ok(C.MagicRequestResp, data);
});
const magic_status_handler = Effect.gen(function* () {
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.MagicStatusReq, json);
  const data = yield* Auth.loginRequestStatus(input);
  return encode_ok(C.MagicStatusResp, data);
});
const magic_consume_handler = Effect.gen(function* () {
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.MagicConsumeReq, json);
  const ip = yield* client_ip;
  const data = yield* Auth.consumeMagicLink({ ...input, ip });
  return encode_ok(C.MagicConsumeResp, data);
});
const magic_finalize_handler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const cfg = yield* AppConfigTag;
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.MagicFinalizeReq, json);
  const ip = yield* client_ip;
  const ua = (req.headers["user-agent"] as unknown as string | undefined) ?? null;
  const r = yield* Auth.finalizeMagicLink({ ...input, ip, userAgent: typeof ua === "string" ? ua : null });
  const secure = cfg.publicBaseUrl.startsWith("https://");
  const { rawToken: raw_token, ...rest } = r;
  const ok = encode_ok(C.MagicFinalizeResp, rest);
  return ok.pipe(
    HttpServerResponse.setHeader("Set-Cookie", session_cookie_value(raw_token, finalize_cookie_max_age, secure)),
  );
});

export const router = HttpRouter.empty.pipe(
  register_route(
    R.magicRequest,
      magic_request_handler,
  ),
  register_route(
    R.magicStatus,
      magic_status_handler,
  ),
  register_route(
    R.magicConsume,
      magic_consume_handler,
  ),
  register_route(
    R.magicFinalize,
      magic_finalize_handler,
  ),
);
