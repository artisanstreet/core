import { Effect } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import { register_route } from "../../http/register.ts";
import * as C from "../../contracts/v1.ts";
import { R } from "../../contracts/registry.ts";
import * as Desktop from "../../services/desktop.ts";
import { client_ip, decode_request, read_json_body, session_for_mutation } from "../../http/request.ts";
import { encode_ok } from "../../http/response.ts";
import { requester, session_fields, with_session } from "./oauth.ts";

const desktop_grant_handler = Effect.gen(function* () {
  const principal = yield* session_for_mutation;
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.DesktopGrantReq, json);
  const ip = yield* client_ip;
  const data = yield* Desktop.grant_desktop_code(principal, input.challenge, ip);
  return encode_ok(C.DesktopGrantResp, data);
});

const desktop_redeem_handler = Effect.gen(function* () {
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.DesktopRedeemReq, json);
  const session = yield* Desktop.redeem_desktop_code({
    code: input.code,
    verifier: input.verifier,
    requester: yield* requester });
  return yield* with_session(encode_ok(C.MagicFinalizeResp, session_fields(session)), session);
});

export const router = HttpRouter.empty.pipe(
  register_route(R.desktop_grant, desktop_grant_handler),
  register_route(R.desktop_redeem, desktop_redeem_handler),
);
