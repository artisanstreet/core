import { Context, Effect, Layer, Match, Schema } from "effect";
import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientRequest from "@effect/platform/HttpClientRequest";
import * as HttpClientResponse from "@effect/platform/HttpClientResponse";
import { createRemoteJWKSet as create_remote_jwk_set, jwtVerify as jwt_verify } from "jose";
import { unauthorized, unavailable, type CoreError } from "../errors.ts";
import { AppConfigTag, type AppConfig } from "./deps.ts";

export type OauthProvider = "google" | "github";

export interface OauthProfile {
  readonly subject: string;
  readonly verified_email: string | null;
  readonly display_name: string;
  readonly avatar_url: string | null;
}

export interface AuthorizeRequest {
  readonly state: string;
  readonly code_challenge: string;
  readonly redirect_uri: string;
}

export interface ExchangeRequest {
  readonly code: string;
  readonly code_verifier: string;
  readonly redirect_uri: string;
}

export interface OauthClient {
  readonly authorize_url: (provider: OauthProvider, request: AuthorizeRequest) => Effect.Effect<string, CoreError>;
  readonly exchange: (provider: OauthProvider, request: ExchangeRequest) => Effect.Effect<OauthProfile, CoreError>;
}

export class OauthTag extends Context.Tag("Oauth")<OauthTag, OauthClient>() {}

interface ClientCredentials {
  readonly id: string;
  readonly secret: string;
}

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const google_keys = create_remote_jwk_set(new URL("https://www.googleapis.com/oauth2/v3/certs"));

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API = "https://api.github.com";

const GoogleToken = Schema.Struct({ id_token: Schema.String });
const GoogleClaims = Schema.Struct({
  sub: Schema.String,
  email: Schema.optional(Schema.String),
  email_verified: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
  picture: Schema.optional(Schema.String) });

const GithubToken = Schema.Struct({ access_token: Schema.String });
const GithubUser = Schema.Struct({
  id: Schema.Number,
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatar_url: Schema.NullOr(Schema.String) });
const GithubEmails = Schema.Array(
  Schema.Struct({ email: Schema.String, primary: Schema.Boolean, verified: Schema.Boolean }),
);

const provider_failed = () => unauthorized("sign-in with provider failed");

const credentials_for = (cfg: AppConfig, provider: OauthProvider): Effect.Effect<ClientCredentials, CoreError> => {
  const [id, secret] = Match.value(provider).pipe(
    Match.when("google", () => [cfg.env.GOOGLE_CLIENT_ID, cfg.env.GOOGLE_CLIENT_SECRET] as const),
    Match.when("github", () => [cfg.env.GITHUB_CLIENT_ID, cfg.env.GITHUB_CLIENT_SECRET] as const),
    Match.exhaustive,
  );
  return id && secret
    ? Effect.succeed({ id, secret })
    : Effect.fail(unavailable("sign-in provider unavailable"));
};

const authorize_url_for = (provider: OauthProvider, credentials: ClientCredentials, request: AuthorizeRequest) => {
  const [base, scope] = Match.value(provider).pipe(
    Match.when("google", () => [GOOGLE_AUTHORIZE_URL, "openid email profile"] as const),
    Match.when("github", () => [GITHUB_AUTHORIZE_URL, "read:user user:email"] as const),
    Match.exhaustive,
  );
  const url = new URL(base);
  url.search = new URLSearchParams({
    client_id: credentials.id,
    redirect_uri: request.redirect_uri,
    response_type: "code",
    scope,
    state: request.state,
    code_challenge: request.code_challenge,
    code_challenge_method: "S256" }).toString();
  return url.toString();
};

const read_json = <A, I>(schema: Schema.Schema<A, I>, response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    if (response.status !== 200) return yield* Effect.fail(provider_failed());
    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(Effect.mapError(provider_failed));
  });

const token_request = (url: string, credentials: ClientCredentials, request: ExchangeRequest) =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bodyUrlParams({
      client_id: credentials.id,
      client_secret: credentials.secret,
      code: request.code,
      code_verifier: request.code_verifier,
      redirect_uri: request.redirect_uri,
      grant_type: "authorization_code" }),
  );

const google_profile = (client: HttpClient.HttpClient, credentials: ClientCredentials, request: ExchangeRequest) =>
  Effect.gen(function* () {
    const response = yield* client
      .execute(token_request(GOOGLE_TOKEN_URL, credentials, request))
      .pipe(Effect.mapError(provider_failed));
    const token = yield* read_json(GoogleToken, response);
    const verified = yield* Effect.tryPromise({
      try: () => jwt_verify(token.id_token, google_keys, { issuer: GOOGLE_ISSUERS, audience: credentials.id }),
      catch: provider_failed });
    const claims = yield* Schema.decodeUnknown(GoogleClaims)(verified.payload).pipe(Effect.mapError(provider_failed));
    return {
      subject: claims.sub,
      verified_email: claims.email && claims.email_verified ? claims.email.toLowerCase() : null,
      display_name: claims.name ?? "",
      avatar_url: claims.picture ?? null } satisfies OauthProfile;
  });

const github_get = (client: HttpClient.HttpClient, access_token: string, path: string) =>
  client
    .execute(
      HttpClientRequest.get(`${GITHUB_API}${path}`).pipe(
        HttpClientRequest.bearerToken(access_token),
        HttpClientRequest.setHeaders({ accept: "application/vnd.github+json", "user-agent": "ast-core" }),
      ),
    )
    .pipe(Effect.mapError(provider_failed));

const github_profile = (client: HttpClient.HttpClient, credentials: ClientCredentials, request: ExchangeRequest) =>
  Effect.gen(function* () {
    const response = yield* client
      .execute(token_request(GITHUB_TOKEN_URL, credentials, request))
      .pipe(Effect.mapError(provider_failed));
    const token = yield* read_json(GithubToken, response);
    const user = yield* read_json(GithubUser, yield* github_get(client, token.access_token, "/user"));
    const emails = yield* read_json(GithubEmails, yield* github_get(client, token.access_token, "/user/emails"));
    const primary = emails.find((entry) => entry.primary && entry.verified);
    return {
      subject: String(user.id),
      verified_email: primary ? primary.email.toLowerCase() : null,
      display_name: user.name ?? user.login,
      avatar_url: user.avatar_url } satisfies OauthProfile;
  });

export const OauthLive = Layer.effect(
  OauthTag,
  Effect.gen(function* () {
    const cfg = yield* AppConfigTag;
    const client = yield* HttpClient.HttpClient;
    return {
      authorize_url: (provider, request) =>
        credentials_for(cfg, provider).pipe(
          Effect.map((credentials) => authorize_url_for(provider, credentials, request)),
        ),
      exchange: (provider, request) =>
        Effect.flatMap(credentials_for(cfg, provider), (credentials) =>
          Match.value(provider).pipe(
            Match.when("google", () => google_profile(client, credentials, request)),
            Match.when("github", () => github_profile(client, credentials, request)),
            Match.exhaustive,
          ),
        ) } satisfies OauthClient;
  }),
);
