import { Effect } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import { register_route } from "../http/register.ts";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as C from "../contracts/v1.ts";
import { R } from "../contracts/registry.ts";
import * as Activity from "../services/activity.ts";
import * as Deletion from "../services/deletion.ts";
import * as Auth from "../services/auth.ts";
import { decode_request, read_json_body, session_for_mutation, session_of } from "../http/request.ts";
import { encode_ok } from "../http/response.ts";

const activity_handler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const { principal: s } = yield* session_of;
  const url = new URL(req.originalUrl);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "50") || 50, 1), 200);
  const data = yield* Activity.list_for_account(s.account_id, limit);
  return encode_ok(C.ActivityResp, data);
});
const deletion_request_handler = Effect.gen(function* () {
  const s = yield* session_for_mutation;
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.DeletionRequestReq, json);
  if (s.totp_enrolled) {
    yield* Auth.assert_second_factor(s.account_id, { totp_code: input.totpCode });
  }
  const opened = yield* Deletion.request_account_deletion(s.account_id);
  return encode_ok(C.DeletionStatusResp, {
    status: opened.status,
    requested_at: opened.requested_at,
    purge_after: opened.purge_after,
    completed_at: null });
});
const deletion_status_handler = Effect.gen(function* () {
  const { principal: s } = yield* session_of;
  const data = yield* Deletion.deletion_status(s.account_id);
  return encode_ok(C.DeletionStatusResp, data);
});
const deletion_cancel_handler = Effect.gen(function* () {
  const s = yield* session_for_mutation;
  yield* Deletion.cancel_account_deletion(s.account_id);
  const data = yield* Deletion.deletion_status(s.account_id);
  return encode_ok(C.DeletionStatusResp, data);
});

export const router = HttpRouter.empty.pipe(
  register_route(
    R.activity,
      activity_handler,
  ),
  register_route(
    R.deletion_request,
      deletion_request_handler,
  ),
  register_route(
    R.deletion_status,
      deletion_status_handler,
  ),
  register_route(
    R.deletion_cancel,
      deletion_cancel_handler,
  ),
);
