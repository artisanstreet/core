import { Effect } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import { register_route } from "../http/register.ts";
import * as C from "../contracts/v1.ts";
import { R } from "../contracts/registry.ts";
import * as Auth from "../services/auth.ts";
import * as SignIn from "../services/sign-in.ts";
import { client_ip, decode_request, read_json_body, session_for_mutation, session_of } from "../http/request.ts";
import { encode_ok } from "../http/response.ts";

const methods_handler = Effect.gen(function* () {
  const { principal } = yield* session_of;
  const data = yield* SignIn.list_methods(principal.account_id);
  return encode_ok(C.SignInMethodsResp, data);
});

const link_handler = Effect.gen(function* () {
  const principal = yield* session_for_mutation;
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.OauthStartReq, json);
  const ip = yield* client_ip;
  const data = yield* SignIn.start_oauth(input.provider, SignIn.OauthIntent.Link({ account_id: principal.account_id }), ip);
  return encode_ok(C.OauthStartResp, data);
});

const email_handler = Effect.gen(function* () {
  const principal = yield* session_for_mutation;
  const data = yield* SignIn.enable_email(principal.account_id);
  return encode_ok(C.SignInMethodsResp, data);
});

const remove_handler = Effect.gen(function* () {
  const principal = yield* session_for_mutation;
  const params = yield* HttpRouter.RouteContext.pipe(Effect.map((c) => c.params));
  const kind = yield* SignIn.parse_sign_in_kind(params["kind"] ?? "");
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.SignInMethodRemoveReq, json);
  if (principal.totp_enrolled) {
    yield* Auth.assert_second_factor(principal.account_id, { totp_code: input.totpCode });
  }
  const data = yield* SignIn.remove_method(principal.account_id, kind);
  return encode_ok(C.SignInMethodsResp, data);
});

export const router = HttpRouter.empty.pipe(
  register_route(R.sign_in_methods, methods_handler),
  register_route(R.sign_in_link, link_handler),
  register_route(R.sign_in_email, email_handler),
  register_route(R.sign_in_remove, remove_handler),
);
