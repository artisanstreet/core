import * as HttpRouter from "@effect/platform/HttpRouter";
import type { RouteDef } from "../contracts/registry.ts";

// Thin same-source registration: HTTP method + path both derive from the
// SAME registry metadata objects the OpenAPI document generates from, so
// the runtime cannot drift from the published contract. Schemas stay
// canonical in contracts/v1.ts; route grouping stays explicit per domain.
// The return type is inferred from the platform combinators themselves.
export function register_route<E1, R1>(route: RouteDef, handler: HttpRouter.Route.Handler<E1, R1>) {
  return <E, R>(self: HttpRouter.HttpRouter<E, R>) =>
    route.method === "GET"
      ? HttpRouter.get(self, route.path, handler)
      : HttpRouter.post(self, route.path, handler);
}
