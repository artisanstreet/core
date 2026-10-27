import { Effect } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import { register_route } from "../../http/register.ts";
import * as C from "../../contracts/v1.ts";
import { R } from "../../contracts/registry.ts";
import * as Auth from "../../services/auth.ts";
import { decode_request, read_json_body, session_for_mutation } from "../../http/request.ts";
import { encode_ok } from "../../http/response.ts";

export const router = HttpRouter.empty.pipe(
  register_route(
    R.totpEnroll,
      Effect.gen(function* () {
        const s = yield* session_for_mutation;
        const data = yield* Auth.enrollTotp(s.accountId);
        return encode_ok(C.TotpEnrollResp, data);
      }),
  ),
  register_route(
    R.totpVerify,
      Effect.gen(function* () {
        const s = yield* session_for_mutation;
        const { json } = yield* read_json_body;
        const input = yield* decode_request(C.TotpVerifyReq, json);
        const data = yield* Auth.verifyTotpEnroll(s.accountId, input.code);
        return encode_ok(C.TotpVerifyResp, data);
      }),
  ),
  register_route(
    R.totpDisable,
      Effect.gen(function* () {
        const s = yield* session_for_mutation;
        const { json } = yield* read_json_body;
        const input = yield* decode_request(C.TotpDisableReq, json);
        const data = yield* Auth.disableTotp(s.accountId, input.code);
        return encode_ok(C.TotpDisableResp, data);
      }),
  ),
);
