import { Effect } from "effect";
import type { CoreApi } from "../api.ts";
import { run_promise } from "../core/run-promise.ts";
import { clear, el, id_span, when } from "../ui.ts";
import type { PageContext } from "../main.ts";
import { friendly } from "./signin.ts";

const PROVIDERS = ["anthropic", "openai", "openrouter", "google"] as const;

export function render_vault(ctx: PageContext): void {
  const { root, api } = ctx;
  clear(root);

  const list = el("div", { class: "card" });
  list.append(el("h2", {}, "Connections"));
  const status = el("p", { class: "status muted", role: "status" }, "Loading…");
  list.append(status);
  root.append(list);

  const create = el("div", { class: "card" });
  create.append(el("h2", {}, "Add a provider API key"));
  create.append(el("p", { class: "muted small" },
    "Stored encrypted. Only Forges you assign below can use it, and the key itself never appears in this UI again."));
  create.append(provider_form(api, () => void run_promise(refresh_effect(api, list))));
  root.append(create);

  const arts = el("div", { class: "card" });
  arts.append(el("h2", {}, "Engine credential artifacts"));
  const astatus = el("p", { class: "status muted", role: "status" }, "Loading…");
  arts.append(astatus);
  root.append(arts);

  void run_promise(refresh_effect(api, list));
  void run_promise(refresh_artifacts_effect(ctx, arts, astatus));
}

const refresh_effect = (api: CoreApi, list: HTMLElement): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({ try: () => api.provider_connections(), catch: (e) => e });
    const machines = (yield* Effect.tryPromise({ try: () => api.machines(), catch: (e) => e })).machines;
    yield* Effect.sync(() => {
      render_connections(api, list, res.connections, machines);
    });
  }).pipe(
    Effect.catchAll((err: unknown) =>
      Effect.sync(() => {
        clear(list);
        list.append(el("h2", {}, "Provider connections"));
        list.append(el("p", { class: "status err" }, friendly(err)));
      }),
    ),
  );

const render_connections = (
  api: CoreApi,
  list: HTMLElement,
  connections: ReadonlyArray<{
    id: string;
    provider: string;
    label: string | null;
    revoked_at: string | null;
    assigned_machine_ids: ReadonlyArray<string>;
  }>,
  machines: ReadonlyArray<{ id: string; label: string | null; revoked_at: string | null }>,
): void => {
  clear(list);
  list.append(el("h2", {}, "Connections"));
  const live = machines.filter((m) => !m.revoked_at);
  if (connections.length === 0) {
    list.append(el("p", { class: "muted" }, "No provider connections yet."));
    return;
  }
  const table = el("table", {});
  table.append(el("tr", {}, el("th", {}, "Connection"), el("th", {}, "Assigned Forges"), el("th", {}, "")));
  for (const c of connections) {
    const assign_cell = el("td", {});
    if (!c.revoked_at) {
      const sel = el("select", { "aria-label": `Assign ${c.label || c.provider} to a Forge` }) as HTMLSelectElement;
      sel.append(el("option", { value: "" }, "choose a Forge…"));
      for (const m of live) sel.append(el("option", { value: m.id }, `${m.label || "Forge"} (${m.id.slice(0, 13)}…)`));
      const go = el("button", { class: "secondary", type: "button" }, "Assign");
      const msg = el("span", { class: "small", role: "status" });
      go.addEventListener("click", () => {
        if (!sel.value) return;
        const target = sel.value;
        const assign: Effect.Effect<void, unknown> = Effect.gen(function* () {
          yield* Effect.tryPromise({ try: () => api.assign_connection(c.id, target), catch: (e) => e });
          yield* Effect.sync(() => {
            msg.textContent = " Assigned.";
          });
          yield* refresh_effect(api, list);
        }).pipe(
          Effect.catchAll((err: unknown) =>
            Effect.sync(() => {
              msg.textContent = ` ${friendly(err)}`;
            }),
          ),
        );
        void run_promise(assign);
      });
      assign_cell.append(sel, go, msg);
      for (const mid of c.assigned_machine_ids) {
        const chip = el("div", { class: "small" }, id_span(mid), " ");
        const un = el("button", { class: "secondary", type: "button" }, "remove");
        un.addEventListener("click", () => {
          const unassign: Effect.Effect<void, unknown> = Effect.gen(function* () {
            yield* Effect.tryPromise({ try: () => api.unassign_connection(c.id, mid), catch: (e) => e });
            yield* refresh_effect(api, list);
          }).pipe(
            Effect.catchAll((err: unknown) =>
              Effect.sync(() => {
                chip.append(el("span", { class: "err" }, ` ${friendly(err)}`));
              }),
            ),
          );
          void run_promise(unassign);
        });
        chip.append(un);
        assign_cell.append(chip);
      }
    } else {
      assign_cell.textContent = "—";
    }
    const revoke = c.revoked_at
      ? el("span", { class: "muted small" }, `revoked ${when(c.revoked_at)}`)
      : (() => {
          const b = el("button", { class: "danger", type: "button" }, "Revoke");
          b.addEventListener("click", () => {
            const revoke_one: Effect.Effect<void, unknown> = Effect.gen(function* () {
              yield* Effect.tryPromise({ try: () => api.revoke_provider_connection(c.id), catch: (e) => e });
              yield* refresh_effect(api, list);
            }).pipe(
              Effect.catchAll((err: unknown) =>
                Effect.sync(() => {
                  b.after(el("span", { class: "err small" }, ` ${friendly(err)}`));
                }),
              ),
            );
            void run_promise(revoke_one);
          });
          return b;
        })();
    table.append(el("tr", {},
      el("td", {}, `${c.provider} — ${c.label || "unnamed"}`, el("br", {}), id_span(c.id)),
      assign_cell,
      el("td", {}, revoke),
    ));
  }
  list.append(table);
};

const provider_form = (api: CoreApi, on_done: () => void): HTMLElement => {
  const form = el("form", {});
  const p_label = el("label", { for: "vault-provider" }, "Provider");
  const provider = el("select", { id: "vault-provider" }) as HTMLSelectElement;
  for (const p of PROVIDERS) provider.append(el("option", { value: p }, p));
  const l_label = el("label", { for: "vault-label" }, "Label");
  const label = el("input", { id: "vault-label", type: "text", placeholder: "cafe account" }) as HTMLInputElement;
  const k_label = el("label", { for: "vault-key" }, "API key (sent once, never shown again)");
  const key = el("input", { id: "vault-key", type: "text", required: "true", autocomplete: "off" }) as HTMLInputElement;
  const btn = el("button", { type: "submit" }, "Store connection");
  const msg = el("p", { class: "status", role: "status" });
  form.append(p_label, provider, l_label, label, k_label, key, btn, msg);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const kind = provider.value as (typeof PROVIDERS)[number];
    const name = label.value.trim();
    const secret = key.value;
    const store: Effect.Effect<void, unknown> = Effect.gen(function* () {
      yield* Effect.sync(() => {
        btn.disabled = true;
      });
      yield* Effect.tryPromise({ try: () => api.create_provider_connection(kind, name, secret), catch: (err) => err });
      yield* Effect.sync(() => {
        key.value = "";
        msg.textContent = "Stored.";
        msg.className = "status ok";
        on_done();
      });
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
    void run_promise(store);
  });
  return form;
};

const refresh_artifacts_effect = (ctx: PageContext, box: HTMLElement, status: HTMLElement): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const { api } = ctx;
    const res = yield* Effect.tryPromise({ try: () => api.artifacts(), catch: (e) => e });
    const machines = yield* Effect.orElseSucceed(
      Effect.tryPromise({ try: () => api.machines(), catch: () => null }),
      () => ({ machines: [] as Array<{ id: string; label: string | null; revoked_at: string | null }> }),
    );
    yield* Effect.sync(() => {
      render_artifacts(ctx, box, status, res.artifacts, machines.machines);
    });
  }).pipe(
    Effect.catchAll((err: unknown) =>
      Effect.sync(() => {
        status.textContent = friendly(err);
        status.className = "status err";
      }),
    ),
  );

const render_artifacts = (
  ctx: PageContext,
  box: HTMLElement,
  status: HTMLElement,
  artifacts: ReadonlyArray<{
    id: string;
    engine: string;
    kind: string;
    label: string | null;
    revoked_at: string | null;
    exported_at: string;
    assigned_machine_ids: ReadonlyArray<string>;
  }>,
  machines: ReadonlyArray<{ id: string; label: string | null; revoked_at: string | null }>,
): void => {
  const { api } = ctx;
  clear(box);
  box.append(el("h2", {}, "Engine credential artifacts"));
  box.append(el("p", { class: "muted small" },
    "Opaque credential envelopes from a harness's own local login (Core validates the shape; inner file bytes stay opaque). Assign per Forge; download happens only from the assigned Forge itself."));
  if (artifacts.length === 0) {
    box.append(el("p", { class: "muted" }, "No artifacts stored."));
    return;
  }
  const live = machines.filter((m) => !m.revoked_at);
  const table = el("table", {});
  table.append(el("tr", {}, el("th", {}, "Artifact"), el("th", {}, "Assigned Forges"), el("th", {}, "")));
  for (const a of artifacts) {
    const cell = el("td", {});
    for (const mid of a.assigned_machine_ids) {
      const chip = el("div", { class: "small" }, id_span(mid), " ");
      const un = el("button", { class: "secondary", type: "button" }, "remove");
      un.addEventListener("click", () => {
        const artifact_id = a.id;
        const unassign: Effect.Effect<void, unknown> = Effect.gen(function* () {
          yield* Effect.tryPromise({ try: () => api.unassign_artifact(artifact_id, mid), catch: (e) => e });
          yield* Effect.sync(() => {
            void run_promise(refresh_artifacts_effect(ctx, box, box.querySelector("p") ?? box));
          });
        }).pipe(
          Effect.catchAll((err: unknown) =>
            Effect.sync(() => {
              chip.append(el("span", { class: "err" }, ` ${friendly(err)}`));
            }),
          ),
        );
        void run_promise(unassign);
      });
      chip.append(un);
      cell.append(chip);
    }
    if (!a.revoked_at) {
      const sel = el("select", { "aria-label": `Assign artifact ${a.id} to a Forge` }) as HTMLSelectElement;
      sel.append(el("option", { value: "" }, "assign to…"));
      for (const m of live) sel.append(el("option", { value: m.id }, `${m.label || "Forge"} (${m.id.slice(0, 13)}…)`));
      const go = el("button", { class: "secondary", type: "button" }, "Assign");
      go.addEventListener("click", () => {
        if (!sel.value) return;
        const target = sel.value;
        const artifact_id = a.id;
        const assign: Effect.Effect<void, unknown> = Effect.gen(function* () {
          yield* Effect.tryPromise({ try: () => api.assign_artifact(artifact_id, target), catch: (e) => e });
          yield* Effect.sync(() => {
            void run_promise(refresh_artifacts_effect(ctx, box, box.querySelector("p") ?? box));
          });
        }).pipe(
          Effect.catchAll((err: unknown) =>
            Effect.sync(() => {
              cell.append(el("span", { class: "err small" }, ` ${friendly(err)}`));
            }),
          ),
        );
        void run_promise(assign);
      });
      cell.append(sel, go);
    }
    const revoke = a.revoked_at
      ? el("span", { class: "muted small" }, `revoked ${when(a.revoked_at)}`)
      : (() => {
          const b = el("button", { class: "danger", type: "button" }, "Revoke");
          b.addEventListener("click", () => {
            const artifact_id = a.id;
            const revoke_one: Effect.Effect<void, unknown> = Effect.gen(function* () {
              yield* Effect.tryPromise({ try: () => api.revoke_artifact(artifact_id), catch: (e) => e });
              yield* Effect.sync(() => {
                void run_promise(refresh_artifacts_effect(ctx, box, box.querySelector("p") ?? box));
              });
            }).pipe(
              Effect.catchAll((err: unknown) =>
                Effect.sync(() => {
                  b.after(el("span", { class: "err small" }, ` ${friendly(err)}`));
                }),
              ),
            );
            void run_promise(revoke_one);
          });
          return b;
        })();
    table.append(el("tr", {},
      el("td", {}, `${a.engine} / ${a.kind} — ${a.label || "unnamed"}`, el("br", {}), id_span(a.id), el("br", {}),
        el("span", { class: "small muted" }, `exported ${when(a.exported_at)}`)),
      cell,
      el("td", {}, revoke),
    ));
  }
  box.append(table);
};
