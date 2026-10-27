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

export const router = HttpRouter.empty.pipe(
  register_route(
    R.me,
      Effect.gen(function* () {
        const { principal: s } = yield* session_of;
        const [machines, providers, latest_config_version] = yield* Effect.all(
          [
            Machines.listMachines(s.accountId),
            Vault.listProviderConnections(s.accountId),
            editor_config_version(s.accountId),
          ],
          { concurrency: 3 },
        );
        return encode_ok(C.MeResp, {
          accountId: s.accountId,
          email: s.email,
          displayName: s.displayName,
          totpEnrolled: s.totpEnrolled,
          machines: machines.machines,
          providerConnections: providers.connections.map((p) => ({
            id: p.id,
            provider: p.provider,
            label: p.label,
            revokedAt: p.revokedAt,
            assignedMachineIds: p.assignedMachineIds })),
          latestConfigVersion: latest_config_version ?? null });
      }),
  ),
  register_route(
    R.sessions,
      Effect.gen(function* () {
        const { principal: s } = yield* session_of;
        const data = yield* Auth.listSessions(s.accountId, 50);
        return encode_ok(C.SessionListResp, data);
      }),
  ),
  register_route(
    R.logout,
      Effect.gen(function* () {
        const cfg = yield* AppConfigTag;
        const sess = yield* session_of;
        if (sess.via === "cookie") {
          yield* session_for_mutation;
        }
        const token = yield* current_token;
        yield* Auth.revokeCurrentSession(token);
        const secure = cfg.publicBaseUrl.startsWith("https://");
        const ok = encode_ok(R.logout.responseSchema, { revoked: true });
        return ok.pipe(HttpServerResponse.setHeader("Set-Cookie", session_cookie_value(null, 0, secure)));
      }),
  ),
  register_route(
    R.sessionsRevokeAll,
      Effect.gen(function* () {
        const cfg = yield* AppConfigTag;
        const s = yield* session_for_mutation;
        yield* Auth.revokeAllSessions(s.accountId);
        const secure = cfg.publicBaseUrl.startsWith("https://");
        const ok = encode_ok(R.sessionsRevokeAll.responseSchema, { revoked: true });
        return ok.pipe(HttpServerResponse.setHeader("Set-Cookie", session_cookie_value(null, 0, secure)));
      }),
  ),
);
