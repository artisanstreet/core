import type { Hono } from "hono";
import { CoreError } from "../../errors.js";
import * as C from "../../contracts/v1.js";
import * as Vault from "../../services/vault.js";
import * as ConfigSvc from "./config.js";
import { validateEnvelope } from "./artifacts.js";
import { validateProviderKey } from "./providers.js";
import { R, type AnySchema } from "../../contracts/registry.js";
import type { H, RouteScope } from "../../http.js";

// Editor product routes, composed into the central router by http.ts.
// Products depend on shared services, never the reverse.

// -- vault ---------------------------------------------------------------------
export function registerEditorRoutes(app: Hono<{ Variables: { requestId: string } }>, s: RouteScope) {
  const H = (c: unknown) => c as H;

  app.post("/v1/vault/connections", async (c) => {
    const h = H(c);
    try {
      const me = await s.sessionForMutation(h);
      const input = C.decodeRequest(C.ProviderCreateReq, await s.readBody(h));
      const checked = await s.run(validateProviderKey(input.provider, input.apiKey));
      const created = await s.run(
        Vault.createProviderConnection({ accountId: me.accountId, provider: checked.provider, label: input.label ?? "", apiKey: checked.apiKey }),
      );
      return s.ok(
        h,
        C.ProviderInfo as unknown as AnySchema,
        { id: created.id, provider: created.provider, label: created.label, createdAt: created.createdAt, revokedAt: null, assignedMachineIds: [] },
        201,
      );
    } catch (e) {
      return s.fail(h, e);
    }
  });
  app.get("/v1/vault/connections", async (c) => {
    const h = H(c);
    try {
      if ((h.req.header("x-ast-machine") ?? "").trim()) {
        const { principal } = await s.proofForMachine(h);
        return s.ok(h, C.ProviderListResp as unknown as AnySchema, await s.run(Vault.listAssignedProviderConnections(principal.accountId, principal.machineId)));
      }
      const { principal: me } = await s.sessionOf(h);
      return s.ok(h, C.ProviderListResp as unknown as AnySchema, await s.run(Vault.listProviderConnections(me.accountId)));
    } catch (e) {
      return s.fail(h, e);
    }
  });
  app.post("/v1/vault/connections/:id/revoke", async (c) => {
    const h = H(c);
    try {
      const me = await s.sessionForMutation(h);
      return s.ok(h, R.providerRevoke.responseSchema, await s.run(Vault.revokeProviderConnectionById(me.accountId, h.req.param("id"))));
    } catch (e) {
      return s.fail(h, e);
    }
  });
  app.post("/v1/vault/assignments", async (c) => {
    const h = H(c);
    try {
      const me = await s.sessionForMutation(h);
      const input = C.decodeRequest(C.AssignReq, await s.readBody(h));
      return s.ok(h, C.AssignResp as unknown as AnySchema, await s.run(Vault.assignConnection(me.accountId, input.connectionId, input.machineId)));
    } catch (e) {
      return s.fail(h, e);
    }
  });
  app.post("/v1/vault/assignments/remove", async (c) => {
    const h = H(c);
    try {
      const me = await s.sessionForMutation(h);
      const input = C.decodeRequest(C.AssignReq, await s.readBody(h));
      return s.ok(h, R.providerUnassign.responseSchema, await s.run(Vault.unassignConnection(me.accountId, input.connectionId, input.machineId)));
    } catch (e) {
      return s.fail(h, e);
    }
  });
  app.get("/v1/vault/credentials", async (c) => {
    const h = H(c);
    try {
      const { principal } = await s.proofForMachine(h);
      const connectionId = h.req.query("connectionId") ?? "";
      if (!/^conn_[0-9A-HJKMNP-TV-Z]{26}$/.test(connectionId)) throw new CoreError("bad_request", "connectionId is required");
      const rel = await s.run(Vault.releaseCredential(principal.accountId, principal.machineId, connectionId));
      return s.ok(h, C.CredentialResp as unknown as AnySchema, rel);
    } catch (e) {
      return s.fail(h, e);
    }
  });

  // -- engine artifacts ---------------------------------------------------------------
  app.post("/v1/engine-artifacts", async (c) => {
    const h = H(c);
    try {
      const me = await s.sessionForMutation(h);
      const input = C.decodeRequest(C.ArtifactCreateReq, await s.readBody(h));
      const env = await s.run(validateEnvelope(input.envelope));
      return s.ok(h, R.artifactCreate.responseSchema, await s.run(Vault.storeArtifact({ accountId: me.accountId, label: input.label ?? "", envelope: env })), 201);
    } catch (e) {
      return s.fail(h, e);
    }
  });
  app.get("/v1/engine-artifacts", async (c) => {
    const h = H(c);
    try {
      if ((h.req.header("x-ast-machine") ?? "").trim()) {
        const { principal } = await s.proofForMachine(h);
        return s.ok(h, C.ArtifactListResp as unknown as AnySchema, await s.run(Vault.listAssignedArtifacts(principal.accountId, principal.machineId)));
      }
      const { principal: me } = await s.sessionOf(h);
      return s.ok(h, C.ArtifactListResp as unknown as AnySchema, await s.run(Vault.listArtifacts(me.accountId)));
    } catch (e) {
      return s.fail(h, e);
    }
  });
  app.post("/v1/engine-artifacts/:id/revoke", async (c) => {
    const h = H(c);
    try {
      const me = await s.sessionForMutation(h);
      return s.ok(h, R.artifactRevoke.responseSchema, await s.run(Vault.revokeArtifact(me.accountId, h.req.param("id"))));
    } catch (e) {
      return s.fail(h, e);
    }
  });
  app.post("/v1/engine-artifacts/assignments", async (c) => {
    const h = H(c);
    try {
      const me = await s.sessionForMutation(h);
      const input = C.decodeRequest(C.ArtifactAssignReq, await s.readBody(h));
      const a = await s.run(Vault.assignArtifact(me.accountId, input.artifactId, input.machineId));
      return s.ok(h, R.artifactAssign.responseSchema, { artifactId: a.artifactId, machineId: a.machineId });
    } catch (e) {
      return s.fail(h, e);
    }
  });
  app.post("/v1/engine-artifacts/assignments/remove", async (c) => {
    const h = H(c);
    try {
      const me = await s.sessionForMutation(h);
      const input = C.decodeRequest(C.ArtifactAssignReq, await s.readBody(h));
      return s.ok(h, R.artifactUnassign.responseSchema, await s.run(Vault.unassignArtifact(me.accountId, input.artifactId, input.machineId)));
    } catch (e) {
      return s.fail(h, e);
    }
  });
  app.get("/v1/engine-artifacts/:id/download", async (c) => {
    const h = H(c);
    try {
      const { principal } = await s.proofForMachine(h);
      return s.ok(h, C.ArtifactDownloadResp as unknown as AnySchema, await s.run(Vault.downloadArtifact(principal.accountId, principal.machineId, h.req.param("id"))));
    } catch (e) {
      return s.fail(h, e);
    }
  });

  // -- editor config ---------------------------------------------------------------------
  app.post("/v1/config/bundles", async (c) => {
    const h = H(c);
    try {
      const me = await s.sessionForMutation(h);
      const input = C.decodeRequest(C.BundlePublishReq, await s.readBody(h));
      const b = await s.run(ConfigSvc.publishBundle(me.accountId, input.manifest));
      return s.ok(h, C.BundleInfo as unknown as AnySchema, { id: b.id, version: b.version, contentHash: b.contentHash, r2Key: b.r2Key, createdAt: b.createdAt }, 201);
    } catch (e) {
      return s.fail(h, e);
    }
  });
  app.get("/v1/config/bundles/latest", async (c) => {
    const h = H(c);
    try {
      let accountId: string;
      if ((h.req.header("x-ast-machine") ?? "").trim()) {
        accountId = (await s.proofForMachine(h)).principal.accountId;
      } else {
        accountId = (await s.sessionOf(h)).principal.accountId;
      }
      const latest = await s.run(ConfigSvc.latestBundle(accountId));
      // Checksum-based invalidation: the content hash is a strong ETag, so
      // Forge/Editor persist it and revalidate instead of re-downloading.
      // Private configs are never shared through public caches.
      if (latest.bundle) {
        const etag = `"${latest.bundle.contentHash}"`;
        h.header("ETag", etag);
        h.header("Cache-Control", "private, max-age=0, must-revalidate");
        if (s.ifNoneMatch(h, latest.bundle.contentHash)) {
          return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, max-age=0, must-revalidate" } });
        }
      } else {
        h.header("Cache-Control", "private, max-age=0, must-revalidate");
      }
      return s.ok(h, C.BundleLatestResp as unknown as AnySchema, latest);
    } catch (e) {
      return s.fail(h, e);
    }
  });
  app.get("/v1/config/bundles/:version/manifest", async (c) => {
    const h = H(c);
    try {
      const { principal } = await s.proofForMachine(h);
      const version = Number(h.req.param("version"));
      if (!Number.isInteger(version) || version <= 0) throw new CoreError("bad_request", "bad version");
      const { bytes, contentHash } = await s.run(ConfigSvc.bundleManifestBytes(principal.accountId, version));
      // Immutable content-addressed blob: safe to cache privately for a year.
      const etag = `"${contentHash}"`;
      if (s.ifNoneMatch(h, contentHash)) {
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, "Cache-Control": "private, max-age=31536000, immutable" },
        });
      }
      return new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: etag, "X-Content-Sha256": contentHash, "Cache-Control": "private, max-age=31536000, immutable" },
      });
    } catch (e) {
      return s.fail(h, e);
    }
  });
  app.post("/v1/config/state", async (c) => {
    const h = H(c);
    try {
      const { principal, rawBody } = await s.proofForMachine(h);
      const input = C.decodeRequest(C.ConfigStateReq, rawBody ? (JSON.parse(rawBody) as unknown) : {});
      return s.ok(
        h,
        C.ConfigStateResp as unknown as AnySchema,
        await s.run(ConfigSvc.reportMachineState(principal.machineId, principal.accountId, { bundleId: input.bundleId, status: input.status, detail: input.detail ?? "" })),
      );
    } catch (e) {
      return s.fail(h, e);
    }
  });
  app.get("/v1/config/state", async (c) => {
    const h = H(c);
    try {
      const { principal: me } = await s.sessionOf(h);
      const machineId = h.req.query("machineId") ?? "";
      if (!/^mch_[0-9A-HJKMNP-TV-Z]{26}$/.test(machineId)) throw new CoreError("bad_request", "machineId is required");
      return s.ok(h, C.ConfigStateResp as unknown as AnySchema, await s.run(ConfigSvc.readMachineState(me.accountId, machineId)));
    } catch (e) {
      return s.fail(h, e);
    }
  });
}
