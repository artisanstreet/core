import { Effect } from "effect";
import { make_service_layers, type RequestContext } from "./http/context.ts";
import { http_effect } from "./http/app.ts";

export type { RequestContext };
export type { ServiceEnv } from "./http/context.ts";

export function create_app(ctx: RequestContext) {
  const run_fetch = async (request: Request): Promise<Response> => {
    return Effect.runPromise(Effect.scoped(http_effect(request, make_service_layers(ctx))));
  };
  const run_request = async (
    path: string,
    opts: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {},
  ): Promise<Response> => {
    const url = path.startsWith("http") ? path : `http://localhost${path.startsWith("/") ? path : `/${path}`}`;
    const headers = new Headers(opts.headers ?? {});
    const req = new Request(url, { method: opts.method ?? "GET", headers, body: opts.body as BodyInit | undefined });
    return run_fetch(req);
  };
  return { fetch: run_fetch, request: run_request };
}
