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
import { CoreError, notFound } from "../errors.ts";
import { constantTimeEqual } from "../crypto.ts";

function get_header(req: HttpServerRequest.HttpServerRequest, name: string): string | undefined {
  const v = Headers.get(req.headers, name);
  return Option.isSome(v) ? v.value : undefined;
}

export const router = HttpRouter.empty.pipe(
  register_route(
    R.grantIssue,
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        if ((get_header(req, "x-ast-machine") ?? "").trim()) {
          const { principal, publicKeyX, rawBody } = yield* proof_for_machine();
          yield* require_json_content_type();
          const parsed = yield* parse_json_text(rawBody);
          const input = yield* decode_request(C.GrantIssueReq, parsed);
          const issued = yield* Grants.issueGrant({
            accountId: principal.accountId,
            audience: input.audience,
            scope: [...input.scope],
            ttlSeconds: input.ttlSeconds,
            role: "forge",
            mid: input.targetMachineId ?? principal.machineId,
            cnf: { kty: "OKP", crv: "Ed25519", x: publicKeyX } });
          return encode_ok(C.GrantIssueResp, { token: issued.token, expiresAt: issued.expiresAt });
        }
        const s = yield* session_for_mutation();
        const { json } = yield* read_json_body();
        const input = yield* decode_request(C.GrantIssueReq, json);
        if (!input.targetMachineId) return yield* Effect.fail(new CoreError("bad_request", "targetMachineId is required"));
        if (!input.cnf) return yield* Effect.fail(new CoreError("bad_request", "cnf is required"));
        const issued = yield* Grants.issueGrant({
          accountId: s.accountId,
          audience: input.audience,
          scope: [...input.scope],
          ttlSeconds: input.ttlSeconds,
          role: "client",
          mid: input.targetMachineId,
          cnf: input.cnf });
        return encode_ok(C.GrantIssueResp, { token: issued.token, expiresAt: issued.expiresAt });
      }),
  ),
  register_route(
    R.keyRotate,
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        const cfg = yield* AppConfigTag;
        if (!cfg.adminToken || !constantTimeEqual(get_header(req, "x-admin-token") ?? "", cfg.adminToken)) {
          return yield* Effect.fail(notFound("not found"));
        }
        const data = yield* Grants.rotateKeys();
        return encode_ok(R.keyRotate.responseSchema, data);
      }),
  ),
  register_route(
    R.janitorRun,
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        const cfg = yield* AppConfigTag;
        if (!cfg.adminToken || !constantTimeEqual(get_header(req, "x-admin-token") ?? "", cfg.adminToken)) {
          return yield* Effect.fail(notFound("not found"));
        }
        const data = yield* janitor(cfg.now());
        return encode_ok(R.janitorRun.responseSchema, data);
      }),
  ),
);
