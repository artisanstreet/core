import { Effect } from "effect";
import { bad_request, conflict, internal, not_found } from "../errors.ts";
import { DbTag, db_run } from "./deps.ts";
import get_profile from "../db/queries/accounts/get-profile.sql";
import set_display_name from "../db/queries/accounts/set-display-name.sql";
import set_username from "../db/queries/accounts/set-username.sql";
import set_phone from "../db/queries/accounts/set-phone.sql";
import set_avatar from "../db/queries/accounts/set-avatar.sql";

export const profile_of = (id: string) => Effect.gen(function* () {
  const { db } = yield* DbTag;
  const profile = yield* db_run(() => get_profile.run(db, { id }));
  if (!profile) return yield* Effect.fail(not_found("account not found"));
  return profile;
});

export const update_name = (id: string, input: string) => Effect.gen(function* () {
  const { db } = yield* DbTag;
  const display_name = input.trim();
  if (!display_name) return yield* Effect.fail(bad_request("Enter a display name."));
  yield* db_run(() => set_display_name.run(db, { id, display_name }));
  return yield* profile_of(id);
});

export const update_username = (id: string, username: string) => Effect.gen(function* () {
  const { db } = yield* DbTag;
  yield* Effect.tryPromise({
    try: () => set_username.run(db, { id, username }),
    catch: (cause) => typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505"
      ? conflict("That username is already taken.")
      : internal("database unavailable", { cause }),
  });
  return yield* profile_of(id);
});

export const update_avatar = (id: string, avatar_url: string) => Effect.gen(function* () {
  const { db } = yield* DbTag;
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(avatar_url);
  if (!match) return yield* Effect.fail(bad_request("Choose a valid image."));
  const bytes = yield* Effect.try({ try: () => atob(match[1]!), catch: () => bad_request("Choose a valid image.") });
  if (bytes.length > 262144 || bytes.length < 4 || bytes.charCodeAt(0) !== 255 || bytes.charCodeAt(1) !== 216 || bytes.charCodeAt(2) !== 255) {
    return yield* Effect.fail(bad_request("Choose a valid image under 256 KB."));
  }
  yield* db_run(() => set_avatar.run(db, { id, avatar_url }));
  return yield* profile_of(id);
});

export const update_phone = (id: string, phone: string | null) => Effect.gen(function* () {
  const { db } = yield* DbTag;
  yield* db_run(() => set_phone.run(db, { id, phone }));
  return yield* profile_of(id);
});
