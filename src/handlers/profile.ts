import { Effect } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import * as C from "../contracts/v1.ts";
import { R } from "../contracts/registry.ts";
import { register_route } from "../http/register.ts";
import { decode_request, read_json_body, session_for_mutation, session_of } from "../http/request.ts";
import { encode_ok } from "../http/response.ts";
import * as Profile from "../services/profile.ts";

const get = Effect.gen(function* () {
  const { principal } = yield* session_of;
  return encode_ok(C.ProfileResp, yield* Profile.profile_of(principal.account_id));
});

const name = Effect.gen(function* () {
  const principal = yield* session_for_mutation;
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.ProfileNameReq, json);
  return encode_ok(C.ProfileResp, yield* Profile.update_name(principal.account_id, input.displayName));
});

const username = Effect.gen(function* () {
  const principal = yield* session_for_mutation;
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.ProfileUsernameReq, json);
  return encode_ok(C.ProfileResp, yield* Profile.update_username(principal.account_id, input.username));
});

const phone = Effect.gen(function* () {
  const principal = yield* session_for_mutation;
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.ProfilePhoneReq, json);
  return encode_ok(C.ProfileResp, yield* Profile.update_phone(principal.account_id, input.phone));
});

const avatar = Effect.gen(function* () {
  const principal = yield* session_for_mutation;
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.ProfileAvatarReq, json);
  return encode_ok(C.ProfileResp, yield* Profile.update_avatar(principal.account_id, input.avatar));
});

export const router = HttpRouter.empty.pipe(
  register_route(R.profile, get),
  register_route(R.profile_name, name),
  register_route(R.profile_username, username),
  register_route(R.profile_avatar, avatar),
  register_route(R.profile_phone, phone),
);
