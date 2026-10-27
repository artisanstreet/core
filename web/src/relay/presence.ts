// Authenticated Relay presence reads (Bearer grant, same account+machine).
// Effect `HttpClient` underneath (no cookie credentials: Relay auth is
// Bearer grants, never cookies). Tracer propagation is off: `b3`/
// `traceparent` headers would fail Relay's CORS preflight allowlist.

import { Data, Effect, Schedule } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform";
import { run_effect } from "../core/run-promise.ts";

export interface Presence {
  forge_online: boolean;
  clients: number;
}

export class PresenceFailure extends Data.TaggedError("PresenceFailure")<{
  readonly reason: string;
  readonly status?: number;
}> {}

const presence_program = (
  relay_http_url: string,
  account_id: string,
  machine_id: string,
  grant_jwt: string,
) =>
  Effect.gen(function* () {
    // No tracer propagation: extra `b3`/`traceparent` headers fail
    // Relay's CORS preflight allowlist (Authorization, Content-Type only).
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.withTracerPropagation(false),
      HttpClient.retryTransient({
        schedule: Schedule.exponential("200 millis").pipe(Schedule.intersect(Schedule.recurs(2))),
        times: 2,
      }),
    );
    const request = HttpClientRequest.setHeaders(
      HttpClientRequest.get(
        `${relay_http_url}/v1/presence/${encodeURIComponent(account_id)}/${encodeURIComponent(machine_id)}`,
      ),
      { authorization: `Bearer ${grant_jwt}`, accept: "application/json" },
    );
    const res = yield* Effect.mapError(
      client.execute(request),
      () => new PresenceFailure({ reason: "presence unreachable" }),
    );
    const json = (yield* Effect.mapError(
      res.json,
      () => new PresenceFailure({ reason: "presence unreadable", status: res.status }),
    )) as { forge_online?: unknown; clients?: unknown } | null;
    if (res.status < 200 || res.status >= 300) {
      return yield* Effect.fail(
        new PresenceFailure({ reason: `presence check failed (${res.status})`, status: res.status }),
      );
    }
    return { forge_online: json?.forge_online === true, clients: typeof json?.clients === "number" ? json.clients : 0 };
  });

/** Authenticated presence read (Bearer grant, same account+machine). */
export async function fetch_presence(
  relay_http_url: string,
  accountId: string,
  machineId: string,
  grant_jwt: string,
  fetch_impl: typeof fetch = fetch,
): Promise<Presence> {
  return run_effect(
    presence_program(relay_http_url, accountId, machineId, grant_jwt).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch_impl),
    ) as Effect.Effect<Presence, PresenceFailure>,
  ).catch((err) => {
    if (err instanceof PresenceFailure) throw new Error(err.reason);
    throw err instanceof Error ? err : new Error("Presence check failed.");
  });
}

export const fetch_presence_effect = (
  relay_http_url: string,
  account_id: string,
  machine_id: string,
  grant_jwt: string,
) => presence_program(relay_http_url, account_id, machine_id, grant_jwt);
