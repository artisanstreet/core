import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { layer as NodeLayer } from "@effect/platform-node/NodeServices";
import * as Redacted from "effect/Redacted";
import { pathToFileURL } from "node:url";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
// Deploy's exact module collector (bundle:false path). Imported via relative
// lib path to stay within the pinned package without relying on unpublished
// subpath exports. Cloud-free: needs only FileSystem + Path.
import { readPrebuiltWorkerBundle } from "../node_modules/@alchemy.run/cloudflare/lib/Workers/Sources/Prebuilt.js";
import {
  HYPERDRIVE_CACHING,
  STACK_NAME,
  assertDistinctOrigins,
  assertOriginForStage,
  bucketName,
  hyperdriveName,
  normalizeOrigin,
  parsePostgresUrl,
  workerName,
} from "../src/config.ts";
import { buildCoreWorkerProps } from "../src/worker.ts";

const TEST_DIR = Path.dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = Path.resolve(TEST_DIR, "../..");
const ENTRY_ABS = Path.join(CORE_ROOT, "dist/ast_core/index.js");
const WEB_INDEX = Path.join(CORE_ROOT, "web/dist/index.html");
const SQL_ROOT = Path.join(CORE_ROOT, "src/db/queries");

const dummyBucket = { __dummy: "bucket" } as never;
const dummyHd = { __dummy: "hyperdrive" } as never;

describe("stack identity (stage isolation, no sibling imports)", () => {
  it("uses the Core stack name (Relay owns its own stack)", () => {
    expect(STACK_NAME).toBe("ast-core");
  });

  it("isolates stages by physical name", () => {
    expect(workerName("prod")).not.toBe(workerName("pr-42"));
    expect(bucketName("prod")).not.toBe(bucketName("pr-42"));
    expect(hyperdriveName("prod")).not.toBe(hyperdriveName("pr-42"));
    expect(workerName("pr-42")).toContain("pr-42");
  });
});

describe("public origins (shared AST_CORE_ORIGIN / AST_RELAY_ORIGIN)", () => {
  it("normalizes case + trailing slash to canonical bare origin", () => {
    expect(normalizeOrigin("HTTPS://Core.ArtisanStreet.Dev/", "AST_CORE_ORIGIN")).toBe(
      "https://core.artisanstreet.dev",
    );
  });

  it("rejects wildcard origins", () => {
    expect(() => normalizeOrigin("https://*.example.com", "AST_CORE_ORIGIN")).toThrow();
  });

  it("rejects Core==Relay, including same hostname with different ports", () => {
    const core = normalizeOrigin("https://core.artisanstreet.dev", "AST_CORE_ORIGIN");
    const relay = normalizeOrigin("https://relay.artisanstreet.dev", "AST_RELAY_ORIGIN");
    expect(() => assertDistinctOrigins(core, relay)).not.toThrow();
    expect(() => assertDistinctOrigins(core, core)).toThrow();
    expect(() =>
      assertDistinctOrigins("https://example.com", "https://example.com:8443"),
    ).toThrow();
    expect(() =>
      assertDistinctOrigins("https://example.com", "https://EXAMPLE.com/"),
    ).toThrow();
  });

  it("requires exact https for every deployed stage (custom domains)", () => {
    const core = normalizeOrigin("https://core.artisanstreet.dev", "AST_CORE_ORIGIN");
    expect(() => assertOriginForStage(core, "AST_CORE_ORIGIN", "prod")).not.toThrow();
    expect(() => assertOriginForStage(core, "AST_CORE_ORIGIN", "pr-42")).not.toThrow();
    expect(() => assertOriginForStage("http://core.artisanstreet.dev", "AST_CORE_ORIGIN", "pr-42")).toThrow();
    expect(() => assertOriginForStage("http://core.artisanstreet.dev", "AST_CORE_ORIGIN", "prod")).toThrow();
  });
});

describe("Worker env binds canonical literals (not raw Config values)", () => {
  it("factory env equals normalized origins even for messy inputs", () => {
    const coreOrigin = normalizeOrigin("HTTPS://Core.ArtisanStreet.Dev/", "AST_CORE_ORIGIN");
    const relayOrigin = normalizeOrigin("https://Relay.ArtisanStreet.Dev/", "AST_RELAY_ORIGIN");
    const props = buildCoreWorkerProps({
      stage: "pr-42",
      coreOrigin,
      relayOrigin,
      mailFrom: "Ast <ops@example.com>",
      bucket: dummyBucket,
      hyperdrive: dummyHd,
    });
    expect(props.env.CORE_PUBLIC_BASE_URL).toBe("https://core.artisanstreet.dev");
    expect(props.env.CORE_JWT_ISSUER).toBe("https://core.artisanstreet.dev");
    expect(props.env.CORE_RELAY_ORIGIN).toBe("https://relay.artisanstreet.dev");
    // Handles pass through (single declaration in composition root).
    expect(props.env.CONFIG_BUCKET).toBe(dummyBucket);
    expect(props.env.HYPERDRIVE).toBe(dummyHd);
    // Secrets stay Config (never plain strings).
    expect(typeof props.env.CORE_MASTER_KEY).not.toBe("string");
    expect(typeof props.env.CORE_ADMIN_TOKEN).not.toBe("string");
    expect(typeof props.env.RESEND_API_KEY).not.toBe("string");
  });

  it("rejects empty MAIL_FROM (verified sender required, no default)", () => {
    const coreOrigin = normalizeOrigin("https://core.artisanstreet.dev", "AST_CORE_ORIGIN");
    const relayOrigin = normalizeOrigin("https://relay.artisanstreet.dev", "AST_RELAY_ORIGIN");
    expect(() =>
      buildCoreWorkerProps({
        stage: "pr-42",
        coreOrigin,
        relayOrigin,
        mailFrom: "   ",
        bucket: dummyBucket,
        hyperdrive: dummyHd,
      }),
    ).toThrow(/MAIL_FROM/);
  });
});

describe("stage routes: exact custom domain on every stage, worker-first", () => {
  for (const stage of ["prod", "pr-42"]) {
    it(`stage ${stage} attaches its own hostname, no workers.dev`, () => {
      const coreOrigin = normalizeOrigin(
        stage === "prod" ? "https://core.artisanstreet.dev" : "https://core-pr-42.example.dev",
        "AST_CORE_ORIGIN",
      );
      const props = buildCoreWorkerProps({
        stage,
        coreOrigin,
        relayOrigin: "https://relay.artisanstreet.dev",
        mailFrom: "Ast <ops@example.com>",
        bucket: dummyBucket,
        hyperdrive: dummyHd,
      });
      expect(props.domain).toBe(new URL(coreOrigin).hostname);
      expect(props.workersDev).toBe(false);
      expect(props.name).toBe(workerName(stage));
      expect(props.bundle).toBe(false);
      expect(props.assets.runWorkerFirst).toBe(true);
      expect(props.assets.notFoundHandling).toBe("none");
    });
  }
});

describe("Hyperdrive (caching explicitly disabled, external origin)", () => {
  it("pins caching disabled (authority reads must never serve stale revocations)", () => {
    expect(HYPERDRIVE_CACHING.disabled).toBe(true);
  });

  it("parses an external Postgres URL with the password held Redacted", () => {
    const o = parsePostgresUrl("postgres://app:secretpw@db.example.com:5432/appdb");
    expect(o.host).toBe("db.example.com");
    expect(o.port).toBe(5432);
    expect(Redacted.value(o.password)).toBe("secretpw");
    expect(typeof o.password).not.toBe("string");
  });

  it("never echoes secret material in errors", () => {
    try {
      parsePostgresUrl("postgres://u:TOPSECRET@h:5432/d?sslmode=require");
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("TOPSECRET");
    }
  });
});

describe("composition root wires single declarations (offline graph check)", () => {
  it("stack module loads and exposes a Stack effect (no cloud calls)", async () => {
    const mod = (await import("../alchemy.run.ts")) as { default?: unknown };
    expect(mod.default).toBeDefined();
  });
});

describe("prebuilt bundle seam (deploy exact collector, cloud-free)", () => {
  it("collects the exact deploy modules (entry first, chunks, no sourcemaps)", async () => {
    const out = await Effect.runPromise(
      readPrebuiltWorkerBundle({ main: ENTRY_ABS }).pipe(Effect.provide(NodeLayer)),
    );
    const names = out.files.map((f) => f.path);
    expect(names[0]).toBe("index.js");
    expect(names.some((n) => n.startsWith("assets/"))).toBe(true);
    expect(names.some((n) => n.endsWith(".map"))).toBe(false);
    expect(out.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.files.length).toBeGreaterThanOrEqual(2);
  }, 30000);

  it("prebuilt entry executes to a Worker with fetch + scheduled (import execution, not substring)", async () => {
    const mod = (await import(pathToFileURL(ENTRY_ABS).href)) as {
      default?: { fetch?: unknown; scheduled?: unknown };
    };
    expect(typeof mod.default?.fetch).toBe("function");
    expect(typeof mod.default?.scheduled).toBe("function");
  }, 30000);
});

describe("portal + SQL artifacts exist (Reylo .sql transforms already compiled in)", () => {
  it("ships web/dist shell and Reylo query files", async () => {
    const fs = await import("node:fs/promises");
    const index = await fs.readFile(WEB_INDEX, "utf8");
    expect(index).toContain('<div id="app"');
    const entries = await fs.readdir(SQL_ROOT, { recursive: true });
    const sqlFiles = (entries as string[]).filter((e) => e.endsWith(".sql"));
    expect(sqlFiles.length).toBeGreaterThan(0);
  });
});
