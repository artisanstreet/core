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
  const data = yield* Machines.startEnrollment({
    publicKeyX: input.publicKey.x,
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
  const data = yield* Machines.claimEnrollmentWithCode({
    code: input.code,
    accountId: s.accountId,
    email: s.email,
    ip });
  return encode_ok(C.EnrollmentClaimResp, data);
});
const enroll_confirm_handler = Effect.gen(function* () {
  const { subjectId, rawBody } = yield* proof_for_enrollment;
  yield* require_json_content_type;
  const parsed = yield* parse_json_text(rawBody);
  const input = yield* decode_request(C.EnrollmentConfirmReq, parsed);
  if (subjectId !== input.enrollmentId) return yield* Effect.fail(unauthorized("subject mismatch"));
  const data = yield* Machines.confirmEnrollmentWithKey(input);
  return encode_ok(C.EnrollmentConfirmResp, data, 201);
});
const machine_list_handler = Effect.gen(function* () {
  const { principal: s } = yield* session_of;
  const data = yield* Machines.listMachines(s.accountId);
  return encode_ok(C.MachineListResp, data);
});
const machine_revoke_handler = Effect.gen(function* () {
  const s = yield* session_for_mutation;
  const params = yield* HttpRouter.RouteContext.pipe(Effect.map((ctx) => ctx.params));
  const id = params["id"] ?? "";
  const data = yield* Machines.revokeMachineById(s.accountId, id);
  return encode_ok(R.machineRevoke.responseSchema, data);
});
const enroll_status_handler = Effect.gen(function* () {
  const { publicKeyX, subjectId } = yield* proof_for_enrollment;
  const params = yield* HttpRouter.RouteContext.pipe(Effect.map((c) => c.params));
  const id = params["id"] ?? "";
  if (subjectId !== id) return yield* Effect.fail(unauthorized("subject mismatch"));
  if (!id) return yield* Effect.fail(new CoreError("bad_request", "missing id"));
  const data = yield* Machines.enrollmentStatus(id, publicKeyX);
  return encode_ok(C.EnrollmentStatusResp, data);
});

export const router = HttpRouter.empty.pipe(
  register_route(
    R.enrollStart,
      enroll_start_handler,
  ),
  register_route(
    R.enrollClaim,
      enroll_claim_handler,
  ),
  register_route(
    R.enrollConfirm,
      enroll_confirm_handler,
  ),
  register_route(
    R.machineList,
      machine_list_handler,
  ),
  register_route(
    R.machineRevoke,
      machine_revoke_handler,
  ),
  register_route(
    R.enrollStatus,
      enroll_status_handler,
  ),
);
