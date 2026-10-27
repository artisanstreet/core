import { Effect, Option } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as Headers from "@effect/platform/Headers";
import * as C from "../../../contracts/v1.ts";
import { R } from "../../../contracts/registry.ts";
import * as Vault from "../../../services/vault.ts";
import { validateProviderKey } from "../providers.ts";
import { decode_request, proof_for_machine, read_json_body, session_for_mutation, session_of } from "../../../http/request.ts";
import { encode_ok } from "../../../http/response.ts";
import { CoreError } from "../../../errors.ts";

function has_machine_header(req: HttpServerRequest.HttpServerRequest): boolean {
  const v = Headers.get(req.headers, "x-ast-machine");
  return Option.isSome(v) && v.value.trim() !== "";
}

export const router = HttpRouter.empty.pipe(
  HttpRouter.post(
    R.providerCreate.path,
      Effect.gen(function* () {
        const me = yield* session_for_mutation();
        const { json } = yield* read_json_body();
        const input = yield* decode_request(C.ProviderCreateReq, json);
        const checked = yield* validateProviderKey(input.provider, input.apiKey);
        const created = yield* Vault.createProviderConnection({
          accountId: me.accountId,
          provider: checked.provider,
          label: input.label ?? "",
          apiKey: checked.apiKey });
        return encode_ok(
          C.ProviderInfo,
          { id: created.id, provider: created.provider, label: created.label, createdAt: created.createdAt, revokedAt: null, assignedMachineIds: [] },
          201,
        );
      }),
  ),
  HttpRouter.get(
    R.providerList.path,
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        if (has_machine_header(req)) {
          const { principal } = yield* proof_for_machine();
          const data = yield* Vault.listAssignedProviderConnections(principal.accountId, principal.machineId);
          return encode_ok(C.ProviderListResp, data);
        }
        const { principal: me } = yield* session_of();
        const data = yield* Vault.listProviderConnections(me.accountId);
        return encode_ok(C.ProviderListResp, data);
      }),
  ),
  HttpRouter.post(
    R.providerRevoke.path,
      Effect.gen(function* () {
        const me = yield* session_for_mutation();
        const params = yield* HttpRouter.RouteContext.pipe(Effect.map((c) => c.params));
        const id = params["id"] ?? "";
        const data = yield* Vault.revokeProviderConnectionById(me.accountId, id);
        return encode_ok(R.providerRevoke.responseSchema, data);
      }),
  ),
  HttpRouter.post(
    R.providerAssign.path,
      Effect.gen(function* () {
        const me = yield* session_for_mutation();
        const { json } = yield* read_json_body();
        const input = yield* decode_request(C.AssignReq, json);
        const data = yield* Vault.assignConnection(me.accountId, input.connectionId, input.machineId);
        return encode_ok(C.AssignResp, data);
      }),
  ),
  HttpRouter.post(
    R.providerUnassign.path,
      Effect.gen(function* () {
        const me = yield* session_for_mutation();
        const { json } = yield* read_json_body();
        const input = yield* decode_request(C.AssignReq, json);
        const data = yield* Vault.unassignConnection(me.accountId, input.connectionId, input.machineId);
        return encode_ok(R.providerUnassign.responseSchema, data);
      }),
  ),
  HttpRouter.get(
    R.credentialRelease.path,
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        const { principal } = yield* proof_for_machine();
        const url = new URL(req.originalUrl);
        const connection_id = url.searchParams.get("connectionId") ?? "";
        if (!/^conn_[0-9A-HJKMNP-TV-Z]{26}$/.test(connection_id)) {
          return yield* Effect.fail(new CoreError("bad_request", "connectionId is required"));
        }
        const rel = yield* Vault.releaseCredential(principal.accountId, principal.machineId, connection_id);
        return encode_ok(C.CredentialResp, rel);
      }),
  ),
);
