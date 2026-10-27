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
import { encode_ok, session_cookie_value } from "../../http/response.ts";
import { AppConfigTag } from "../../services/deps.ts";

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
    accountId: s.account_id,
    email: s.email,
    displayName: s.display_name,
    totpEnrolled: s.totp_enrolled,
    machines: machines.machines,
    providerConnections: providers.connections.map((p) => ({
      id: p.id,
      provider: p.provider,
      label: p.label,
      revokedAt: p.revokedAt,
      assignedMachineIds: p.assignedMachineIds })),
    latestConfigVersion: latest_config_version ?? null });
});
const sessions_handler = Effect.gen(function* () {
  const { principal: s } = yield* session_of;
  const data = yield* Auth.list_sessions(s.account_id, 50);
  return encode_ok(C.SessionListResp, data);
});
const logout_handler = Effect.gen(function* () {
  const cfg = yield* AppConfigTag;
  const sess = yield* session_of;
  if (sess.via === "cookie") {
    yield* session_for_mutation;
  }
  const token = yield* current_token;
  yield* Auth.revoke_current_session(token);
  const secure = cfg.public_base_url.startsWith("https://");
  const ok = encode_ok(R.logout.response_schema, { revoked: true });
  return ok.pipe(HttpServerResponse.setHeader("Set-Cookie", session_cookie_value(null, 0, secure)));
});
const sessions_revoke_all_handler = Effect.gen(function* () {
  const cfg = yield* AppConfigTag;
  const s = yield* session_for_mutation;
  yield* Auth.revoke_all_sessions(s.account_id);
  const secure = cfg.public_base_url.startsWith("https://");
  const ok = encode_ok(R.sessions_revoke_all.response_schema, { revoked: true });
  return ok.pipe(HttpServerResponse.setHeader("Set-Cookie", session_cookie_value(null, 0, secure)));
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
