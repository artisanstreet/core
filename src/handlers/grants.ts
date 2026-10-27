import { Effect, Option } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import { register_route } from "../http/register.ts";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as Headers from "@effect/platform/Headers";
import * as C from "../contracts/v1.ts";
import { R } from "../contracts/registry.ts";
import * as Grants from "../services/grants.ts";
import { janitor } from "../services/janitor.ts";
import { AppConfigTag } from "../services/deps.ts";
import { decode_request, parse_json_text, proof_for_machine, read_json_body, require_json_content_type, session_for_mutation } from "../http/request.ts";
import { encode_ok } from "../http/response.ts";
import { CoreError, not_found } from "../errors.ts";
import { constant_time_equal } from "../crypto.ts";

function get_header(req: HttpServerRequest.HttpServerRequest, name: string): string | undefined {
  const v = Headers.get(req.headers, name);
  return Option.isSome(v) ? v.value : undefined;
}

const grant_issue_handler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  if ((get_header(req, "x-ast-machine") ?? "").trim()) {
    const { principal, public_key_x, raw_body } = yield* proof_for_machine;
    yield* require_json_content_type;
    const parsed = yield* parse_json_text(raw_body);
    const input = yield* decode_request(C.GrantIssueReq, parsed);
    const issued = yield* Grants.issue_grant({
      account_id: principal.account_id,
      audience: input.audience,
      scope: [...input.scope],
      ttl_seconds: input.ttlSeconds,
      role: "forge",
      mid: input.targetMachineId ?? principal.machine_id,
      cnf: { kty: "OKP", crv: "Ed25519", x: public_key_x } });
    return encode_ok(C.GrantIssueResp, { token: issued.token, expiresAt: issued.expiresAt });
  }
  const s = yield* session_for_mutation;
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.GrantIssueReq, json);
  if (!input.targetMachineId) return yield* Effect.fail(new CoreError("bad_request", "targetMachineId is required"));
  if (!input.cnf) return yield* Effect.fail(new CoreError("bad_request", "cnf is required"));
  const issued = yield* Grants.issue_grant({
    account_id: s.account_id,
    audience: input.audience,
    scope: [...input.scope],
    ttl_seconds: input.ttlSeconds,
    role: "client",
    mid: input.targetMachineId,
    cnf: input.cnf });
  return encode_ok(C.GrantIssueResp, { token: issued.token, expiresAt: issued.expiresAt });
});
const key_rotate_handler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const cfg = yield* AppConfigTag;
  if (!cfg.admin_token || !constant_time_equal(get_header(req, "x-admin-token") ?? "", cfg.admin_token)) {
    return yield* Effect.fail(not_found("not found"));
  }
  const data = yield* Grants.rotate_keys;
  return encode_ok(R.key_rotate.response_schema, data);
});
const janitor_run_handler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const cfg = yield* AppConfigTag;
  if (!cfg.admin_token || !constant_time_equal(get_header(req, "x-admin-token") ?? "", cfg.admin_token)) {
    return yield* Effect.fail(not_found("not found"));
  }
  const data = yield* janitor(cfg.now());
  return encode_ok(R.janitor_run.response_schema, data);
});

export const router = HttpRouter.empty.pipe(
  register_route(
    R.grant_issue,
      grant_issue_handler,
  ),
  register_route(
    R.key_rotate,
      key_rotate_handler,
  ),
  register_route(
    R.janitor_run,
      janitor_run_handler,
  ),
);
