// Forge connection: target picker, presence, encrypted channel setup.
// Delegates thread listing to `./thread-list.ts` once connected.

import type { CoreApi } from "../../api.ts";
import { clear, el } from "../../ui.ts";
import type { PageContext } from "../../main.ts";
import { newEphemeralCnf } from "../../relay-forge.ts";
import { fetchPresence, ForgeSession, type ForgeSessionOptions, type Presence } from "../../relay-forge.ts";
import type { LiveFeed } from "../../live.ts";
import { relayDefaults } from "../machines.ts";
import { friendly } from "../signin.ts";
import { openThreads } from "./thread-list.ts";
import type { ConnCtl } from "./shared.ts";

interface ForgeTarget {
  id: string;
  label: string;
  cnfX: string;
}

export function renderForge(ctx: PageContext): void {
  const { root, api, signal } = ctx;
  clear(root);
  const conn = el("div", { class: "card" });
  conn.append(el("h2", {}, "Reach a Forge"));
  const status = el("p", { class: "status muted", role: "status" }, "Loading your Forges…");
  conn.append(status);
  root.append(conn);
  const view = el("div", {});
  root.append(view);
  void setup(api, conn, status, view, signal);
}

async function setup(api: CoreApi, conn: HTMLElement, status: HTMLElement, view: HTMLElement, signal: AbortSignal): Promise<void> {
  let me: Awaited<ReturnType<CoreApi["me"]>>;
  try {
    me = await api.me();
  } catch (err) {
    status.textContent = friendly(err);
    status.className = "status err";
    return;
  }
  const targets: ForgeTarget[] = me.machines
    .filter((m) => !m.revokedAt)
    .map((m) => ({ id: m.id, label: m.label || "Forge", cnfX: m.publicKey.x }));
  clear(conn);
  conn.append(el("h2", {}, "Reach a Forge"));
  if (targets.length === 0) {
    conn.append(el("p", { class: "muted" }, "No Forges enrolled. Enroll one from the machine, then claim its code on the Forges page."));
    conn.append(el("p", {}, el("a", { href: "#/machines" }, "Go to Forges")));
    return;
  }
  const label = el("label", { for: "forge-pick" }, "Forge");
  const pick = el("select", { id: "forge-pick" }) as HTMLSelectElement;
  for (const t of targets) pick.append(el("option", { value: t.id }, `${t.label} (${t.id})`));
  const connectBtn = el("button", { type: "button" }, "Connect encrypted channel");
  const transport = el("p", { class: "status muted", role: "status" });
  conn.append(
    label, pick, connectBtn, transport,
    el("p", { class: "muted small" },
      "Every connect mints a fresh 5-minute grant bound to a one-use key, verifies the Forge's enrolled identity inside the Noise handshake, and destroys the session on any failure."),
  );
  let session: ForgeSession | null = null;
  let feed: LiveFeed | null = null;
  const stopFeed = () => {
    feed?.stop();
    feed = null;
  };
  signal.addEventListener("abort", () => {
    stopFeed();
    session?.close();
    session = null;
  });

  const onTarget = async (): Promise<void> => {
    const t = targets.find((x) => x.id === pick.value);
    if (!t) return;
    transport.textContent = "Checking presence…";
    try {
      const grant = await api.issueGrant({
        audience: "ast-relay",
        scope: ["relay:connect"],
        ttlSeconds: 300,
        targetMachineId: t.id,
        cnf: newEphemeralCnf().jwk,
      });
      const { http } = relayDefaults();
      const p: Presence = await fetchPresence(http, me.accountId, t.id, grant.token);
      transport.textContent = p.forgeOnline
        ? `Forge is online (${p.clients} browser${p.clients === 1 ? "" : "s"} connected).`
        : "Forge is offline. It must be running and linked to Relay before threads can load.";
    } catch {
      transport.textContent = "Presence is unavailable (Relay may not be deployed yet). Connecting will tell you for sure.";
    }
  };
  pick.addEventListener("change", () => void onTarget());
  void onTarget();

  connectBtn.addEventListener("click", () => {
    void (async () => {
      const t = targets.find((x) => x.id === pick.value);
      if (!t) return;
      stopFeed();
      session?.close();
      clear(view);
      connectBtn.disabled = true;
      transport.textContent = "Opening encrypted channel…";
      try {
        const { ws, http } = relayDefaults();
        const ctl: ConnCtl = {
          opts: {
            core: api,
            relayWsUrl: ws,
            relayHttpUrl: http,
            accountId: me.accountId,
            machineId: t.id,
            forgeCnfX: t.cnfX,
            onEvent: (ev) => {
              if (ev.type === "presence") {
                transport.textContent = ev.forgeOnline
                  ? `Forge is online (${ev.clients} browser${ev.clients === 1 ? "" : "s"} connected).`
                  : "Forge went offline.";
              } else if (ev.type === "error") {
                transport.textContent = `Channel problem: ${ev.message}`;
                transport.className = "status err";
              } else if (ev.type === "channel-closed") {
                stopFeed();
              }
            },
          },
          current: null,
        };
        const s = new ForgeSession(ctl.opts);
        ctl.current = s;
        session = s;
        const { forgeOnline } = await s.connect();
        transport.textContent = forgeOnline
          ? "Encrypted channel open. Forge verified by its enrolled key."
          : "Encrypted channel open. Forge side not yet attached — threads will load once it is.";
        transport.className = "status ok";
        feed = await openThreads(ctl, view);
      } catch (err) {
        transport.textContent = friendly(err);
        transport.className = "status err";
        session = null;
      } finally {
        connectBtn.disabled = false;
      }
    })();
  });
}
