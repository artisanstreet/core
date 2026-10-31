import { Effect } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import { register_route } from "../../http/register.ts";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as C from "../../contracts/v1.ts";
import { R } from "../../contracts/registry.ts";
import * as Auth from "../../services/auth.ts";
import * as Machines from "../../services/machines.ts";
import * as Vault from "../../services/vault.ts";
import { editor_config_version } from "../../products/editor/me.ts";
import { current_token, session_for_mutation, session_of } from "../../http/request.ts";
import { encode_ok, with_session_cookie } from "../../http/response.ts";

const me_handler = Effect.gen(function* () {
  const { principal: s } = yield* session_of;
  const [machines, providers, latest_config_version] = yield* Effect.all(
    [
      Machines.list_machines(s.account_id),
      Vault.list_provider_connections(s.account_id),
      editor_config_version(s.account_id),
    ],
    { concurrency: 3 },
  );
  return encode_ok(C.MeResp, {
    account_id: s.account_id,
    email: s.email,
    display_name: s.display_name,
    avatar_url: s.avatar_url,
    totp_enrolled: s.totp_enrolled,
    machines: machines.machines.map((m) => ({
      id: m.id,
      public_key: m.public_key,
      label: m.label,
      created_at: m.created_at,
      revoked_at: m.revoked_at })),
    provider_connections: providers.connections.map((p) => ({
      id: p.id,
      provider: p.provider,
      label: p.label,
      revoked_at: p.revoked_at,
      assigned_machine_ids: p.assigned_machine_ids })),
    latest_config_version: latest_config_version ?? null });
});
const sessions_handler = Effect.gen(function* () {
  const { principal: s } = yield* session_of;
  const data = yield* Auth.list_sessions(s.account_id, 50);
  return encode_ok(C.SessionListResp, data);
});
const logout_handler = Effect.gen(function* () {
  const sess = yield* session_of;
  if (sess.via === "cookie") {
    yield* session_for_mutation;
  }
  const token = yield* current_token;
  yield* Auth.revoke_current_session(token);
  return yield* with_session_cookie(encode_ok(R.logout.response_schema, { revoked: true }), null, 0);
});
const sessions_revoke_all_handler = Effect.gen(function* () {
  const s = yield* session_for_mutation;
  yield* Auth.revoke_all_sessions(s.account_id);
  return yield* with_session_cookie(encode_ok(R.sessions_revoke_all.response_schema, { revoked: true }), null, 0);
});

export const router = HttpRouter.empty.pipe(
  register_route(
    R.me,
      me_handler,
  ),
  register_route(
    R.sessions,
      sessions_handler,
  ),
  register_route(
    R.logout,
      logout_handler,
  ),
  register_route(
    R.sessions_revoke_all,
      sessions_revoke_all_handler,
  ),
);
