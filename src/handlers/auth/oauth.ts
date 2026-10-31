import { Effect } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import { register_route } from "../../http/register.ts";
import * as C from "../../contracts/v1.ts";
import { R } from "../../contracts/registry.ts";
import * as SignIn from "../../services/sign-in.ts";
import { client_ip, decode_request, read_json_body } from "../../http/request.ts";
import { encode_ok, session_cookie_value } from "../../http/response.ts";
import { AppConfigTag } from "../../services/deps.ts";

const session_cookie_max_age = 30 * 24 * 60 * 60;

const requester = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const ip = yield* client_ip;
  const ua = req.headers["user-agent"] as unknown;
  return { ip, user_agent: typeof ua === "string" ? ua : null } satisfies SignIn.Requester;
});

const with_session_cookie = (response: HttpServerResponse.HttpServerResponse, session: SignIn.OpenedSession) =>
  Effect.gen(function* () {
    const cfg = yield* AppConfigTag;
    const secure = cfg.public_base_url.startsWith("https://");
    return response.pipe(
      HttpServerResponse.setHeader("Set-Cookie", session_cookie_value(session.raw_token, session_cookie_max_age, secure)),
    );
  });

const session_fields = (session: SignIn.OpenedSession) => ({
  session_id: session.session_id,
  account_id: session.account_id,
  expires_at: session.expires_at,
  totp_verified: session.totp_verified });

const oauth_start_handler = Effect.gen(function* () {
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.OauthStartReq, json);
  const ip = yield* client_ip;
  const data = yield* SignIn.start_oauth(input.provider, SignIn.OauthIntent.SignIn(), ip);
  return encode_ok(C.OauthStartResp, data);
});

const oauth_callback_handler = Effect.gen(function* () {
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.OauthCallbackReq, json);
  const outcome = yield* SignIn.oauth_callback({
    flow_id: input.flowId,
    flow_secret: input.flowSecret,
    state: input.state,
    code: input.code,
    requester: yield* requester });
  return yield* SignIn.CallbackOutcome.$match(outcome, {
    SignedIn: ({ session }) =>
      with_session_cookie(encode_ok(C.OauthCallbackResp, { outcome: "signed_in", ...session_fields(session) }), session),
    SecondFactorRequired: () => Effect.succeed(encode_ok(C.OauthCallbackResp, { outcome: "second_factor_required" })),
    SignupRequired: ({ email, display_name, avatar_url }) =>
      Effect.succeed(encode_ok(C.OauthCallbackResp, { outcome: "signup_required", email, display_name, avatar_url })),
    Linked: ({ provider }) => Effect.succeed(encode_ok(C.OauthCallbackResp, { outcome: "linked", provider })),
    LinkedElsewhere: () => Effect.succeed(encode_ok(C.OauthCallbackResp, { outcome: "linked_elsewhere" })),
    EmailTaken: ({ email }) => Effect.succeed(encode_ok(C.OauthCallbackResp, { outcome: "email_taken", email })),
    NoVerifiedEmail: () => Effect.succeed(encode_ok(C.OauthCallbackResp, { outcome: "no_verified_email" })) });
});

const oauth_second_factor_handler = Effect.gen(function* () {
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.OauthSecondFactorReq, json);
  const session = yield* SignIn.oauth_second_factor({
    flow_id: input.flowId,
    flow_secret: input.flowSecret,
    totp_code: input.totpCode,
    recovery_code: input.recoveryCode,
    requester: yield* requester });
  return yield* with_session_cookie(encode_ok(C.MagicFinalizeResp, session_fields(session)), session);
});

const oauth_signup_handler = Effect.gen(function* () {
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.OauthSignupReq, json);
  const session = yield* SignIn.oauth_signup({
    flow_id: input.flowId,
    flow_secret: input.flowSecret,
    display_name: input.displayName,
    requester: yield* requester });
  return yield* with_session_cookie(encode_ok(C.MagicFinalizeResp, session_fields(session)), session);
});

export const router = HttpRouter.empty.pipe(
  register_route(R.oauth_start, oauth_start_handler),
  register_route(R.oauth_callback, oauth_callback_handler),
  register_route(R.oauth_second_factor, oauth_second_factor_handler),
  register_route(R.oauth_signup, oauth_signup_handler),
);
