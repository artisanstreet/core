import { Effect, Match } from "effect";
import type { CoreApi } from "../api.ts";
import { decode_strict } from "../api.ts";
import * as C from "../../../src/contracts/v1.ts";
import { build_skill_bundle } from "../skills-bundle.ts";
import { run_promise } from "../core/run-promise.ts";
import { clear, el, when } from "../ui.ts";
import type { PageContext } from "../main.ts";
import { friendly } from "./signin.ts";

const EXAMPLE = `{
  "format": "ast-editor-config/1",
  "mcpServers": [{ "name": "artisan", "command": "ae", "args": ["mcp"] }],
  "skills": [{ "name": "plan", "source": "builtin" }],
  "globalPrompt": "Follow the repository's AGENTS.md."
}`;

export function render_config(ctx: PageContext): void {
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
    const publish: Effect.Effect<void, unknown> = Effect.gen(function* () {
      yield* Effect.sync(() => {
        btn.disabled = true;
      });
      const parsed = yield* Effect.try({
        try: () => JSON.parse(area.value) as unknown,
        catch: () => new Error("Not valid JSON."),
      });
      const manifest = yield* Effect.try({
        try: () => decode_strict(C.EditorManifest, parsed),
        catch: (e) => e,
      });
      const info = yield* Effect.tryPromise({ try: () => api.publish_bundle(manifest), catch: (e) => e });
      yield* Effect.sync(() => {
        msg.textContent = `Published version ${info.version}.`;
        msg.className = "status ok";
      });
      yield* load_latest_effect(api, latest);
    }).pipe(
      Effect.catchAll((err: unknown) =>
        Effect.sync(() => {
          msg.textContent = friendly(err);
          msg.className = "status err";
        }),
      ),
      Effect.ensuring(Effect.sync(() => {
        btn.disabled = false;
      })),
    );
    void run_promise(publish);
  });
  pub.append(label, area, btn, msg);
  root.append(pub);

  root.append(skill_folder_box(area));

  const state = el("div", { class: "card" });
  state.append(el("h2", {}, "Machine state"));
  state.append(machine_state_form(api));
  root.append(state);

  void run_promise(load_latest_effect(api, latest));
}

const load_latest_effect = (api: CoreApi, box: HTMLElement): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({ try: () => api.latest_bundle(), catch: (e) => e });
    yield* Effect.sync(() => {
      clear(box);
      box.append(el("h2", {}, "Latest bundle"));
      if (!res.bundle || !res.manifest) {
        box.append(el("p", { class: "muted" }, "No bundle published yet."));
        return;
      }
      box.append(
        el("p", {}, `Version ${res.bundle.version} · published ${when(res.bundle.created_at)}`),
        el("p", { class: "small mono" }, `sha256 ${res.bundle.content_hash}`),
        el("p", {}, `MCP servers: ${res.manifest.mcp_servers.length} · Skills: ${res.manifest.skills.length}`),
      );
    });
  }).pipe(
    Effect.catchAll((err: unknown) =>
      Effect.sync(() => {
        clear(box);
        box.append(el("h2", {}, "Latest bundle"));
        box.append(el("p", { class: "status err" }, friendly(err)));
      }),
    ),
  );

const machine_state_form = (api: CoreApi): HTMLElement => {
  const wrap = el("div", {});
  const label = el("label", { for: "cfg-machine" }, "Forge id");
  const input = el("input", { id: "cfg-machine", type: "text", placeholder: "mch_…" }) as HTMLInputElement;
  const btn = el("button", { class: "secondary", type: "button" }, "Read state");
  const out = el("div", {});
  btn.addEventListener("click", () => {
    const machine_id = input.value.trim();
    const read: Effect.Effect<void, unknown> = Effect.gen(function* () {
      yield* Effect.sync(() => {
        clear(out);
        const loading = el("p", { class: "status muted", role: "status" }, "Loading…");
        out.append(loading);
      });
      const s = yield* Effect.tryPromise({ try: () => api.config_state(machine_id), catch: (e) => e });
      yield* Effect.sync(() => {
        clear(out);
        out.append(el("p", {}, `Bundle ${s.bundle_id}: ${s.status}`, el("br", {}),
          el("span", { class: "small muted" }, `applied ${when(s.applied_at)}`)));
      });
    }).pipe(
      Effect.catchAll((err: unknown) =>
        Effect.sync(() => {
          const msg = out.querySelector("p");
          if (msg) {
            msg.textContent = friendly(err);
            msg.className = "status err";
          } else {
            clear(out);
            out.append(el("p", { class: "status err" }, friendly(err)));
          }
        }),
      ),
    );
    void run_promise(read);
  });
  wrap.append(label, input, btn, out);
  return wrap;
};

const skill_folder_box = (area: HTMLTextAreaElement): HTMLElement => {
  const box = el("div", { class: "card" });
  box.append(el("h2", {}, "Bundle a skill folder"));
  box.append(el("p", { class: "muted small" },
    "Adds a skill with its files embedded (SKILL.md required; content-hashed with the manifest). " +
    "Source defaults to “bundle” for embedded-only skills; change it if the Forge should also resolve an installed copy."));
  const name_label = el("label", { for: "skill-name" }, "Skill name (defaults to the folder name)");
  const name_input = el("input", { id: "skill-name", type: "text", autocomplete: "off" }) as HTMLInputElement;
  const pick_label = el("label", { for: "skill-folder" }, "Skill folder");
  const pick = el("input", { id: "skill-folder", type: "file" }) as HTMLInputElement;
  pick.setAttribute("webkitdirectory", "");
  const add = el("button", { class: "secondary", type: "button" }, "Add bundled skill to the manifest");
  const msg = el("p", { class: "status", role: "status" });
  add.addEventListener("click", () => {
    const files = [...(pick.files ?? [])];
    const top = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath?.split("/")[0] ?? "skill";
    const bundle_name = name_input.value;
    const program: Effect.Effect<void, unknown> = Effect.gen(function* () {
      yield* Effect.sync(() => {
        add.disabled = true;
      });
      if (files.length === 0) {
        yield* Effect.fail(new Error("Choose a skill folder first."));
      }
      const built = yield* Effect.tryPromise({
        try: () => build_skill_bundle({ folder_name: top, files }, { name: bundle_name }),
        catch: (e) => e,
      });
      const manifest = yield* Effect.try({
        try: () => JSON.parse(area.value) as Record<string, unknown>,
        catch: () => new Error("The manifest above is not valid JSON yet."),
      });
      if (!Array.isArray(manifest.skills)) {
        yield* Effect.fail(new Error("The manifest above has no skills array."));
      }
      const exists = (manifest.skills as unknown[]).some((s) => (s as { name?: unknown }).name === built.name);
      if (exists) {
        yield* Effect.fail(new Error(`A skill named “${built.name}” is already in the manifest.`));
      }
      yield* Effect.sync(() => {
        (manifest.skills as unknown[]).push({ name: built.name, source: built.source, bundle: built.bundle });
        area.value = JSON.stringify(manifest, null, 2);
        msg.textContent = `Added “${built.name}” with ${built.bundle.files.length} file(s). Review the manifest, then publish.` +
          (built.skipped.length > 0 ? ` Skipped: ${built.skipped.join("; ")}.` : "");
        msg.className = "status ok";
      });
    }).pipe(
      Effect.catchAll((err: unknown) =>
        Effect.sync(() => {
          msg.textContent = Match.value(err).pipe(
            Match.when(
              (v: unknown): v is Error => v instanceof Error,
              (e) => friendly(e),
            ),
            Match.orElse(() => "Something went wrong."),
          );
          msg.className = "status err";
        }),
      ),
      Effect.ensuring(Effect.sync(() => {
        add.disabled = false;
      })),
    );
    void run_promise(program);
  });
  box.append(name_label, name_input, pick_label, pick, add, msg);
  return box;
};
