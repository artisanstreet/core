import { Effect } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import { register_route } from "../../http/register.ts";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as C from "../../contracts/v1.ts";
import { R } from "../../contracts/registry.ts";
import * as Auth from "../../services/auth.ts";
import { client_ip, decode_request, read_json_body } from "../../http/request.ts";
import { encode_ok, with_session_cookie } from "../../http/response.ts";
import { CoreError } from "../../errors.ts";

const finalize_cookie_max_age = 30 * 24 * 60 * 60;

const magic_request_handler = Effect.gen(function* () {
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.MagicRequest, json);
  const ip = yield* client_ip;
  const data = yield* Auth.request_magic_link({
    email: input.email,
    display_name: input.displayName,
    device_name: input.deviceName,
    ip });
  return encode_ok(C.MagicRequestResp, data);
});
const magic_status_handler = Effect.gen(function* () {
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.MagicStatusReq, json);
  const data = yield* Auth.login_request_status({
    request_id: input.requestId,
    request_secret: input.requestSecret });
  return encode_ok(C.MagicStatusResp, data);
});
const magic_consume_handler = Effect.gen(function* () {
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.MagicConsumeReq, json);
  const ip = yield* client_ip;
  const data = yield* Auth.consume_magic_link({
    token: input.token,
    request_secret: input.requestSecret,
    ip });
  return encode_ok(C.MagicConsumeResp, data);
});
const token_pattern = /^[A-Za-z0-9_-]{10,128}$/;
const magic_confirm_handler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(req.originalUrl);
  const token = url.searchParams.get("token") ?? "";
  if (!token_pattern.test(token)) {
    return yield* Effect.fail(new CoreError("bad_request", "invalid link"));
  }
  return encode_ok(C.MagicConfirmResp, { status: "confirmation_required" });
});
const magic_finalize_handler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.MagicFinalizeReq, json);
  const ip = yield* client_ip;
  const ua = (req.headers["user-agent"] as unknown as string | undefined) ?? null;
  const r = yield* Auth.finalize_magic_link({
    request_id: input.requestId,
    request_secret: input.requestSecret,
    totp_code: input.totpCode,
    recovery_code: input.recoveryCode,
    device_name: undefined,
    ip,
    user_agent: typeof ua === "string" ? ua : null });
  const { raw_token, ...rest } = r;
  return yield* with_session_cookie(encode_ok(C.MagicFinalizeResp, rest), raw_token, finalize_cookie_max_age);
});

export const router = HttpRouter.empty.pipe(
  register_route(
    R.magic_request,
      magic_request_handler,
  ),
  register_route(
    R.magic_confirm,
      magic_confirm_handler,
  ),
  register_route(
    R.magic_status,
      magic_status_handler,
  ),
  register_route(
    R.magic_consume,
      magic_consume_handler,
  ),
  register_route(
    R.magic_finalize,
      magic_finalize_handler,
  ),
);
