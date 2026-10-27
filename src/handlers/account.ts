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
  const data = yield* Activity.listForAccount(s.accountId, limit);
  return encode_ok(C.ActivityResp, data);
});
const deletion_request_handler = Effect.gen(function* () {
  const s = yield* session_for_mutation;
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.DeletionRequestReq, json);
  if (s.totpEnrolled) {
    yield* Auth.assertSecondFactor(s.accountId, { totpCode: input.totpCode });
  }
  const opened = yield* Deletion.requestAccountDeletion(s.accountId);
  return encode_ok(C.DeletionStatusResp, {
    status: opened.status,
    requestedAt: opened.requestedAt,
    purgeAfter: opened.purgeAfter,
    completedAt: null });
});
const deletion_status_handler = Effect.gen(function* () {
  const { principal: s } = yield* session_of;
  const data = yield* Deletion.deletionStatus(s.accountId);
  return encode_ok(C.DeletionStatusResp, data);
});
const deletion_cancel_handler = Effect.gen(function* () {
  const s = yield* session_for_mutation;
  yield* Deletion.cancelAccountDeletion(s.accountId);
  const data = yield* Deletion.deletionStatus(s.accountId);
  return encode_ok(C.DeletionStatusResp, data);
});

export const router = HttpRouter.empty.pipe(
  register_route(
    R.activity,
      activity_handler,
  ),
  register_route(
    R.deletionRequest,
      deletion_request_handler,
  ),
  register_route(
    R.deletionStatus,
      deletion_status_handler,
  ),
  register_route(
    R.deletionCancel,
      deletion_cancel_handler,
  ),
);
