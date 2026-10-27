// Forge machines (#/machines): registry from authenticated Core plus live
// presence from Relay. Enrollment claims a pending code into this account;
// the Forge operator still confirms the exact identity locally before any
// machine row is created (guessing the code enrolls nothing).

import type { CoreApi } from "../api.ts";
import { clear, el, idSpan, when } from "../ui.ts";
import type { PageContext } from "../main.ts";
import { fetchPresence, newEphemeralCnf } from "../relay-forge.ts";
import { friendly } from "./signin.ts";

export function relayDefaults(): { ws: string; http: string } {
  let ws = "wss://relay.artisanstreet.dev";
  let http = "https://relay.artisanstreet.dev";
  try {
    ws = localStorage.getItem("ast-core:relay-ws") ?? ws;
    http = localStorage.getItem("ast-core:relay-http") ?? http;
  } catch {
    // ignore
  }
  return { ws, http };
}

export function renderMachines(ctx: PageContext): void {
  const { root, api } = ctx;
  clear(root);

  const cfg = el("div", { class: "card" });
  cfg.append(el("h2", {}, "Relay connection"));
  cfg.append(el("p", { class: "muted small" }, "Presence and remote threads go through the Relay service. Change these only if root gave you different Relay addresses."));
  const wsLabel = el("label", { for: "relay-ws" }, "Relay WebSocket base");
  const wsInput = el("input", { id: "relay-ws", type: "url" }) as HTMLInputElement;
  const httpLabel = el("label", { for: "relay-http" }, "Relay HTTPS base (presence)");
  const httpInput = el("input", { id: "relay-http", type: "url" }) as HTMLInputElement;
  const d = relayDefaults();
  wsInput.value = d.ws;
  httpInput.value = d.http;
  const save = el("button", { class: "secondary", type: "button" }, "Save Relay addresses");
  const savedMsg = el("p", { class: "status small", role: "status" });
  save.addEventListener("click", () => {
    try {
      localStorage.setItem("ast-core:relay-ws", wsInput.value.trim());
      localStorage.setItem("ast-core:relay-http", httpInput.value.trim());
      savedMsg.textContent = "Saved.";
    } catch {
      savedMsg.textContent = "Could not save (storage unavailable).";
    }
  });
  cfg.append(wsLabel, wsInput, httpLabel, httpInput, save, savedMsg);
  root.append(cfg);

  const list = el("div", { class: "card" });
  list.append(el("h2", {}, "Machines on this account"));
  const status = el("p", { class: "status muted", role: "status" }, "Loading…");
  list.append(status);
  root.append(list);

  const claim = el("div", { class: "card" });
  claim.append(
    el("h2", {}, "Claim a machine enrollment"),
    el("p", { class: "muted small" },
      "Enter the 8-character code your Forge printed. This binds the Forge's key to your account; the Forge operator still confirms your exact identity locally, and only then is the machine created."),
    claimForm(api),
  );
  root.append(claim);

  void loadMachines(api, list, status);
}

async function loadMachines(api: CoreApi, list: HTMLElement, status: HTMLElement): Promise<void> {
  let machines: Awaited<ReturnType<CoreApi["machines"]>>["machines"];
  try {
    machines = (await api.machines()).machines;
  } catch (err) {
    status.textContent = friendly(err);
    status.className = "status err";
    return;
  }
  clear(list);
  list.append(el("h2", {}, "Machines on this account"));
  if (machines.length === 0) {
    list.append(el("p", { class: "muted" }, "No machines enrolled yet. Start an enrollment on the machine, then claim its code below."));
    return;
  }
  const table = el("table", {});
  table.append(el("tr", {}, el("th", {}, "Forge"), el("th", {}, "Seen"), el("th", {}, "Presence"), el("th", {}, "")));
  for (const m of machines) {
    const presenceCell = el("td", { class: "muted" }, "checking…");
    const revokeBtn = el("button", { class: "danger", type: "button" }, "Revoke");
    const row = el("tr", {},
      el("td", {}, m.label || "unnamed Forge", el("br", {}), idSpan(m.id)),
      el("td", {}, m.revokedAt ? `revoked ${when(m.revokedAt)}` : `last seen ${when(m.lastSeenAt)}`),
      presenceCell,
      el("td", {}, m.revokedAt ? el("span", { class: "muted" }, "revoked") : revokeBtn),
    );
    table.append(row);
    if (!m.revokedAt) {
      revokeBtn.addEventListener("click", () => {
        void (async () => {
          try {
            await api.revokeMachine(m.id);
            revokeBtn.disabled = true;
            presenceCell.textContent = "revoked";
          } catch (err) {
            presenceCell.textContent = friendly(err);
            presenceCell.className = "err";
          }
        })();
      });
      void checkPresence(api, m.id, presenceCell);
    } else {
      presenceCell.textContent = "—";
    }
  }
  list.append(table);
}

async function checkPresence(api: CoreApi, machineId: string, cell: HTMLElement): Promise<void> {
  const { http } = relayDefaults();
  try {
    const me = await api.me();
    const grant = await api.issueGrant({
      audience: "ast-relay",
      scope: ["relay:connect"],
      ttlSeconds: 300,
      targetMachineId: machineId,
      cnf: ephemeralCnfJwk(),
    });
    void me;
    const p = await fetchPresence(http, me.accountId, machineId, grant.token);
    cell.textContent = p.forgeOnline ? `online (${p.clients} browser${p.clients === 1 ? "" : "s"})` : "offline";
    cell.className = p.forgeOnline ? "ok" : "muted";
  } catch {
    cell.textContent = "presence unavailable";
    cell.className = "muted";
  }
}

/** Presence grants need a fresh ephemeral `cnf`; same constructor as tunnel grants. */
function ephemeralCnfJwk(): { kty: "OKP"; crv: "Ed25519"; x: string } {
  return newEphemeralCnf().jwk;
}

function claimForm(api: CoreApi): HTMLElement {
  const form = el("form", {});
  const label = el("label", { for: "claim-code" }, "Enrollment code");
  const input = el("input", { id: "claim-code", type: "text", required: "true", autocomplete: "off", maxlength: "8", placeholder: "ABCDEFGH" }) as HTMLInputElement;
  const btn = el("button", { type: "submit" }, "Claim into this account");
  const msg = el("p", { class: "status", role: "status" });
  form.append(label, input, btn, msg);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      btn.disabled = true;
      msg.textContent = "Claiming…";
      try {
        const res = await api.claimEnrollment(input.value.trim().toUpperCase());
        msg.textContent = `Claimed enrollment ${res.enrollmentId}. Confirm it on the Forge — nothing is enrolled until the local operator approves your exact identity.`;
        msg.className = "status ok";
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
