import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { layer as NodeLayer } from "@effect/platform-node/NodeServices";
import * as Redacted from "effect/Redacted";
import { pathToFileURL as path_to_file_url } from "node:url";
import * as Path from "node:path";
import { fileURLToPath as file_url_to_path } from "node:url";
// Deploy's exact module collector (bundle:false path). Imported via relative
// lib path to stay within the pinned package without relying on unpublished
// subpath exports. Cloud-free: needs only FileSystem + Path.
import { readPrebuiltWorkerBundle as read_prebuilt_worker_bundle } from "../node_modules/@alchemy.run/cloudflare/lib/Workers/Sources/Prebuilt.js";
import {
  AUTH_PROD_ORIGIN,
  DASHBOARD_PROD_ORIGIN,
  HYPERDRIVE_CACHING,
  MAIL_PROVIDER_VALUE,
  MAIL_SENDER_EMAIL,
  MAIL_SENDING_SUBDOMAIN,
  MAIL_ZONE_ID,
  MAIL_ZONE_NAME,
  STACK_NAME,
  assert_all_origins_distinct,
  assert_browser_origins_for_stage,
  assert_distinct_origins,
  assert_origin_for_stage,
  assert_valid_mail_from,
  bucket_name,
  hyperdrive_name,
  normalize_origin,
  parse_postgres_url,
  sender_email_from_mail_from,
  worker_name,
} from "../src/config.ts";
import { build_core_worker_props } from "../src/worker.ts";

const TEST_DIR = Path.dirname(file_url_to_path(import.meta.url));
const CORE_ROOT = Path.resolve(TEST_DIR, "../..");
const ENTRY_ABS = Path.join(CORE_ROOT, "dist/ast_core/index.js");
const SQL_ROOT = Path.join(CORE_ROOT, "src/db/queries");

const dummy_bucket = { __dummy: "bucket" } as never;
const dummy_hd = { __dummy: "hyperdrive" } as never;
const dummy_email = { kind: "Cloudflare.Email.SendEmail", name: "EMAIL" } as never;
const dummy_master_key = Redacted.make("test-master-key-not-a-secret");
const dummy_admin_token = Redacted.make("test-admin-token-not-a-secret");
const test_auth_origin = "https://auth.example.invalid";
const test_dashboard_origin = "https://dashboard.example.invalid";

describe("stack identity (stage isolation, no sibling imports)", () => {
  it("uses the Core stack name (Relay owns its own stack)", () => {
    expect(STACK_NAME).toBe("ast-core");
  });

  it("isolates stages by physical name", () => {
    expect(worker_name("prod")).not.toBe(worker_name("pr-42"));
    expect(bucket_name("prod")).not.toBe(bucket_name("pr-42"));
    expect(hyperdrive_name("prod")).not.toBe(hyperdrive_name("pr-42"));
    expect(worker_name("pr-42")).toContain("pr-42");
  });
});

describe("public origins (shared AST_CORE_ORIGIN / AST_RELAY_ORIGIN)", () => {
  it("normalizes case + trailing slash to canonical bare origin", () => {
    expect(normalize_origin("HTTPS://Core.ArtisanStreet.Dev/", "AST_CORE_ORIGIN")).toBe(
      "https://core.artisanstreet.dev",
    );
  });

  it("rejects wildcard origins", () => {
    expect(() => normalize_origin("https://*.example.com", "AST_CORE_ORIGIN")).toThrow();
    expect(() => normalize_origin("https://%2A.example.com", "AST_CORE_ORIGIN")).toThrow();
    expect(() => normalize_origin("https://%2a.example.com", "AST_CORE_ORIGIN")).toThrow();
    expect(() => normalize_origin("https://foo.*.example.com", "AST_CORE_ORIGIN")).toThrow();
  });

  it("rejects Core==Relay, including same hostname with different ports", () => {
    const core = normalize_origin("https://core.artisanstreet.dev", "AST_CORE_ORIGIN");
    const relay = normalize_origin("https://relay.artisanstreet.dev", "AST_RELAY_ORIGIN");
    expect(() => assert_distinct_origins(core, relay)).not.toThrow();
    expect(() => assert_distinct_origins(core, core)).toThrow();
    expect(() =>
      assert_distinct_origins("https://example.com", "https://example.com:8443"),
    ).toThrow();
    expect(() =>
      assert_distinct_origins("https://example.com", "https://EXAMPLE.com/"),
    ).toThrow();
  });

  it("requires exact https for every deployed stage (custom domains)", () => {
    const core = normalize_origin("https://core.artisanstreet.dev", "AST_CORE_ORIGIN");
    expect(() => assert_origin_for_stage(core, "AST_CORE_ORIGIN", "prod")).not.toThrow();
    expect(() => assert_origin_for_stage(core, "AST_CORE_ORIGIN", "pr-42")).not.toThrow();
    expect(() => assert_origin_for_stage("http://core.artisanstreet.dev", "AST_CORE_ORIGIN", "pr-42")).toThrow();
    expect(() => assert_origin_for_stage("http://core.artisanstreet.dev", "AST_CORE_ORIGIN", "prod")).toThrow();
  });

  it("browser origins are distinct hostnames across all four workers", () => {
    expect(() =>
      assert_all_origins_distinct(
        "https://api.example.dev",
        "https://relay.example.dev",
        "https://auth.example.dev",
        "https://dashboard.example.dev",
      ),
    ).not.toThrow();
    expect(() =>
      assert_all_origins_distinct(
        "https://api.example.dev",
        "https://relay.example.dev",
        "https://api.example.dev",
        "https://dashboard.example.dev",
      ),
    ).toThrow();
  });

  it("prod pins known browser origins; previews must not reuse prod", () => {
    expect(() => assert_browser_origins_for_stage(AUTH_PROD_ORIGIN, DASHBOARD_PROD_ORIGIN, "prod")).not.toThrow();
    expect(() =>
      assert_browser_origins_for_stage("https://auth-pr-42.example.dev", "https://dashboard-pr-42.example.dev", "pr-42"),
    ).not.toThrow();
    expect(() => assert_browser_origins_for_stage(AUTH_PROD_ORIGIN, DASHBOARD_PROD_ORIGIN, "pr-42")).toThrow();
    expect(() =>
      assert_browser_origins_for_stage("https://auth-pr-42.example.dev", DASHBOARD_PROD_ORIGIN, "pr-42"),
    ).toThrow();
  });
});

describe("Worker env binds canonical literals (not raw Config values)", () => {
  it("factory env equals normalized origins even for messy inputs", () => {
    const core_origin = normalize_origin("HTTPS://Core.ArtisanStreet.Dev/", "AST_CORE_ORIGIN");
    const relay_origin = normalize_origin("https://Relay.ArtisanStreet.Dev/", "AST_RELAY_ORIGIN");
    const auth_origin = normalize_origin("https://Auth.Example.Invalid/", "AST_AUTH_ORIGIN");
    const dashboard_origin = normalize_origin("https://Dashboard.Example.Invalid/", "AST_DASHBOARD_ORIGIN");
    const props = build_core_worker_props({
      stage: "pr-42",
      core_origin,
      relay_origin,
      auth_origin,
      dashboard_origin,
      mail_from: "auth@mail.artisan.st",
      mail_from_name: "Artisan Street",
      email: dummy_email,
      master_key: dummy_master_key,
      admin_token: dummy_admin_token,
      bucket: dummy_bucket,
      hyperdrive: dummy_hd,
    });
    expect(props.env.CORE_PUBLIC_BASE_URL).toBe("https://core.artisanstreet.dev");
    expect(props.env.CORE_JWT_ISSUER).toBe("https://core.artisanstreet.dev");
    expect(props.env.CORE_RELAY_ORIGIN).toBe("https://relay.artisanstreet.dev");
    expect(props.env.AUTH_PUBLIC_BASE_URL).toBe("https://auth.example.invalid");
    expect(props.env.DASHBOARD_PUBLIC_BASE_URL).toBe("https://dashboard.example.invalid");
    expect(props.env.MAIL_PROVIDER).toBe("cloudflare");
    expect(props.env.MAIL_FROM).toBe("auth@mail.artisan.st");
    expect(props.env.MAIL_FROM_NAME).toBe("Artisan Street");
    expect(props.env.EMAIL).toBe(dummy_email);
    expect("RESEND_API_KEY" in props.env).toBe(false);
    // Handles pass through (single declaration in composition root).
    expect(props.env.CONFIG_BUCKET).toBe(dummy_bucket);
    expect(props.env.HYPERDRIVE).toBe(dummy_hd);
    // Secrets stay Redacted (never plain strings).
    expect(typeof props.env.CORE_MASTER_KEY).not.toBe("string");
    expect(typeof props.env.CORE_ADMIN_TOKEN).not.toBe("string");
    expect(props.env.CORE_MASTER_KEY).toBe(dummy_master_key);
    expect(props.env.CORE_ADMIN_TOKEN).toBe(dummy_admin_token);
  });

  it("rejects empty MAIL_FROM (verified sender required, no default)", () => {
    const core_origin = normalize_origin("https://core.artisanstreet.dev", "AST_CORE_ORIGIN");
    const relay_origin = normalize_origin("https://relay.artisanstreet.dev", "AST_RELAY_ORIGIN");
    expect(() =>
      build_core_worker_props({
        stage: "pr-42",
        core_origin,
        relay_origin,
        auth_origin: test_auth_origin,
        dashboard_origin: test_dashboard_origin,
        mail_from: "   ",
        mail_from_name: "Artisan Street",
        email: dummy_email,
        master_key: dummy_master_key,
        admin_token: dummy_admin_token,
        bucket: dummy_bucket,
        hyperdrive: dummy_hd,
      }),
    ).toThrow(/MAIL_FROM/);
  });

  it("rejects a sender outside the onboarded sending domain", () => {
    const core_origin = normalize_origin("https://core.artisanstreet.dev", "AST_CORE_ORIGIN");
    const relay_origin = normalize_origin("https://relay.artisanstreet.dev", "AST_RELAY_ORIGIN");
    expect(() =>
      build_core_worker_props({
        stage: "pr-42",
        core_origin,
        relay_origin,
        auth_origin: test_auth_origin,
        dashboard_origin: test_dashboard_origin,
        mail_from: "ops@example.com",
        mail_from_name: "Ast",
        email: dummy_email,
        master_key: dummy_master_key,
        admin_token: dummy_admin_token,
        bucket: dummy_bucket,
        hyperdrive: dummy_hd,
      }),
    ).toThrow();
  });

  it("rejects a missing display name", () => {
    const core_origin = normalize_origin("https://core.artisanstreet.dev", "AST_CORE_ORIGIN");
    const relay_origin = normalize_origin("https://relay.artisanstreet.dev", "AST_RELAY_ORIGIN");
    expect(() =>
      build_core_worker_props({
        stage: "pr-42",
        core_origin,
        relay_origin,
        auth_origin: test_auth_origin,
        dashboard_origin: test_dashboard_origin,
        mail_from: "auth@mail.artisan.st",
        mail_from_name: "  ",
        email: dummy_email,
        master_key: dummy_master_key,
        admin_token: dummy_admin_token,
        bucket: dummy_bucket,
        hyperdrive: dummy_hd,
      }),
    ).toThrow(/MAIL_FROM_NAME/);
  });
});

describe("native email sending domain (no root MX changes)", () => {
  it("uses the dedicated sending subdomain on the active zone", () => {
    expect(MAIL_ZONE_NAME).toBe("artisan.st");
    expect(MAIL_ZONE_ID).toBe("6320d0c37a89c14abb9ae3d7b9d17339");
    expect(MAIL_SENDING_SUBDOMAIN).toBe("mail.artisan.st");
    expect(MAIL_SENDER_EMAIL).toBe("auth@mail.artisan.st");
    expect(MAIL_PROVIDER_VALUE).toBe("cloudflare");
  });

  it("accepts the bare verified sender address", () => {
    expect(sender_email_from_mail_from("auth@mail.artisan.st")).toBe(
      "auth@mail.artisan.st",
    );
    expect(assert_valid_mail_from("auth@mail.artisan.st")).toBe(
      "auth@mail.artisan.st",
    );
  });
});

describe("stage routes: exact custom domain on every stage, api-only", () => {
  for (const stage of ["prod", "pr-42"]) {
    it(`stage ${stage} attaches its own hostname, no workers.dev, no static assets`, () => {
      const core_origin = normalize_origin(
        stage === "prod" ? "https://core.artisanstreet.dev" : "https://core-pr-42.example.dev",
        "AST_CORE_ORIGIN",
      );
      const auth_origin =
        stage === "prod" ? AUTH_PROD_ORIGIN : "https://auth-pr-42.example.dev";
      const dashboard_origin =
        stage === "prod" ? DASHBOARD_PROD_ORIGIN : "https://dashboard-pr-42.example.dev";
      const props = build_core_worker_props({
        stage,
        core_origin,
        relay_origin: "https://relay.artisanstreet.dev",
        auth_origin,
        dashboard_origin,
        mail_from: "auth@mail.artisan.st",
        mail_from_name: "Artisan Street",
        email: dummy_email,
        master_key: dummy_master_key,
        admin_token: dummy_admin_token,
        bucket: dummy_bucket,
        hyperdrive: dummy_hd,
      });
      expect(props.domain).toBe(new URL(core_origin).hostname);
      expect(props.workersDev).toBe(false);
      expect(props.name).toBe(worker_name(stage));
      expect(props.bundle).toBe(false);
      expect("assets" in props).toBe(false);
    });
  }
});

describe("Hyperdrive (caching explicitly disabled, external origin)", () => {
  it("pins caching disabled (authority reads must never serve stale revocations)", () => {
    expect(HYPERDRIVE_CACHING.disabled).toBe(true);
  });

  it("parses an external Postgres URL with the password held Redacted", () => {
    const o = parse_postgres_url("postgres://app:secretpw@db.example.com:5432/appdb");
    expect(o.host).toBe("db.example.com");
    expect(o.port).toBe(5432);
    expect(Redacted.value(o.password)).toBe("secretpw");
    expect(typeof o.password).not.toBe("string");
  });

  it("never echoes secret material in errors", () => {
    try {
      parse_postgres_url("postgres://u:TOPSECRET@h:5432/d?sslmode=require");
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
  it("collects the exact deploy modules (entry first, single-file Vite+ output, no sourcemaps)", async () => {
    const out = await Effect.runPromise(
      read_prebuilt_worker_bundle({ main: ENTRY_ABS }).pipe(Effect.provide(NodeLayer)),
    );
    const names = out.files.map((f) => f.path);
    expect(names[0]).toBe("index.js");
    expect(names.some((n) => n.endsWith(".map"))).toBe(false);
    expect(out.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.files.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  it("prebuilt entry executes to a Worker with fetch + scheduled (import execution, not substring)", async () => {
    const mod = (await import(path_to_file_url(ENTRY_ABS).href)) as {
      default?: { fetch?: unknown; scheduled?: unknown };
    };
    expect(typeof mod.default?.fetch).toBe("function");
    expect(typeof mod.default?.scheduled).toBe("function");
  }, 30000);
});

describe("SQL artifacts exist (Reylo .sql transforms already compiled in)", () => {
  it("ships Reylo query files", async () => {
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(SQL_ROOT, { recursive: true });
    const sqlFiles = (entries as string[]).filter((e) => e.endsWith(".sql"));
    expect(sqlFiles.length).toBeGreaterThan(0);
  });
});
