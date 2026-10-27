// Provider credentials + engine artifacts (#/vault).
// Secrets are write-only here: the UI sends API keys/ envelopes on create
// and never reads them back (release happens only to assigned machines over
// authenticated machine channels). Lists show metadata + assignments only.

import type { CoreApi } from "../api.ts";
import { clear, el, idSpan, when } from "../ui.ts";
import type { PageContext } from "../main.ts";
import { friendly } from "./signin.ts";

const PROVIDERS = ["anthropic", "openai", "openrouter", "google"] as const;

export function renderVault(ctx: PageContext): void {
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
  create.append(providerForm(api, () => void refresh(api, list)));
  root.append(create);

  const arts = el("div", { class: "card" });
  arts.append(el("h2", {}, "Engine credential artifacts"));
  const astatus = el("p", { class: "status muted", role: "status" }, "Loading…");
  arts.append(astatus);
  root.append(arts);

  void refresh(api, list);
  void refreshArtifacts(ctx, arts, astatus);
}

async function refresh(api: CoreApi, list: HTMLElement): Promise<void> {
  let res: Awaited<ReturnType<CoreApi["providerConnections"]>>;
  let machines: Awaited<ReturnType<CoreApi["machines"]>>["machines"] = [];
  try {
    [res, machines] = [await api.providerConnections(), (await api.machines()).machines];
  } catch (err) {
    clear(list);
    list.append(el("h2", {}, "Provider connections"));
    list.append(el("p", { class: "status err" }, friendly(err)));
    return;
  }
  clear(list);
  list.append(el("h2", {}, "Connections"));
  const live = machines.filter((m) => !m.revokedAt);
  if (res.connections.length === 0) {
    list.append(el("p", { class: "muted" }, "No provider connections yet."));
    return;
  }
  const table = el("table", {});
  table.append(el("tr", {}, el("th", {}, "Connection"), el("th", {}, "Assigned Forges"), el("th", {}, "")));
  for (const c of res.connections) {
    const assignCell = el("td", {});
    if (!c.revokedAt) {
      const sel = el("select", { "aria-label": `Assign ${c.label || c.provider} to a Forge` }) as HTMLSelectElement;
      sel.append(el("option", { value: "" }, "choose a Forge…"));
      for (const m of live) sel.append(el("option", { value: m.id }, `${m.label || "Forge"} (${m.id.slice(0, 13)}…)`));
      const go = el("button", { class: "secondary", type: "button" }, "Assign");
      const msg = el("span", { class: "small", role: "status" });
      go.addEventListener("click", () => {
        void (async () => {
          if (!sel.value) return;
          try {
            await api.assignConnection(c.id, sel.value);
            msg.textContent = " Assigned.";
            void refresh(api, list);
          } catch (err) {
            msg.textContent = ` ${friendly(err)}`;
          }
        })();
      });
      assignCell.append(sel, go, msg);
      for (const mid of c.assignedMachineIds) {
        const chip = el("div", { class: "small" }, idSpan(mid), " ");
        const un = el("button", { class: "secondary", type: "button" }, "remove");
        un.addEventListener("click", () => {
          void (async () => {
            try {
              await api.unassignConnection(c.id, mid);
              void refresh(api, list);
            } catch (err) {
              chip.append(el("span", { class: "err" }, ` ${friendly(err)}`));
            }
          })();
        });
        chip.append(un);
        assignCell.append(chip);
      }
    } else {
      assignCell.textContent = "—";
    }
    const revoke = c.revokedAt
      ? el("span", { class: "muted small" }, `revoked ${when(c.revokedAt)}`)
      : (() => {
          const b = el("button", { class: "danger", type: "button" }, "Revoke");
          b.addEventListener("click", () => {
            void (async () => {
              try {
                await api.revokeProviderConnection(c.id);
                void refresh(api, list);
              } catch (err) {
                b.after(el("span", { class: "err small" }, ` ${friendly(err)}`));
              }
            })();
          });
          return b;
        })();
    table.append(el("tr", {},
      el("td", {}, `${c.provider} — ${c.label || "unnamed"}`, el("br", {}), idSpan(c.id)),
      assignCell,
      el("td", {}, revoke),
    ));
  }
  list.append(table);
}

function providerForm(api: CoreApi, onDone: () => void): HTMLElement {
  const form = el("form", {});
  const pLabel = el("label", { for: "vault-provider" }, "Provider");
  const provider = el("select", { id: "vault-provider" }) as HTMLSelectElement;
  for (const p of PROVIDERS) provider.append(el("option", { value: p }, p));
  const lLabel = el("label", { for: "vault-label" }, "Label");
  const label = el("input", { id: "vault-label", type: "text", placeholder: "cafe account" }) as HTMLInputElement;
  const kLabel = el("label", { for: "vault-key" }, "API key (sent once, never shown again)");
  const key = el("input", { id: "vault-key", type: "text", required: "true", autocomplete: "off" }) as HTMLInputElement;
  const btn = el("button", { type: "submit" }, "Store connection");
  const msg = el("p", { class: "status", role: "status" });
  form.append(pLabel, provider, lLabel, label, kLabel, key, btn, msg);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      btn.disabled = true;
      try {
        await api.createProviderConnection(
          provider.value as (typeof PROVIDERS)[number],
          label.value.trim(),
          key.value,
        );
        key.value = "";
        msg.textContent = "Stored.";
        msg.className = "status ok";
        onDone();
      } catch (err) {
        msg.textContent = friendly(err);
        msg.className = "status err";
      } finally {
        btn.disabled = false;
      }
    })();
  });
  return form;
}

async function refreshArtifacts(ctx: PageContext, box: HTMLElement, status: HTMLElement): Promise<void> {
  const { api } = ctx;
  let res: Awaited<ReturnType<CoreApi["artifacts"]>>;
  try {
    res = await api.artifacts();
  } catch (err) {
    status.textContent = friendly(err);
    status.className = "status err";
    return;
  }
  clear(box);
  box.append(el("h2", {}, "Engine credential artifacts"));
  box.append(el("p", { class: "muted small" },
    "Opaque credential envelopes from a harness's own local login (Core validates the shape; inner file bytes stay opaque). Assign per Forge; download happens only from the assigned Forge itself."));
  if (res.artifacts.length === 0) {
    box.append(el("p", { class: "muted" }, "No artifacts stored."));
    return;
  }
  let machines: Awaited<ReturnType<CoreApi["machines"]>>["machines"] = [];
  try {
    machines = (await api.machines()).machines;
  } catch {
    // assignment dropdown stays empty; listing still works.
  }
  const live = machines.filter((m) => !m.revokedAt);
  const table = el("table", {});
  table.append(el("tr", {}, el("th", {}, "Artifact"), el("th", {}, "Assigned Forges"), el("th", {}, "")));
  for (const a of res.artifacts) {
    const cell = el("td", {});
    for (const mid of a.assignedMachineIds) {
      const chip = el("div", { class: "small" }, idSpan(mid), " ");
      const un = el("button", { class: "secondary", type: "button" }, "remove");
      un.addEventListener("click", () => {
        void (async () => {
          try {
            await api.unassignArtifact(a.id, mid);
            void refreshArtifacts(ctx, box, status);
          } catch (err) {
            chip.append(el("span", { class: "err" }, ` ${friendly(err)}`));
          }
        })();
      });
      chip.append(un);
      cell.append(chip);
    }
    if (!a.revokedAt) {
      const sel = el("select", { "aria-label": `Assign artifact ${a.id} to a Forge` }) as HTMLSelectElement;
      sel.append(el("option", { value: "" }, "assign to…"));
      for (const m of live) sel.append(el("option", { value: m.id }, `${m.label || "Forge"} (${m.id.slice(0, 13)}…)`));
      const go = el("button", { class: "secondary", type: "button" }, "Assign");
      go.addEventListener("click", () => {
        void (async () => {
          if (!sel.value) return;
          try {
            await api.assignArtifact(a.id, sel.value);
            void refreshArtifacts(ctx, box, status);
          } catch (err) {
            cell.append(el("span", { class: "err small" }, ` ${friendly(err)}`));
          }
        })();
      });
      cell.append(sel, go);
    }
    const revoke = a.revokedAt
      ? el("span", { class: "muted small" }, `revoked ${when(a.revokedAt)}`)
      : (() => {
          const b = el("button", { class: "danger", type: "button" }, "Revoke");
          b.addEventListener("click", () => {
            void (async () => {
              try {
                await api.revokeArtifact(a.id);
                void refreshArtifacts(ctx, box, status);
              } catch (err) {
                b.after(el("span", { class: "err small" }, ` ${friendly(err)}`));
              }
            })();
          });
          return b;
        })();
    table.append(el("tr", {},
      el("td", {}, `${a.engine} / ${a.kind} — ${a.label || "unnamed"}`, el("br", {}), idSpan(a.id), el("br", {}),
        el("span", { class: "small muted" }, `exported ${when(a.exportedAt)}`)),
      cell,
      el("td", {}, revoke),
    ));
  }
  box.append(table);
}
