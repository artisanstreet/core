import { Effect } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import { register_route } from "../http/register.ts";
import * as C from "../contracts/v1.ts";
import { R } from "../contracts/registry.ts";
import * as Machines from "../services/machines.ts";
import { client_ip, decode_request, parse_json_text, proof_for_enrollment, read_json_body, require_json_content_type, session_for_mutation, session_of } from "../http/request.ts";
import { encode_ok } from "../http/response.ts";
import { CoreError, unauthorized } from "../errors.ts";

const enroll_start_handler = Effect.gen(function* () {
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.EnrollmentStartReq, json);
  const ip = yield* client_ip;
  const data = yield* Machines.start_enrollment({
    public_key_x: input.publicKey.x,
    label: input.label,
    timestamp: input.timestamp,
    proof: input.proof,
    ip });
  return encode_ok(C.EnrollmentStartResp, data, 201);
});
const enroll_claim_handler = Effect.gen(function* () {
  const s = yield* session_for_mutation;
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.EnrollmentClaimReq, json);
  const ip = yield* client_ip;
  const data = yield* Machines.claim_enrollment_with_code({
    code: input.code,
    account_id: s.account_id,
    email: s.email,
    ip });
  return encode_ok(C.EnrollmentClaimResp, data);
});
const enroll_confirm_handler = Effect.gen(function* () {
  const { subject_id, raw_body } = yield* proof_for_enrollment;
  yield* require_json_content_type;
  const parsed = yield* parse_json_text(raw_body);
  const input = yield* decode_request(C.EnrollmentConfirmReq, parsed);
  if (subject_id !== input.enrollmentId) return yield* Effect.fail(unauthorized("subject mismatch"));
  const data = yield* Machines.confirm_enrollment_with_key({
    enrollment_id: input.enrollmentId,
    account_id: input.accountId,
    confirmation: input.confirmation });
  return encode_ok(C.EnrollmentConfirmResp, data, 201);
});
const machine_list_handler = Effect.gen(function* () {
  const { principal: s } = yield* session_of;
  const data = yield* Machines.list_machines(s.account_id);
  return encode_ok(C.MachineListResp, data);
});
const machine_revoke_handler = Effect.gen(function* () {
  const s = yield* session_for_mutation;
  const params = yield* HttpRouter.RouteContext.pipe(Effect.map((ctx) => ctx.params));
  const id = params["id"] ?? "";
  const data = yield* Machines.revoke_machine_by_id(s.account_id, id);
  return encode_ok(R.machine_revoke.response_schema, data);
});
const enroll_status_handler = Effect.gen(function* () {
  const { public_key_x, subject_id } = yield* proof_for_enrollment;
  const params = yield* HttpRouter.RouteContext.pipe(Effect.map((c) => c.params));
  const id = params["id"] ?? "";
  if (subject_id !== id) return yield* Effect.fail(unauthorized("subject mismatch"));
  if (!id) return yield* Effect.fail(new CoreError("bad_request", "missing id"));
  const data = yield* Machines.enrollment_status(id, public_key_x);
  return encode_ok(C.EnrollmentStatusResp, data);
});

export const router = HttpRouter.empty.pipe(
  register_route(
    R.enroll_start,
      enroll_start_handler,
  ),
  register_route(
    R.enroll_claim,
      enroll_claim_handler,
  ),
  register_route(
    R.enroll_confirm,
      enroll_confirm_handler,
  ),
  register_route(
    R.machine_list,
      machine_list_handler,
  ),
  register_route(
    R.machine_revoke,
      machine_revoke_handler,
  ),
  register_route(
    R.enroll_status,
      enroll_status_handler,
  ),
);
