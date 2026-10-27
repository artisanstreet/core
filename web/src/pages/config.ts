// Editor configuration (#/config): versioned MCP/skill bundles + per-machine
// applied state. The manifest is validated client-side against the Core
// contract before publishing; the server re-validates strictly.

import type { CoreApi } from "../api.ts";
import { decodeStrict } from "../api.ts";
import * as C from "../../../src/contracts/v1.ts";
import { buildSkillBundle } from "../skills-bundle.ts";
import { clear, el, when } from "../ui.ts";
import type { PageContext } from "../main.ts";
import { friendly } from "./signin.ts";

const EXAMPLE = `{
  "format": "ast-editor-config/1",
  "mcpServers": [{ "name": "artisan", "command": "ae", "args": ["mcp"] }],
  "skills": [{ "name": "plan", "source": "builtin" }],
  "globalPrompt": "Follow the repository's AGENTS.md."
}`;

export function renderConfig(ctx: PageContext): void {
  const { root, api } = ctx;
  clear(root);

  const latest = el("div", { class: "card" });
  latest.append(el("h2", {}, "Latest bundle"));
  const lstatus = el("p", { class: "status muted", role: "status" }, "Loading…");
  latest.append(lstatus);
  root.append(latest);

  const pub = el("div", { class: "card" });
  pub.append(el("h2", {}, "Publish a bundle"));
  pub.append(el("p", { class: "muted small" }, "Versioned manifest: Forges fetch the latest version and report back what they applied. Paste JSON matching the contract; unknown fields are rejected."));
  const label = el("label", { for: "bundle-json" }, "Manifest JSON");
  const area = el("textarea", { id: "bundle-json", spellcheck: "false" }) as HTMLTextAreaElement;
  area.value = EXAMPLE;
  const btn = el("button", { type: "button" }, "Validate + publish");
  const msg = el("p", { class: "status", role: "status" });
  btn.addEventListener("click", () => {
    void (async () => {
      btn.disabled = true;
      try {
        let parsed: unknown;
        try {
          parsed = JSON.parse(area.value);
        } catch {
          throw new Error("Not valid JSON.");
        }
        // Strict against Core's published manifest (SkillRef.bundle
        // included): unknown fields rejected, bundle bytes preserved.
        const manifest: typeof C.EditorManifest.Type = decodeStrict(C.EditorManifest, parsed);
        const info = await api.publishBundle(manifest);
        msg.textContent = `Published version ${info.version}.`;
        msg.className = "status ok";
        void loadLatest(api, latest);
      } catch (err) {
        msg.textContent = friendly(err);
        msg.className = "status err";
      } finally {
        btn.disabled = false;
      }
    })();
  });
  pub.append(label, area, btn, msg);
  root.append(pub);

  root.append(skillFolderBox(area));

  const state = el("div", { class: "card" });
  state.append(el("h2", {}, "Machine state"));
  state.append(machineStateForm(api));
  root.append(state);

  void loadLatest(api, latest);
}

async function loadLatest(api: CoreApi, box: HTMLElement): Promise<void> {
  let res: Awaited<ReturnType<CoreApi["latestBundle"]>>;
  try {
    res = await api.latestBundle();
  } catch (err) {
    clear(box);
    box.append(el("h2", {}, "Latest bundle"));
    box.append(el("p", { class: "status err" }, friendly(err)));
    return;
  }
  clear(box);
  box.append(el("h2", {}, "Latest bundle"));
  if (!res.bundle || !res.manifest) {
    box.append(el("p", { class: "muted" }, "No bundle published yet."));
    return;
  }
  box.append(
    el("p", {}, `Version ${res.bundle.version} · published ${when(res.bundle.createdAt)}`),
    el("p", { class: "small mono" }, `sha256 ${res.bundle.contentHash}`),
    el("p", {}, `MCP servers: ${res.manifest.mcpServers.length} · Skills: ${res.manifest.skills.length}`),
  );
}

function machineStateForm(api: CoreApi): HTMLElement {  const wrap = el("div", {});
  const label = el("label", { for: "cfg-machine" }, "Forge id");
  const input = el("input", { id: "cfg-machine", type: "text", placeholder: "mch_…" }) as HTMLInputElement;
  const btn = el("button", { class: "secondary", type: "button" }, "Read state");
  const out = el("div", {});
  btn.addEventListener("click", () => {
    void (async () => {
      clear(out);
      const msg = el("p", { class: "status muted", role: "status" }, "Loading…");
      out.append(msg);
      try {
        const s = await api.configState(input.value.trim());
        clear(out);
        out.append(el("p", {}, `Bundle ${s.bundleId}: ${s.status}`, el("br", {}),
          el("span", { class: "small muted" }, `applied ${when(s.appliedAt)}`)));
      } catch (err) {
        msg.textContent = friendly(err);
        msg.className = "status err";
      }
    })();
  });
  wrap.append(label, input, btn, out);
  return wrap;
}

/**
 * Folder upload for bundled skills: picks a skill folder (SKILL.md +
 * relative support files), builds a strict `SkillRef.bundle` entry, and
 * inserts it into the manifest JSON above. Secret-looking and oversized
 * files are refused with names, never silently dropped.
 */
function skillFolderBox(area: HTMLTextAreaElement): HTMLElement {
  const box = el("div", { class: "card" });
  box.append(el("h2", {}, "Bundle a skill folder"));
  box.append(el("p", { class: "muted small" },
    "Adds a skill with its files embedded (SKILL.md required; content-hashed with the manifest). " +
    "Source defaults to “bundle” for embedded-only skills; change it if the Forge should also resolve an installed copy."));
  const nameLabel = el("label", { for: "skill-name" }, "Skill name (defaults to the folder name)");
  const nameInput = el("input", { id: "skill-name", type: "text", autocomplete: "off" }) as HTMLInputElement;
  const pickLabel = el("label", { for: "skill-folder" }, "Skill folder");
  const pick = el("input", { id: "skill-folder", type: "file" }) as HTMLInputElement;
  pick.setAttribute("webkitdirectory", "");
  const add = el("button", { class: "secondary", type: "button" }, "Add bundled skill to the manifest");
  const msg = el("p", { class: "status", role: "status" });
  add.addEventListener("click", () => {
    void (async () => {
      add.disabled = true;
      try {
        const files = [...(pick.files ?? [])];
        if (files.length === 0) throw new Error("Choose a skill folder first.");
        const top = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath?.split("/")[0] ?? "skill";
        const built = await buildSkillBundle({ folderName: top, files }, { name: nameInput.value });
        let manifest: Record<string, unknown>;
        try {
          manifest = JSON.parse(area.value) as Record<string, unknown>;
        } catch {
          throw new Error("The manifest above is not valid JSON yet.");
        }
        if (!Array.isArray(manifest.skills)) throw new Error("The manifest above has no skills array.");
        if ((manifest.skills as unknown[]).some((s) => (s as { name?: unknown }).name === built.name)) {
          throw new Error(`A skill named “${built.name}” is already in the manifest.`);
        }
        (manifest.skills as unknown[]).push({ name: built.name, source: built.source, bundle: built.bundle });
        area.value = JSON.stringify(manifest, null, 2);
        msg.textContent = `Added “${built.name}” with ${built.bundle.files.length} file(s). Review the manifest, then publish.` +
          (built.skipped.length > 0 ? ` Skipped: ${built.skipped.join("; ")}.` : "");
        msg.className = "status ok";
      } catch (err) {
        msg.textContent = friendly(err);
        msg.className = "status err";
      } finally {
        add.disabled = false;
      }
    })();
  });
  box.append(nameLabel, nameInput, pickLabel, pick, add, msg);
  return box;
}
