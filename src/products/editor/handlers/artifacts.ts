import { Effect, Option } from "effect";
import { Schema } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import { register_route } from "../../../http/register.ts";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as Headers from "@effect/platform/Headers";
import * as C from "../../../contracts/v1.ts";
import { R } from "../../../contracts/registry.ts";
import * as Vault from "../../../services/vault.ts";
import { validate_envelope } from "../artifacts.ts";
import { decode_request, proof_for_machine, read_json_body, session_for_mutation, session_of } from "../../../http/request.ts";
import { encode_ok } from "../../../http/response.ts";
import { internal } from "../../../errors.ts";

function has_machine_header(req: HttpServerRequest.HttpServerRequest): boolean {
  const v = Headers.get(req.headers, "x-ast-machine");
  return Option.isSome(v) && v.value.trim() !== "";
}

const artifact_create_handler = Effect.gen(function* () {
  const me = yield* session_for_mutation;
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.ArtifactCreateReq, json);
  const env = yield* validate_envelope(input.envelope);
  const stored = yield* Vault.store_artifact({ account_id: me.account_id, label: input.label ?? "", envelope: env });
  return encode_ok(R.artifact_create.response_schema, stored, 201);
});
const artifact_list_handler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  if (has_machine_header(req)) {
    const { principal } = yield* proof_for_machine;
    const data = yield* Vault.list_assigned_artifacts(principal.account_id, principal.machine_id);
    return encode_ok(C.ArtifactListResp, data);
  }
  const { principal: me } = yield* session_of;
  const data = yield* Vault.list_artifacts(me.account_id);
  return encode_ok(C.ArtifactListResp, data);
});
const artifact_revoke_handler = Effect.gen(function* () {
  const me = yield* session_for_mutation;
  const params = yield* HttpRouter.RouteContext.pipe(Effect.map((c) => c.params));
  const data = yield* Vault.revoke_artifact(me.account_id, params["id"] ?? "");
  return encode_ok(R.artifact_revoke.response_schema, data);
});
const artifact_assign_handler = Effect.gen(function* () {
  const me = yield* session_for_mutation;
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.ArtifactAssignReq, json);
  const a = yield* Vault.assign_artifact(me.account_id, input.artifactId, input.machineId);
  return encode_ok(R.artifact_assign.response_schema, { artifactId: a.artifactId, machineId: a.machineId });
});
const artifact_unassign_handler = Effect.gen(function* () {
  const me = yield* session_for_mutation;
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.ArtifactAssignReq, json);
  const data = yield* Vault.unassign_artifact(me.account_id, input.artifactId, input.machineId);
  return encode_ok(R.artifact_unassign.response_schema, data);
});
const artifact_download_handler = Effect.gen(function* () {
  const { principal } = yield* proof_for_machine;
  const params = yield* HttpRouter.RouteContext.pipe(Effect.map((c) => c.params));
  const data = yield* Vault.download_artifact(principal.account_id, principal.machine_id, params["id"] ?? "");
  const envelope = yield* Schema.decodeUnknown(C.EngineArtifactEnvelope)(data.envelope).pipe(
    Effect.mapError((cause) => internal("artifact unavailable", { cause })),
  );
  return encode_ok(C.ArtifactDownloadResp, { envelope });
});

export const router = HttpRouter.empty.pipe(
  register_route(
    R.artifact_create,
      artifact_create_handler,
  ),
  register_route(
    R.artifact_list,
      artifact_list_handler,
  ),
  register_route(
    R.artifact_revoke,
      artifact_revoke_handler,
  ),
  register_route(
    R.artifact_assign,
      artifact_assign_handler,
  ),
  register_route(
    R.artifact_unassign,
      artifact_unassign_handler,
  ),
  register_route(
    R.artifact_download,
      artifact_download_handler,
  ),
);
