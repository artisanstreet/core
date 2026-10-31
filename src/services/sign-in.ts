import { Data, Effect } from "effect";
import { base64url_encode, decrypt_with_key, encrypt_with_key, random_bytes, sha256_bytes, sha256_hex } from "../crypto.ts";
import { OAUTH_FLOW_TTL_SECONDS, RATE_WINDOW_SECONDS } from "../constants.ts";
import { bad_request, conflict, gone, unauthorized } from "../errors.ts";
import { new_id } from "../ids.ts";
import { AppConfigTag, DbTag, TxTag, db_run } from "./deps.ts";
import { check_budget } from "./ratelimit.ts";
import { record } from "./activity.ts";
import { assert_second_factor, open_session } from "./auth.ts";
import { OauthTag, type OauthProfile, type OauthProvider } from "./oauth.ts";
import insert_account from "../db/queries/accounts/insert-account.sql"
import get_account_by_email from "../db/queries/accounts/get-account-by-email.sql"
import get_account_contact from "../db/queries/accounts/get-account-contact.sql"
import lock_account from "../db/queries/accounts/lock-account.sql"
import fill_account_avatar from "../db/queries/accounts/fill-account-avatar.sql"
import insert_sign_in_method from "../db/queries/sign-in/insert-sign-in-method.sql"
import list_sign_in_methods_by_account from "../db/queries/sign-in/list-sign-in-methods-by-account.sql"
import get_account_by_sign_in from "../db/queries/sign-in/get-account-by-sign-in.sql"
import count_sign_in_methods from "../db/queries/sign-in/count-sign-in-methods.sql"
import remove_sign_in_method from "../db/queries/sign-in/remove-sign-in-method.sql"
import insert_oauth_flow from "../db/queries/oauth/insert-oauth-flow.sql"
import claim_oauth_flow from "../db/queries/oauth/claim-oauth-flow.sql"
import settle_oauth_flow from "../db/queries/oauth/settle-oauth-flow.sql"
import take_oauth_flow from "../db/queries/oauth/take-oauth-flow.sql"
import get_oauth_flow from "../db/queries/oauth/get-oauth-flow.sql"

export type SignInKind = "email" | OauthProvider;

export type OauthIntent = Data.TaggedEnum<{
  SignIn: {};
  Link: { readonly account_id: string };
}>;
export const OauthIntent = Data.taggedEnum<OauthIntent>();

export interface OpenedSession {
  readonly session_id: string;
  readonly raw_token: string;
  readonly account_id: string;
  readonly expires_at: string;
  readonly totp_verified: boolean;
}

export type CallbackOutcome = Data.TaggedEnum<{
  SignedIn: { readonly session: OpenedSession };
  SecondFactorRequired: {};
  SignupRequired: { readonly email: string; readonly display_name: string; readonly avatar_url: string | null };
  Linked: { readonly provider: OauthProvider };
  LinkedElsewhere: {};
  EmailTaken: { readonly email: string };
  NoVerifiedEmail: {};
}>;
export const CallbackOutcome = Data.taggedEnum<CallbackOutcome>();

export interface Requester {
  readonly ip: string | null;
  readonly user_agent: string | null;
}

const VERIFIER_PURPOSE = "oauth-verifier v1";

const sha_of = (value: string) => sha256_hex(`ast-core oauth v1:${value}`);

const intent_name = OauthIntent.$match({
  SignIn: () => "sign_in" as const,
  Link: () => "link" as const,
});

const intent_account = OauthIntent.$match({
  SignIn: () => null,
  Link: ({ account_id }) => account_id,
});

const redirect_uri_of = (cfg: { auth_public_base_url: string | null; public_base_url: string }) =>
  `${(cfg.auth_public_base_url ?? cfg.public_base_url).replace(/\/+$/, "")}/oauth/callback`;

export const list_methods = (account_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const account = yield* db_run(() => get_account_contact.run(db, { id: account_id }));
    if (!account || account.deleted_at) return yield* Effect.fail(gone("account is deleted"));
    const rows = yield* db_run(() => list_sign_in_methods_by_account.run(db, { account_id }));
    return {
      email: account.email,
      methods: rows.map((row) => ({ kind: row.kind as SignInKind, created_at: row.created_at })) };
  });

export const enable_email = (account_id: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const account = yield* db_run(() => get_account_contact.run(db, { id: account_id }));
    if (!account || account.deleted_at) return yield* Effect.fail(gone("account is deleted"));
    const added = yield* db_run(() =>
      insert_sign_in_method.run(db, { account_id, kind: "email", subject: account.email }),
    );
    if (added) yield* record(account_id, "sign_in.added", { detail: { kind: "email" } });
    return yield* list_methods(account_id);
  });

export const remove_method = (account_id: string, kind: SignInKind) =>
  Effect.gen(function* () {
    const tx = yield* TxTag;
    yield* tx.transaction(
      Effect.gen(function* () {
        const { db } = yield* DbTag;
        const locked = yield* db_run(() => lock_account.run(db, { id: account_id }));
        if (!locked) return yield* Effect.fail(gone("account is deleted"));
        const { n } = yield* db_run(() => count_sign_in_methods.run(db, { account_id }));
        if (n <= 1) return yield* Effect.fail(conflict("an account keeps at least one sign-in method"));
        const removed = yield* db_run(() => remove_sign_in_method.run(db, { account_id, kind }));
        if (!removed) return yield* Effect.fail(bad_request("sign-in method is not linked"));
      }),
    );
    yield* record(account_id, "sign_in.removed", { detail: { kind } });
    return yield* list_methods(account_id);
  });

export const start_oauth = (provider: OauthProvider, intent: OauthIntent, ip: string | null) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const oauth = yield* OauthTag;
    const now_ms = cfg.now();
    if (ip) yield* check_budget(`oauth:ip:${ip}`, RATE_WINDOW_SECONDS, 30, now_ms);
    yield* check_budget("oauth:global", RATE_WINDOW_SECONDS, 600, now_ms);

    const state = base64url_encode(random_bytes(32));
    const flow_secret = base64url_encode(random_bytes(32));
    const verifier = base64url_encode(random_bytes(32));
    const redirect_uri = redirect_uri_of(cfg);
    const authorize_url = yield* oauth.authorize_url(provider, {
      state,
      code_challenge: base64url_encode(sha256_bytes(verifier)),
      redirect_uri });
    const flow_id = new_id("oflow");
    const expires_at = new Date(now_ms + OAUTH_FLOW_TTL_SECONDS * 1000).toISOString();
    yield* db_run(() =>
      insert_oauth_flow.run(db, {
        id: flow_id,
        provider,
        intent: intent_name(intent),
        account_id: intent_account(intent),
        state_hash: sha_of(state),
        flow_secret_hash: sha_of(flow_secret),
        verifier_enc: encrypt_with_key(cfg.master_key.raw, new TextEncoder().encode(verifier), VERIFIER_PURPOSE),
        redirect_uri,
        expires_at }),
    );
    return { flow_id, flow_secret, authorize_url, expires_at };
  });


interface SettledProfile {
  readonly status: "awaiting_second_factor" | "signup_pending" | "completed";
  readonly account_id: string | null;
  readonly profile: OauthProfile | null;
}

const settle = (flow_id: string, settled: SettledProfile) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const row = yield* db_run(() =>
      settle_oauth_flow.run(db, {
        id: flow_id,
        status: settled.status,
        account_id: settled.account_id,
        subject: settled.profile?.subject ?? null,
        email: settled.profile?.verified_email ?? null,
        display_name: settled.profile?.display_name ?? null,
        avatar_url: settled.profile?.avatar_url ?? null }),
    );
    if (!row) return yield* Effect.fail(unauthorized("invalid or expired sign-in"));
  });

const adopt_avatar = (account_id: string, profile: OauthProfile) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    if (profile.avatar_url === null) return;
    yield* db_run(() => fill_account_avatar.run(db, { id: account_id, avatar_url: profile.avatar_url }));
  });

export const oauth_callback = (opts: {
  flow_id: string;
  flow_secret: string;
  state: string;
  code: string;
  requester: Requester;
}) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const oauth = yield* OauthTag;
    const flow = yield* db_run(() =>
      claim_oauth_flow.run(db, {
        id: opts.flow_id,
        state_hash: sha_of(opts.state),
        flow_secret_hash: sha_of(opts.flow_secret),
        now: new Date(cfg.now()).toISOString() }),
    );
    if (!flow) return yield* Effect.fail(unauthorized("invalid or expired sign-in"));
    const provider = flow.provider as OauthProvider;
    const verifier = yield* Effect.try({
      try: () => new TextDecoder().decode(decrypt_with_key(cfg.master_key.raw, new Uint8Array(flow.verifier_enc), VERIFIER_PURPOSE)),
      catch: () => unauthorized("invalid or expired sign-in") });
    const profile = yield* oauth.exchange(provider, { code: opts.code, code_verifier: verifier, redirect_uri: flow.redirect_uri });
    const owner = yield* db_run(() => get_account_by_sign_in.run(db, { kind: provider, subject: profile.subject }));

    if (flow.intent === "link") {
      const account_id = flow.account_id!;
      yield* settle(flow.id, { status: "completed", account_id, profile });
      if (owner && owner.id !== account_id) return CallbackOutcome.LinkedElsewhere();
      if (owner) return CallbackOutcome.Linked({ provider });
      const added = yield* db_run(() =>
        insert_sign_in_method.run(db, { account_id, kind: provider, subject: profile.subject }),
      );
      if (!added) return yield* Effect.fail(conflict(`a different ${provider} account is already linked`));
      yield* record(account_id, "sign_in.added", { detail: { kind: provider }, ip: opts.requester.ip });
      yield* adopt_avatar(account_id, profile);
      return CallbackOutcome.Linked({ provider });
    }

    if (owner?.deleted_at) {
      yield* settle(flow.id, { status: "completed", account_id: null, profile: null });
      return yield* Effect.fail(gone("account is deleted"));
    }
    if (owner) yield* adopt_avatar(owner.id, profile);
    if (owner && owner.totp_enrolled_at != null) {
      yield* settle(flow.id, { status: "awaiting_second_factor", account_id: owner.id, profile });
      return CallbackOutcome.SecondFactorRequired();
    }
    if (owner) {
      const gate = settle(flow.id, { status: "completed", account_id: owner.id, profile }).pipe(Effect.as(owner.id));
      const session = yield* open_session(gate, {
        totp_verified: false,
        ip: opts.requester.ip,
        user_agent: opts.requester.user_agent,
        event: `login.${provider}` });
      return CallbackOutcome.SignedIn({ session });
    }
    if (!profile.verified_email) {
      yield* settle(flow.id, { status: "completed", account_id: null, profile: null });
      return CallbackOutcome.NoVerifiedEmail();
    }
    const email = profile.verified_email;
    const taken = yield* db_run(() => get_account_by_email.run(db, { email }));
    if (taken) {
      yield* settle(flow.id, { status: "completed", account_id: null, profile: null });
      return CallbackOutcome.EmailTaken({ email });
    }
    yield* settle(flow.id, { status: "signup_pending", account_id: null, profile });
    return CallbackOutcome.SignupRequired({
      email,
      display_name: profile.display_name.slice(0, 120),
      avatar_url: profile.avatar_url });
  });

const pending_flow = (flow_id: string, flow_secret: string, status: "awaiting_second_factor" | "signup_pending") =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const cfg = yield* AppConfigTag;
    const flow = yield* db_run(() => get_oauth_flow.run(db, { id: flow_id, flow_secret_hash: sha_of(flow_secret) }));
    if (!flow || flow.status !== status || Date.parse(flow.expires_at) <= cfg.now()) {
      return yield* Effect.fail(unauthorized("invalid or expired sign-in"));
    }
    return { ...flow, provider: flow.provider as OauthProvider, now: new Date(cfg.now()).toISOString() };
  });

const take = (flow_id: string, flow_secret: string, status: "awaiting_second_factor" | "signup_pending", now: string) =>
  Effect.gen(function* () {
    const { db } = yield* DbTag;
    const taken = yield* db_run(() =>
      take_oauth_flow.run(db, { id: flow_id, flow_secret_hash: sha_of(flow_secret), status, now }),
    );
    if (!taken) return yield* Effect.fail(unauthorized("invalid or expired sign-in"));
    return taken;
  });

export const oauth_second_factor = (opts: {
  flow_id: string;
  flow_secret: string;
  totp_code?: string;
  recovery_code?: string;
  requester: Requester;
}) =>
  Effect.gen(function* () {
    const flow = yield* pending_flow(opts.flow_id, opts.flow_secret, "awaiting_second_factor");
    const account_id = flow.account_id!;
    yield* assert_second_factor(account_id, { totp_code: opts.totp_code, recovery_code: opts.recovery_code });
    const gate = take(opts.flow_id, opts.flow_secret, "awaiting_second_factor", flow.now).pipe(Effect.as(account_id));
    return yield* open_session(gate, {
      totp_verified: true,
      ip: opts.requester.ip,
      user_agent: opts.requester.user_agent,
      event: `login.${flow.provider}` });
  });

export const oauth_signup = (opts: {
  flow_id: string;
  flow_secret: string;
  display_name: string;
  requester: Requester;
}) =>
  Effect.gen(function* () {
    const flow = yield* pending_flow(opts.flow_id, opts.flow_secret, "signup_pending");
    const gate = Effect.gen(function* () {
      const { db } = yield* DbTag;
      const taken = yield* take(opts.flow_id, opts.flow_secret, "signup_pending", flow.now);
      const email = taken.email!;
      const subject = taken.subject!;
      const by_email = yield* db_run(() => get_account_by_email.run(db, { email }));
      if (by_email) return yield* Effect.fail(conflict("email already used"));
      const by_subject = yield* db_run(() => get_account_by_sign_in.run(db, { kind: flow.provider, subject }));
      if (by_subject) return yield* Effect.fail(conflict("provider account already linked"));
      const account_id = new_id("acct");
      yield* db_run(() =>
        insert_account.run(db, {
          id: account_id,
          email,
          display_name: opts.display_name.trim().slice(0, 120),
          avatar_url: taken.avatar_url }),
      );
      yield* db_run(() => insert_sign_in_method.run(db, { account_id, kind: flow.provider, subject }));
      return account_id;
    });
    return yield* open_session(gate, {
      totp_verified: false,
      ip: opts.requester.ip,
      user_agent: opts.requester.user_agent,
      event: `signup.${flow.provider}` });
  });

const sign_in_kinds: ReadonlyArray<SignInKind> = ["email", "google", "github"];

export const parse_sign_in_kind = (raw: string) =>
  Effect.fromNullable(sign_in_kinds.find((kind) => kind === raw)).pipe(
    Effect.mapError(() => bad_request("unknown sign-in method")),
  );
