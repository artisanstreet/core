import { Effect, Option } from "effect";
import { Schema } from "effect";
import * as HttpRouter from "@effect/platform/HttpRouter";
import { register_route } from "../../../http/register.ts";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import * as HttpServerResponse from "@effect/platform/HttpServerResponse";
import * as Headers from "@effect/platform/Headers";
import * as C from "../../../contracts/v1.ts";
import { R } from "../../../contracts/registry.ts";
import * as ConfigSvc from "../config.ts";
import { decode_request, if_none_match, parse_json_text, proof_for_machine, read_json_body, require_json_content_type, session_for_mutation, session_of } from "../../../http/request.ts";
import { encode_ok } from "../../../http/response.ts";
import { CoreError, internal } from "../../../errors.ts";

function has_machine_header(req: HttpServerRequest.HttpServerRequest): boolean {
  const v = Headers.get(req.headers, "x-ast-machine");
  return Option.isSome(v) && v.value.trim() !== "";
}

const bundle_publish_handler = Effect.gen(function* () {
  const me = yield* session_for_mutation;
  const { json } = yield* read_json_body;
  const input = yield* decode_request(C.BundlePublishReq, json);
  const b = yield* ConfigSvc.publish_bundle(me.account_id, input.manifest);
  return encode_ok(
    C.BundleInfo,
    { id: b.id, version: b.version, contentHash: b.contentHash, r2Key: b.r2Key, createdAt: b.createdAt },
    201,
  );
});
const bundle_latest_handler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  let account_id: string;
  if (has_machine_header(req)) {
    account_id = (yield* proof_for_machine).principal.account_id;
  } else {
    account_id = (yield* session_of).principal.account_id;
  }
  const latest = yield* ConfigSvc.latest_bundle(account_id);
  const manifest = latest.manifest == null
    ? null
    : yield* Schema.decodeUnknown(C.EditorManifest)(latest.manifest).pipe(
      Effect.mapError((cause) => internal("configuration unavailable", { cause })),
    );
  const body = { bundle: latest.bundle, manifest };
  if (latest.bundle) {
    const etag = `"${latest.bundle.contentHash}"`;
    const not_modified = yield* if_none_match(latest.bundle.contentHash);
    if (not_modified) {
      return HttpServerResponse.empty({ status: 304 }).pipe(
        HttpServerResponse.setHeader("ETag", etag),
        HttpServerResponse.setHeader("Cache-Control", "private, max-age=0, must-revalidate"),
      );
    }
    const ok = encode_ok(C.BundleLatestResp, body);
    return ok.pipe(
      HttpServerResponse.setHeader("ETag", etag),
      HttpServerResponse.setHeader("Cache-Control", "private, max-age=0, must-revalidate"),
    );
  }
  const ok = encode_ok(C.BundleLatestResp, body);
  return ok.pipe(HttpServerResponse.setHeader("Cache-Control", "private, max-age=0, must-revalidate"));
});
const bundle_manifest_handler = Effect.gen(function* () {
  const { principal } = yield* proof_for_machine;
  const params = yield* HttpRouter.RouteContext.pipe(Effect.map((c) => c.params));
  const version = Number(params["version"] ?? "");
  if (!Number.isInteger(version) || version <= 0) {
    return yield* Effect.fail(new CoreError("bad_request", "bad version"));
  }
  const { bytes, contentHash } = yield* ConfigSvc.bundle_manifest_bytes(principal.account_id, version);
  const etag = `"${contentHash}"`;
  const not_modified = yield* if_none_match(contentHash);
  if (not_modified) {
    return HttpServerResponse.empty({ status: 304 }).pipe(
      HttpServerResponse.setHeader("ETag", etag),
      HttpServerResponse.setHeader("Cache-Control", "private, max-age=31536000, immutable"),
    );
  }
  return HttpServerResponse.uint8Array(bytes, { status: 200, contentType: "application/json" }).pipe(
    HttpServerResponse.setHeader("ETag", etag),
    HttpServerResponse.setHeader("X-Content-Sha256", contentHash),
    HttpServerResponse.setHeader("Cache-Control", "private, max-age=31536000, immutable"),
  );
});
const config_read_handler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const { principal: me } = yield* session_of;
  const url = new URL(req.originalUrl);
  const machine_id = url.searchParams.get("machineId") ?? "";
  if (!/^mch_[0-9A-HJKMNP-TV-Z]{26}$/.test(machine_id)) {
    return yield* Effect.fail(new CoreError("bad_request", "machineId is required"));
  }
  const data = yield* ConfigSvc.read_machine_state(me.account_id, machine_id);
  return encode_ok(C.ConfigStateResp, data);
});
const config_report_handler = Effect.gen(function* () {
  const { principal, raw_body } = yield* proof_for_machine;
  yield* require_json_content_type;
  const parsed = yield* parse_json_text(raw_body);
  const input = yield* decode_request(C.ConfigStateReq, parsed);
  const data = yield* ConfigSvc.report_machine_state(principal.machine_id, principal.account_id, {
    bundle_id: input.bundleId,
    status: input.status,
    detail: input.detail ?? "" });
  return encode_ok(C.ConfigStateResp, data);
});

export const router = HttpRouter.empty.pipe(
  register_route(
    R.bundle_publish,
      bundle_publish_handler,
  ),
  register_route(
    R.bundle_latest,
      bundle_latest_handler,
  ),
  register_route(
    R.bundle_manifest,
      bundle_manifest_handler,
  ),
  register_route(
    R.config_read,
      config_read_handler,
  ),
  register_route(
    R.config_report,
      config_report_handler,
  ),
);
