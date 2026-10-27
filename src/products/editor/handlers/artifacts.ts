import { Effect, Option } from "effect";
import { Schema } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as Headers from "@effect/platform/Headers";
import * as C from "../../../contracts/v1.ts";
import { R } from "../../../contracts/registry.ts";
import * as Vault from "../../../services/vault.ts";
import { validateEnvelope } from "../artifacts.ts";
import { decode_request, proof_for_machine, read_json_body, session_for_mutation, session_of } from "../../../http/request.ts";
import { encode_ok } from "../../../http/response.ts";
import { internal } from "../../../errors.ts";

function has_machine_header(req: HttpServerRequest.HttpServerRequest): boolean {
  const v = Headers.get(req.headers, "x-ast-machine");
  return Option.isSome(v) && v.value.trim() !== "";
}

export const router = HttpRouter.empty.pipe(
  HttpRouter.post(
    R.artifactCreate.path,
      Effect.gen(function* () {
        const me = yield* session_for_mutation();
        const { json } = yield* read_json_body();
        const input = yield* decode_request(C.ArtifactCreateReq, json);
        const env = yield* validateEnvelope(input.envelope);
        const stored = yield* Vault.storeArtifact({ accountId: me.accountId, label: input.label ?? "", envelope: env });
        return encode_ok(R.artifactCreate.responseSchema, stored, 201);
      }),
  ),
  HttpRouter.get(
    R.artifactList.path,
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        if (has_machine_header(req)) {
          const { principal } = yield* proof_for_machine();
          const data = yield* Vault.listAssignedArtifacts(principal.accountId, principal.machineId);
          return encode_ok(C.ArtifactListResp, data);
        }
        const { principal: me } = yield* session_of();
        const data = yield* Vault.listArtifacts(me.accountId);
        return encode_ok(C.ArtifactListResp, data);
      }),
  ),
  HttpRouter.post(
    R.artifactRevoke.path,
      Effect.gen(function* () {
        const me = yield* session_for_mutation();
        const params = yield* HttpRouter.RouteContext.pipe(Effect.map((c) => c.params));
        const data = yield* Vault.revokeArtifact(me.accountId, params["id"] ?? "");
        return encode_ok(R.artifactRevoke.responseSchema, data);
      }),
  ),
  HttpRouter.post(
    R.artifactAssign.path,
      Effect.gen(function* () {
        const me = yield* session_for_mutation();
        const { json } = yield* read_json_body();
        const input = yield* decode_request(C.ArtifactAssignReq, json);
        const a = yield* Vault.assignArtifact(me.accountId, input.artifactId, input.machineId);
        return encode_ok(R.artifactAssign.responseSchema, { artifactId: a.artifactId, machineId: a.machineId });
      }),
  ),
  HttpRouter.post(
    R.artifactUnassign.path,
      Effect.gen(function* () {
        const me = yield* session_for_mutation();
        const { json } = yield* read_json_body();
        const input = yield* decode_request(C.ArtifactAssignReq, json);
        const data = yield* Vault.unassignArtifact(me.accountId, input.artifactId, input.machineId);
        return encode_ok(R.artifactUnassign.responseSchema, data);
      }),
  ),
  HttpRouter.get(
    R.artifactDownload.path,
      Effect.gen(function* () {
        const { principal } = yield* proof_for_machine();
        const params = yield* HttpRouter.RouteContext.pipe(Effect.map((c) => c.params));
        const data = yield* Vault.downloadArtifact(principal.accountId, principal.machineId, params["id"] ?? "");
        const envelope = yield* Schema.decodeUnknown(C.EngineArtifactEnvelope)(data.envelope).pipe(
          Effect.mapError((cause) => internal("artifact unavailable", { cause })),
        );
        return encode_ok(C.ArtifactDownloadResp, { envelope });
      }),
  ),
);
