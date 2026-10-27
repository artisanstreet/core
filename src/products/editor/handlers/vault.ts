import { Effect, Option } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import { register_route } from "../../../http/register.ts";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as Headers from "@effect/platform/Headers";
import * as C from "../../../contracts/v1.ts";
import { R } from "../../../contracts/registry.ts";
import * as Vault from "../../../services/vault.ts";
import { validate_provider_key } from "../providers.ts";
import { decode_request, proof_for_machine, read_json_body, session_for_mutation, session_of } from "../../../http/request.ts";
import { encode_ok } from "../../../http/response.ts";
import { CoreError } from "../../../errors.ts";

function has_machine_header(req: HttpServerRequest.HttpServerRequest): boolean {
  const v = Headers.get(req.headers, "x-ast-machine");
  return Option.isSome(v) && v.value.trim() !== "";
}

const provider_create_handler = Effect.gen(function* () {
  const me = yield* session_for_mutation;
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.ProviderCreateReq, json);
  const checked = yield* validate_provider_key(input.provider, input.apiKey);
  const created = yield* Vault.create_provider_connection({
    account_id: me.account_id,
    provider: checked.provider,
    label: input.label ?? "",
    api_key: checked.api_key });
  return encode_ok(
    C.ProviderInfo,
    { id: created.id, provider: created.provider, label: created.label, created_at: created.created_at, revoked_at: null, assigned_machine_ids: [] },
    201,
  );
});
const provider_list_handler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  if (has_machine_header(req)) {
    const { principal } = yield* proof_for_machine;
    const data = yield* Vault.list_assigned_provider_connections(principal.account_id, principal.machine_id);
    return encode_ok(C.ProviderListResp, data);
  }
  const { principal: me } = yield* session_of;
  const data = yield* Vault.list_provider_connections(me.account_id);
  return encode_ok(C.ProviderListResp, data);
});
const provider_revoke_handler = Effect.gen(function* () {
  const me = yield* session_for_mutation;
  const params = yield* HttpRouter.RouteContext.pipe(Effect.map((c) => c.params));
  const id = params["id"] ?? "";
  const data = yield* Vault.revoke_provider_connection_by_id(me.account_id, id);
  return encode_ok(R.provider_revoke.response_schema, data);
});
const provider_assign_handler = Effect.gen(function* () {
  const me = yield* session_for_mutation;
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.AssignReq, json);
  const data = yield* Vault.assign_connection(me.account_id, input.connectionId, input.machineId);
  return encode_ok(C.AssignResp, data);
});
const provider_unassign_handler = Effect.gen(function* () {
  const me = yield* session_for_mutation;
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.AssignReq, json);
  const data = yield* Vault.unassign_connection(me.account_id, input.connectionId, input.machineId);
  return encode_ok(R.provider_unassign.response_schema, data);
});
const credential_release_handler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const { principal } = yield* proof_for_machine;
  const url = new URL(req.originalUrl);
  const connection_id = url.searchParams.get("connectionId") ?? "";
  if (!/^conn_[0-9A-HJKMNP-TV-Z]{26}$/.test(connection_id)) {
    return yield* Effect.fail(new CoreError("bad_request", "connectionId is required"));
  }
  const rel = yield* Vault.release_credential(principal.account_id, principal.machine_id, connection_id);
  return encode_ok(C.CredentialResp, rel);
});

export const router = HttpRouter.empty.pipe(
  register_route(
    R.provider_create,
      provider_create_handler,
  ),
  register_route(
    R.provider_list,
      provider_list_handler,
  ),
  register_route(
    R.provider_revoke,
      provider_revoke_handler,
  ),
  register_route(
    R.provider_assign,
      provider_assign_handler,
  ),
  register_route(
    R.provider_unassign,
      provider_unassign_handler,
  ),
  register_route(
    R.credential_release,
      credential_release_handler,
  ),
);
