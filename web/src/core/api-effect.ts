// Effect HTTP browser client over `@effect/platform` `HttpClient`.
// Cookie auth rides on `FetchHttpClient.RequestInit{credentials:include}`;
// the Promise facade in `../api.ts` is the only UI boundary. GETs retry
// transient failures; POSTs run once.

import { Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest, type HttpClientResponse } from "@effect/platform";
import { ApiFailure, DecodeFailure, TransportFailure, error_shape } from "./api-error.ts";
import * as C from "../../../src/contracts/v1.ts";

export const strict_options = { onExcessProperty: "error" } as const;

export type FetchLike = typeof fetch;

/** Strict-encode a request body; unknown fields rejected client-side. */
export function encode_strict<A, I>(schema: Schema.Schema<A, I>, value: A): I {
  return Schema.encodeUnknownSync(schema, strict_options)(value) as I;
}

/** Lenient-decode a response; additive v1 fields ignored. */
export function decode_lenient<A, I>(schema: Schema.Schema<A, I>, input: unknown): A {
  return Schema.decodeUnknownSync(schema)(input);
}

/** Resolve a same-origin path against the page origin (browser) or a
 * throwaway base (Node tests). Platform requests need absolute URLs. */
/* eslint-disable no-restricted-globals */
const absolute_url_effect = (base: string, path: string) =>
  Effect.try({
    try: () => {
      const origin = typeof location !== "undefined" && location.origin ? location.origin : "http://localhost";
      return new URL(base + path, origin).toString();
    },
    catch: () => new TransportFailure({ reason: "bad request url" }),
  });
/* eslint-enable no-restricted-globals */

/** Run an HttpClient-requiring Effect with browser-cookie credentials. */
const with_browser_http = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  fetch_impl: FetchLike,
): Effect.Effect<A, E> =>
  effect.pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch_impl),
    Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" } as RequestInit),
  );

const to_transport = (error: unknown): TransportFailure =>
  new TransportFailure({ reason: error instanceof Error ? error.message : "fetch failed" });

const read_json = (res: HttpClientResponse.HttpClientResponse) =>
  Effect.mapError(
    res.json,
    () => new DecodeFailure({ reason: `unreadable body ${res.status}` }),
  );

const check_status = (status: number, json: unknown) => {
  if (status >= 200 && status < 300) return Effect.succeed(json);
  const shape = error_shape(json);
  if (shape.code === "bad_response") {
    return Effect.fail(new DecodeFailure({ reason: `status ${status}` }));
  }
  return Effect.fail(
    new ApiFailure({ status, code: shape.code, message: shape.message, request_id: shape.requestId }),
  );
};

/** Retry schedule for idempotent GETs: exponential backoff, 2 retries. */
const get_retry_schedule = Schedule.exponential("200 millis").pipe(Schedule.intersect(Schedule.recurs(2)));

export const api_get = <A, I>(
  fetch_impl: FetchLike,
  base: string,
  path: string,
  response_schema: Schema.Schema<A, I>,
) =>
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.retryTransient({ schedule: get_retry_schedule, times: 2 }),
    );
    const url = yield* absolute_url_effect(base, path);
    const request = HttpClientRequest.setHeaders(HttpClientRequest.get(url), { accept: "application/json" });
    // Without `filter_status`, error channel carries transport
    // `RequestError` only — statuses are checked explicitly below.
    const res = yield* Effect.mapError(client.execute(request), to_transport);
    const json = yield* read_json(res);
    const ok = yield* check_status(res.status, json);
    return yield* Effect.try({
      try: () => decode_lenient(response_schema, ok),
      catch: () => new DecodeFailure({ reason: "unreadable shape" }),
    });
  }).pipe((program) => with_browser_http(program, fetch_impl));

/** Fetch seam + base for composed Effect grant flows (internal plumbing). */
export interface HttpSeam {
  readonly fetch_impl: FetchLike;
  readonly base: string;
}

/** Internal Effect API for login-status polling; `CoreApi.login_status` is the Promise boundary over this. */
export const login_status_effect = (
  fetch_impl: FetchLike,
  base: string,
  request_id: string,
  request_secret: string,
) =>
  api_post(
    fetch_impl,
    base,
    "/v1/auth/magic/status",
    C.MagicStatusReq,
    { requestId: request_id, requestSecret: request_secret },
    C.MagicStatusResp,
    () => new ApiFailure({ status: 400, code: "bad_request", message: "bad request", request_id: "" }),
  );

/** Internal Effect API for editor grant issue; `CoreApi.issue_grant` is the Promise boundary over this. */
export const issue_grant_effect = (
  fetch_impl: FetchLike,
  base: string,
  body: typeof C.GrantIssueReq.Type,
) =>
  api_post(
    fetch_impl,
    base,
    "/v1/grants/issue",
    C.GrantIssueReq,
    body,
    C.GrantIssueResp,
    (encode_err) =>
      new ApiFailure({
        status: 400,
        code: "bad_request",
        message: encode_err instanceof Error ? encode_err.message : "bad request",
        request_id: "",
      }),
  );

export const api_post = <RA, RI, A, I>(
  fetch_impl: FetchLike,
  base: string,
  path: string,
  request_schema: Schema.Schema<RA, RI> | null,
  request_body: RA | null,
  response_schema: Schema.Schema<A, I>,
  encode_error: (encode_err: unknown) => ApiFailure,
) =>
  Effect.gen(function* () {
    // Single attempt: mutating POSTs are never retried.
    const client = yield* HttpClient.HttpClient;
    let encoded = "{}";
    if (request_schema && request_body !== null) {
      const strict = yield* Effect.try({
        try: () => JSON.stringify(encode_strict(request_schema, request_body)),
        catch: (encode_err) => encode_error(encode_err),
      });
      encoded = strict;
    }
    const url = yield* absolute_url_effect(base, path);
    let request = HttpClientRequest.setHeaders(HttpClientRequest.post(url), {
      accept: "application/json",
    });
    request = HttpClientRequest.setBody(request, HttpBody.text(encoded, "application/json"));
    const res = yield* Effect.mapError(client.execute(request), to_transport);
    const json = yield* read_json(res);
    const ok = yield* check_status(res.status, json);
    return yield* Effect.try({
      try: () => decode_lenient(response_schema, ok),
      catch: () => new DecodeFailure({ reason: "unreadable shape" }),
    });
  }).pipe((program) => with_browser_http(program, fetch_impl));
