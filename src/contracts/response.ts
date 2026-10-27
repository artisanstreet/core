import { Array as Arr, Schema } from "effect";
import {
  ArtifactFile,
  ArtifactFileResp,
  EditorManifest,
  EditorManifestResp,
  EngineArtifactEnvelope,
  EngineArtifactEnvelopeResp,
  SkillFile,
  SkillFileResp,
  SkillRef,
  SkillRefResp,
} from "./v1.ts";

// Canonical request camel -> response snake mappers (pure, total on
// validated request shapes). Stored reads decode authoritatively via
// Schema.Union (Resp first, then Req + convert); corrupt payloads fail
// typed, never default engine/mode/format.

export const to_artifact_file_resp = (f: ArtifactFile): ArtifactFileResp => ({
  path: f.path,
  mode: f.mode,
  sha256: f.sha256,
  content_base64: f.contentBase64 });

export const to_envelope_resp = (e: EngineArtifactEnvelope): EngineArtifactEnvelopeResp => ({
  format: e.format,
  engine: e.engine,
  kind: e.kind,
  exported_at: e.exportedAt,
  expires_at: e.expiresAt,
  files: Arr.map(e.files, to_artifact_file_resp),
  ...(e.note === undefined ? {} : { note: e.note }) });

export const to_skill_file_resp = (f: SkillFile): SkillFileResp => ({
  path: f.path,
  content_base64: f.contentBase64,
  sha256: f.sha256 });

export const to_skill_ref_resp = (s: typeof SkillRef.Type): typeof SkillRefResp.Type => ({
  name: s.name,
  source: s.source,
  ...(s.version === undefined ? {} : { version: s.version }),
  ...(s.bundle === undefined
    ? {}
    : { bundle: { files: Arr.map(s.bundle.files, to_skill_file_resp) } }) });

export const to_editor_manifest_resp = (m: EditorManifest): EditorManifestResp => ({
  format: m.format,
  mcp_servers: Arr.map(m.mcpServers, (s) => s),
  skills: Arr.map(m.skills, to_skill_ref_resp),
  ...(m.globalPrompt === undefined ? {} : { global_prompt: m.globalPrompt }) });

// Stored rows may be legacy camel (Req) or current snake (Resp). Decode
// authoritatively; callers convert Req -> Resp via the pure converters
// above, then hash the exact snake bytes served.
export const StoredManifest = Schema.Union(EditorManifestResp, EditorManifest);
export type StoredManifest = typeof StoredManifest.Type;

export const StoredEnvelope = Schema.Union(EngineArtifactEnvelopeResp, EngineArtifactEnvelope);
export type StoredEnvelope = typeof StoredEnvelope.Type;

export const is_manifest_resp = (v: StoredManifest): v is EditorManifestResp =>
  "mcp_servers" in (v as Record<string, unknown>);

export const is_envelope_resp = (v: StoredEnvelope): v is EngineArtifactEnvelopeResp =>
  "exported_at" in (v as Record<string, unknown>);
