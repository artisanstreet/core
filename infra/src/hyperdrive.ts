import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HYPERDRIVE_CACHING, hyperdrive_name, parse_postgres_url } from "./config.ts";
import { config as deploy_config } from "./env.generated.ts";

// Hyperdrive config in front of the existing external Postgres origin.
// The origin database is NOT provisioned here (no hosting choice, no Neon/
// PlanetScale/Prisma resource): the operator supplies the direct Postgres
// URL via secret AST_CORE_DATABASE_URL, and Hyperdrive pools it at the edge.
//
// Caching is EXPLICITLY DISABLED (see HYPERDRIVE_CACHING): Core reads are
// authority reads (sessions, keys, vault, revocations) and Hyperdrive does
// not invalidate cached rows on writes.
export const CoreHyperdrive = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const deploy_env = yield* deploy_config;
  const db_url = Redacted.value(deploy_env.AST_CORE_DATABASE_URL);
  // Parse without ever logging the URL or password. Errors are generic.
  const origin = parse_postgres_url(db_url);
  return yield* Cloudflare.Hyperdrive.Connection("CoreHyperdrive", {
    name: hyperdrive_name(stage),
    origin: {
      scheme: origin.scheme,
      host: origin.host,
      ...(origin.port !== undefined ? { port: origin.port } : {}),
      database: origin.database,
      user: origin.user,
      password: origin.password },
    caching: { ...HYPERDRIVE_CACHING } });
});
