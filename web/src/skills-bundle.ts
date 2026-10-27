// Bundled skill references for the config manifest.
//
// Uses Core's published schema directly (core/src/contracts/v1.ts:
// `SkillFile { path, contentBase64: base64url, sha256: hex }`,
// `SkillRef.bundle?: { files: 1..64 }`). Bytes live inside the
// content-hashed R2 manifest; Rust stages/installs them; no new service
// endpoint. This module only builds that shape from a picked folder with
// guardrails: SKILL.md required at the root, secret-looking and tool
// folders refused by name (listed, never silent), caps keep the manifest
// safely under Core's 1 MiB JSON body ceiling (64 files, 256 KiB each,
// 512 KiB total raw).

import { Schema } from "effect";
import * as C from "../../src/contracts/v1.ts";

export const MAX_BUNDLE_FILES = 64;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;

const SECRET_NAME = /(\.env(\.|$)|secret|credential|token|passwd|\.pem$|\.key$|\.p12$|\.pfx$|id_rsa)/i;
const BLOCKED_SEGMENT = /^(node_modules|\.git|\.hg|\.svn|dist|build|target)$/;

export interface SkillFolderPick {
  /** Directory name the picker reported (default skill name). */
  folderName: string;
  files: File[];
}

export interface BuiltSkillRef {
  name: string;
  source: string;
  bundle: { files: Array<{ path: string; contentBase64: string; sha256: string }> };
  /** Files left out, with reasons — shown, never silent. */
  skipped: string[];
}

function base64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build a bundled skill ref from picked files. Throws a human-readable
 * error naming every refused file — nothing secret is ever included.
 * The result validates strictly against Core's SkillRef (unknown fields
 * rejected, sha256 hex + base64url charset enforced).
 */
export async function buildSkillBundle(pick: SkillFolderPick, opts?: { name?: string; source?: string }): Promise<BuiltSkillRef> {
  const rel = (f: File): string => {
    const p = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const parts = p.split("/");
    // Drop the top folder segment when the picker reports one.
    return (parts.length > 1 ? parts.slice(1) : parts).join("/");
  };
  const entries = pick.files.map((file) => ({ file, path: rel(file) })).filter((e) => e.path.length > 0);
  if (!entries.some((e) => e.path === "SKILL.md")) {
    throw new Error(`“${pick.folderName}” has no SKILL.md at its root — pick a skill folder, not its parent.`);
  }
  const refused: string[] = [];
  const kept = entries.filter((e) => {
    const segs = e.path.split("/");
    if (segs.some((s) => BLOCKED_SEGMENT.test(s) || s === ".." || s === "")) {
      refused.push(`${e.path} (blocked folder)`);
      return false;
    }
    if (SECRET_NAME.test(e.path)) {
      refused.push(`${e.path} (looks like a secret)`);
      return false;
    }
    if (e.file.size > MAX_FILE_BYTES) {
      refused.push(`${e.path} (over 256 KiB)`);
      return false;
    }
    return true;
  });
  if (kept.length === 0) throw new Error("Nothing uploadable left after filtering. " + refused.join("; "));
  if (kept.length > MAX_BUNDLE_FILES) throw new Error(`Too many files (${kept.length}); bundled skills cap at ${MAX_BUNDLE_FILES}.`);
  const total = kept.reduce((n, e) => n + e.file.size, 0);
  if (total > MAX_TOTAL_BYTES) throw new Error(`Skill folder is ${(total / 1024).toFixed(0)} KiB; bundled skills cap at 512 KiB raw.`);
  const files: Array<{ path: string; contentBase64: string; sha256: string }> = [];
  for (const e of kept) {
    const bytes = new Uint8Array(await e.file.arrayBuffer());
    files.push({ path: e.path, contentBase64: base64urlEncode(bytes), sha256: await sha256Hex(bytes) });
  }
  if (!files.some((f) => f.path === "SKILL.md")) {
    throw new Error("SKILL.md was filtered out; refusing to build a bundle without it. " + refused.join("; "));
  }
  // Strict-validate every file against Core's published SkillFile.
  for (const f of files) {
    Schema.decodeUnknownSync(C.SkillFile, { onExcessProperty: "error" })(f);
  }
  const name = (opts?.name ?? "").trim() || pick.folderName;
  return { name, source: (opts?.source ?? "").trim() || "bundle", bundle: { files }, skipped: refused };
}
