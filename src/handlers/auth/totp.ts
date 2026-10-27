import { Effect } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import * as C from "../../contracts/v1.ts";
import { R } from "../../contracts/registry.ts";
import * as Auth from "../../services/auth.ts";
import { decode_request, read_json_body, session_for_mutation } from "../../http/request.ts";
import { encode_ok } from "../../http/response.ts";

export const router = HttpRouter.empty.pipe(
  HttpRouter.post(
    R.totpEnroll.path,
      Effect.gen(function* () {
        const s = yield* session_for_mutation();
        const data = yield* Auth.enrollTotp(s.accountId);
        return encode_ok(C.TotpEnrollResp, data);
      }),
  ),
  HttpRouter.post(
    R.totpVerify.path,
      Effect.gen(function* () {
        const s = yield* session_for_mutation();
        const { json } = yield* read_json_body();
        const input = yield* decode_request(C.TotpVerifyReq, json);
        const data = yield* Auth.verifyTotpEnroll(s.accountId, input.code);
        return encode_ok(C.TotpVerifyResp, data);
      }),
  ),
  HttpRouter.post(
    R.totpDisable.path,
      Effect.gen(function* () {
        const s = yield* session_for_mutation();
        const { json } = yield* read_json_body();
        const input = yield* decode_request(C.TotpDisableReq, json);
        const data = yield* Auth.disableTotp(s.accountId, input.code);
        return encode_ok(C.TotpDisableResp, data);
      }),
  ),
);
