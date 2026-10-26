import { ROUTES, type RouteDef } from "./registry.js";
import { ErrorBody, jsonSchemaFor } from "./v1.js";

const STATUS_BY_AUTH: Record<RouteDef["auth"], string[]> = {
  none: ["400", "429"],
  session: ["400", "401", "403", "429"],
  machine: ["400", "401", "403"],
  either: ["400", "401", "403"],
  admin: ["400", "404"],
};

function openapiPath(honoPath: string): string {
  return honoPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

// Routes with checksum-based invalidation: authenticated conditional GET
// via If-None-Match against the content-hash ETag; see docs/contracts.md.
const CONDITIONAL_GET = new Set(["/v1/config/bundles/latest", "/v1/config/bundles/{version}/manifest"]);

// Generated from the runtime route registry (same Effect Schemas the HTTP
// boundary decodes/encodes). The committed contracts/v1.openapi.json must
// equal this output; tests enforce it.
export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const p = openapiPath(r.path);
    const method = r.method.toLowerCase();
    const op: Record<string, unknown> = {
      summary: r.summary,
      tags: r.tags,
      responses: {
        "200": {
          description: r.method === "GET" && CONDITIONAL_GET.has(p) ? "ok (or revalidated body); validators in ETag" : "ok",
          headers: CONDITIONAL_GET.has(p) && r.method === "GET"
            ? {
              ETag: { description: "Strong validator: quoted content SHA-256 hex. Persist and send back in If-None-Match.", schema: { type: "string" } },
              "Cache-Control": { description: "private cache semantics; manifests are immutable, latest must revalidate", schema: { type: "string" } },
            }
            : undefined,
          content: { "application/json": { schema: jsonSchemaFor(r.responseSchema as never) } },
        },
      },
    };
    if (r.requestSchema) {
      (op as Record<string, unknown>).requestBody = {
        required: true,
        content: { "application/json": { schema: jsonSchemaFor(r.requestSchema as never) } },
      };
    }
    if (r.method === "GET" && CONDITIONAL_GET.has(p)) {
      (op as Record<string, unknown>).parameters = [
        {
          name: "If-None-Match",
          in: "header",
          required: false,
          description: "Previously seen content-hash ETag (quoted) or *; evaluated only after authentication. Match → 304 with empty body.",
          schema: { type: "string" },
        },
      ];
      (op.responses as Record<string, unknown>)["304"] = {
        description: "not modified: the persisted hash/revision is current; empty body",
        headers: {
          ETag: { description: "Current strong validator", schema: { type: "string" } },
        },
      };
    }
    for (const code of STATUS_BY_AUTH[r.auth]) {
      (op.responses as Record<string, unknown>)[code] = {
        description: code,
        content: { "application/json": { schema: jsonSchemaFor(ErrorBody as never) } },
      };
    }
    (paths[p] ??= {})[method] = op;
  }
  return {
    openapi: "3.1.0",
    info: { title: "AST Core", version: "1.0.0", description: "AST account authority: identity, machines, grants, vault, config. Generated from runtime Effect Schemas; do not hand-edit." },
    paths,
  };
}
