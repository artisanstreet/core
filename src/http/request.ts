import { Chunk, Effect, Either, Match, Option, Schema, Stream } from "effect";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as Headers from "@effect/platform/Headers";
import * as Url from "@effect/platform/Url";
import { CoreError, forbidden, payload_too_large, unauthorized } from "../errors.ts";
import { AppConfigTag } from "../services/deps.ts";
import * as Auth from "../services/auth.ts";
import * as Machines from "../services/machines.ts";
import { max_body_bytes } from "./response.ts";
import {
  parse_session_cookie,
  pick_session,
  tokens_after_sign_in,
  tokens_without_account,
  type Held,
} from "./session-cookie.ts";

function get_header(req: HttpServerRequest.HttpServerRequest, name: string): string | undefined {
  const v = Headers.get(req.headers, name);
  return Option.isSome(v) ? v.value : undefined;
}

export const client_ip = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const cfg = yield* AppConfigTag;
  const cf = (get_header(req, "cf-connecting-ip") ?? "").trim() || null;
  if (cfg.core_env === "production") return cf;
  return get_header(req, "x-forwarded-for")?.split(",")[0]?.trim() || cf;
});

export const assemble_bytes = (total: number, parts: Iterable<Uint8Array>): Uint8Array => {
  const buf = new Uint8Array(total);
  let off = 0;
  for (const ch of parts) {
    buf.set(ch, off);
    off += ch.byteLength;
  }
  return buf;
};

export const read_raw_body = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const source = req.source as unknown as Request;
  if (!source.body) return "";
  const acc = yield* Stream.runFoldEffect(req.stream, { total: 0, chunks: Chunk.empty<Uint8Array>() }, (state, chunk) => {
    const total = state.total + chunk.byteLength;
    if (total > max_body_bytes) return Effect.fail(payload_too_large());
    return Effect.succeed({ total, chunks: Chunk.append(state.chunks, chunk) });
  }).pipe(
    Effect.mapError((e) => (e instanceof CoreError ? e : new CoreError("bad_request", "invalid body"))),
  );
  return new TextDecoder().decode(assemble_bytes(acc.total, acc.chunks));
});

export const parse_json_text = (raw: string) =>
  Effect.gen(function* () {
    if (!raw) return {};
    return yield* Schema.decodeUnknown(Schema.parseJson(Schema.Unknown))(raw).pipe(
      Effect.mapError(() => new CoreError("bad_request", "invalid json")),
    );
  });

export const read_json_body = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const ct = get_header(req, "content-type") ?? "";
  if (!ct.includes("application/json")) {
    return yield* Effect.fail(new CoreError("bad_request", "content-type must be application/json"));
  }
  const raw = yield* read_raw_body;
  const json = yield* parse_json_text(raw);
  return { raw, json };
});

export const decode_request = <A, I>(schema: Schema.Schema<A, I>, input: unknown): Effect.Effect<A, CoreError> =>
  Schema.decodeUnknown(schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(() => new CoreError("bad_request", "invalid request")),
  );

export const require_json_content_type = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const ct = get_header(req, "content-type") ?? "";
  if (!ct.includes("application/json")) {
    return yield* Effect.fail(new CoreError("bad_request", "content-type must be application/json"));
  }
});

export interface SessionVia {
  readonly principal: Auth.SessionPrincipal;
  readonly via: "bearer" | "cookie";
  readonly token: string;
}

export interface HeldSession extends Held {
  readonly principal: Auth.SessionPrincipal;
}

const bearer_of = (req: HttpServerRequest.HttpServerRequest): Option.Option<string> =>
  Option.fromNullable(/^Bearer\s+(.+)$/.exec(get_header(req, "authorization") ?? "")?.[1]?.trim()).pipe(
    Option.filter((token) => token !== ""),
  );

const held_one = (token: string) =>
  Auth.require_session(token).pipe(
    Effect.map((principal): Option.Option<HeldSession> =>
      Option.some({ token, account_id: principal.account_id, principal }),
    ),
    Effect.catchIf(
      (error) => error instanceof CoreError && error.code === "unauthorized",
      () => Effect.succeed(Option.none<HeldSession>()),
    ),
  );

export const held_sessions = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const tokens = parse_session_cookie((req.cookies as Record<string, string | undefined>)["ast_session"]);
  const held = yield* Effect.forEach(tokens, held_one);
  return held.flatMap((entry) => Option.toArray(entry));
});

export const selected_account = Effect.map(HttpServerRequest.HttpServerRequest, (req) =>
  Option.fromNullable(get_header(req, "x-ast-account")).pipe(Option.filter((value) => value !== "")),
);

const cookie_session = Effect.gen(function* () {
  const held = yield* held_sessions;
  const selected = yield* selected_account;
  const found = yield* Option.match(pick_session(held, selected), {
    onNone: () => Effect.fail(unauthorized("authentication required")),
    onSome: (entry) => Effect.succeed(entry),
  });
  const session: SessionVia = { principal: found.principal, via: "cookie", token: found.token };
  return session;
});

export const session_of = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  return yield* Option.match(bearer_of(req), {
    onNone: () => cookie_session,
    onSome: (token) =>
      Auth.require_session(token).pipe(
        Effect.map((principal): SessionVia => ({ principal, via: "bearer", token })),
      ),
  });
});

export const current_token = Effect.map(session_of, (session) => session.token);

export const cookie_after_sign_in = (signed_in: Held) =>
  Effect.map(held_sessions, (held) => tokens_after_sign_in(held, signed_in));

export const cookie_without_account = (account_id: string) =>
  Effect.map(held_sessions, (held) => tokens_without_account(held, account_id));

const parse_url = (raw: string) => Url.fromString(raw).pipe(Either.mapLeft(() => forbidden("bad origin")));

export const session_for_mutation = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const { principal, via } = yield* session_of;
  const cookie_check = Effect.gen(function* () {
    const cfg = yield* AppConfigTag;
    const origin = get_header(req, "origin");
    if (!origin) return yield* Effect.fail(forbidden("origin required"));
    const origin_url = yield* parse_url(origin);
    const request_url = yield* parse_url(req.originalUrl);
    if (origin_url.origin === request_url.origin) return principal;
    if (cfg.allowed_browser_origins.includes(origin_url.origin)) return principal;
    return yield* Effect.fail(forbidden("cross-origin forbidden"));
  });
  return yield* Match.value(via).pipe(
    Match.when("bearer", () => Effect.succeed(principal)),
    Match.when("cookie", () => cookie_check),
    Match.exhaustive,
  );
});

export interface ProofResult {
  readonly principal: { machine_id: string; account_id: string } | null;
  readonly public_key_x: string;
  readonly subject_id: string;
  readonly raw_body: string;
}

const proof_for = (kind: "machine" | "enrollment") =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    const subject_id = get_header(req, "x-ast-machine") ?? "";
    const timestamp = get_header(req, "x-ast-timestamp") ?? "";
    const nonce = get_header(req, "x-ast-nonce") ?? "";
    const auth = get_header(req, "authorization") ?? "";
    const m = /^AST-Machine\s+(.+)$/.exec(auth);
    const raw_body = yield* read_raw_body;
    const path_and_query = req.url;
    const who = yield* Machines.authenticate_machine_proof({
      subject_id,
      timestamp,
      nonce,
      signature: (m?.[1] ?? "").trim(),
      method: req.method,
      path_and_query,
      raw_body });
    if (kind === "machine" && (!who.machine_id || !who.account_id)) {
      return yield* Effect.fail(unauthorized("machine authentication required"));
    }
    if (kind === "enrollment" && !subject_id.startsWith("enr_")) {
      return yield* Effect.fail(unauthorized("enrollment authentication required"));
    }
    return {
      principal: who.machine_id && who.account_id ? { machine_id: who.machine_id, account_id: who.account_id } : null,
      public_key_x: who.public_key_x,
      subject_id,
      raw_body };
  });

export const proof_for_machine = Effect.gen(function* () {
  const r = yield* proof_for("machine");
  if (!r.principal) return yield* Effect.fail(unauthorized("machine authentication required"));
  return { principal: r.principal, public_key_x: r.public_key_x, subject_id: r.subject_id, raw_body: r.raw_body };
});

export const proof_for_enrollment = proof_for("enrollment");

export const if_none_match = (current_hash: string) =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    const header = get_header(req, "if-none-match");
    if (!header) return false;
    for (const part of header.split(",")) {
      const t = part.trim().replace(/^W\//, "");
      if (t === "*") return true;
      if (t.length >= 2 && t.startsWith('"') && t.endsWith('"') && t.slice(1, -1) === current_hash) {
        return true;
      }
    }
    return false;
  });
