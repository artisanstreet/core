import { Effect, Either, Match, Option, Schema, Stream } from "effect";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as Headers from "@effect/platform/Headers";
import * as Url from "@effect/platform/Url";
import { CoreError, forbidden, payloadTooLarge, unauthorized } from "../errors.ts";
import { AppConfigTag } from "../services/deps.ts";
import * as Auth from "../services/auth.ts";
import * as Machines from "../services/machines.ts";
import { max_body_bytes } from "./response.ts";

function get_header(req: HttpServerRequest.HttpServerRequest, name: string): string | undefined {
  const v = Headers.get(req.headers, name);
  return Option.isSome(v) ? v.value : undefined;
}

export const client_ip = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const cfg = yield* AppConfigTag;
  const cf = (get_header(req, "cf-connecting-ip") ?? "").trim() || null;
  if (cfg.coreEnv === "production") return cf;
  return get_header(req, "x-forwarded-for")?.split(",")[0]?.trim() || cf;
});

export const read_raw_body = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const source = req.source as unknown as Request;
  if (!source.body) return "";
  const acc = yield* Stream.runFoldEffect(req.stream, { total: 0, chunks: [] as Array<Uint8Array> }, (state, chunk) => {
    const total = state.total + chunk.byteLength;
    if (total > max_body_bytes) return Effect.fail(payloadTooLarge());
    return Effect.succeed({ total, chunks: [...state.chunks, chunk] });
  }).pipe(
    Effect.mapError((e) => (e instanceof CoreError ? e : new CoreError("bad_request", "invalid body"))),
  );
  const buf = new Uint8Array(acc.total);
  let off = 0;
  for (const ch of acc.chunks) {
    buf.set(ch, off);
    off += ch.byteLength;
  }
  return new TextDecoder().decode(buf);
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
}

function extract_token(req: HttpServerRequest.HttpServerRequest): { token: string | null; via: "bearer" | "cookie" } {
  const auth = get_header(req, "authorization") ?? "";
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (m?.[1]?.trim()) return { token: m[1].trim(), via: "bearer" };
  const from_cookies = (req.cookies as Record<string, string | undefined>)["ast_session"];
  if (!from_cookies) return { token: null, via: "cookie" };
  const decoded = Either.getOrNull(Either.try(() => decodeURIComponent(from_cookies)));
  return decoded === null ? { token: null, via: "cookie" } : { token: decoded, via: "cookie" };
}

export const session_of = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const { token, via } = extract_token(req);
  if (!token) return yield* Effect.fail(unauthorized("authentication required"));
  const principal = yield* Auth.requireSession(token);
  return { principal, via };
});

export const current_token = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const { token } = extract_token(req);
  if (!token) return yield* Effect.fail(unauthorized("authentication required"));
  return token;
});

const parse_url = (raw: string) => Url.fromString(raw).pipe(Either.mapLeft(() => forbidden("bad origin")));

export const session_for_mutation = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const { principal, via } = yield* session_of;
  return yield* Match.value(via).pipe(
    Match.when("bearer", () => Effect.succeed(principal)),
    Match.when("cookie", () =>
      Effect.gen(function* () {
        const origin = get_header(req, "origin");
        if (!origin) return yield* Effect.fail(forbidden("origin required"));
        const origin_url = yield* parse_url(origin);
        const request_url = yield* parse_url(req.originalUrl);
        if (origin_url.origin !== request_url.origin) return yield* Effect.fail(forbidden("cross-origin forbidden"));
        return principal;
      })),
    Match.exhaustive,
  );
});

export interface ProofResult {
  readonly principal: { machineId: string; accountId: string } | null;
  readonly publicKeyX: string;
  readonly subjectId: string;
  readonly rawBody: string;
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
    const who = yield* Machines.authenticateMachineProof({
      subjectId: subject_id,
      timestamp,
      nonce,
      signature: (m?.[1] ?? "").trim(),
      method: req.method,
      pathAndQuery: path_and_query,
      rawBody: raw_body,
    });
    if (kind === "machine" && (!who.machineId || !who.accountId)) {
      return yield* Effect.fail(unauthorized("machine authentication required"));
    }
    if (kind === "enrollment" && !subject_id.startsWith("enr_")) {
      return yield* Effect.fail(unauthorized("enrollment authentication required"));
    }
    return {
      principal: who.machineId && who.accountId ? { machineId: who.machineId, accountId: who.accountId } : null,
      publicKeyX: who.publicKeyX,
      subjectId: subject_id,
      rawBody: raw_body,
    };
  });

export const proof_for_machine = Effect.gen(function* () {
  const r = yield* proof_for("machine");
  if (!r.principal) return yield* Effect.fail(unauthorized("machine authentication required"));
  return { principal: r.principal, publicKeyX: r.publicKeyX, subjectId: r.subjectId, rawBody: r.rawBody };
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
