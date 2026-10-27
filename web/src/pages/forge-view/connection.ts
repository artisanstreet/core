import { Effect } from "effect";
import type { CoreApi } from "../../api.ts";
import { run_promise } from "../../core/run-promise.ts";
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
  void run_promise(setup_effect(api, conn, status, view, signal));
}

const setup_effect = (api: CoreApi, conn: HTMLElement, status: HTMLElement, view: HTMLElement, signal: AbortSignal) =>
  Effect.gen(function* () {
    const me = yield* Effect.tryPromise({ try: () => api.me(), catch: (e) => e });
    yield* Effect.sync(() => {
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

      const onTarget = () => {
        const t = targets.find((x) => x.id === pick.value);
        if (!t) return;
        transport.textContent = "Checking presence…";
        const check = Effect.gen(function* () {
          const grant = yield* Effect.tryPromise({
            try: () =>
              api.issueGrant({
                audience: "ast-relay",
                scope: ["relay:connect"],
                ttlSeconds: 300,
                targetMachineId: t.id,
                cnf: newEphemeralCnf().jwk,
              }),
            catch: (e) => e,
          });
          const { http } = relayDefaults();
          const p: Presence = yield* Effect.tryPromise({ try: () => fetchPresence(http, me.accountId, t.id, grant.token), catch: (e) => e });
          yield* Effect.sync(() => {
            transport.textContent = p.forgeOnline
              ? `Forge is online (${p.clients} browser${p.clients === 1 ? "" : "s"} connected).`
              : "Forge is offline. It must be running and linked to Relay before threads can load.";
          });
        }).pipe(
          Effect.catchAll(() =>
            Effect.sync(() => {
              transport.textContent = "Presence is unavailable (Relay may not be deployed yet). Connecting will tell you for sure.";
            }),
          ),
        );
        void run_promise(check);
      };
      pick.addEventListener("change", () => onTarget());
      onTarget();

      connectBtn.addEventListener("click", () => {
        const t = targets.find((x) => x.id === pick.value);
        if (!t) return;
        stopFeed();
        session?.close();
        clear(view);
        const connect = Effect.gen(function* () {
          yield* Effect.sync(() => {
            connectBtn.disabled = true;
            transport.textContent = "Opening encrypted channel…";
          });
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
            } as ForgeSessionOptions,
            current: null,
          };
          const s = new ForgeSession(ctl.opts);
          ctl.current = s;
          session = s;
          const { forgeOnline } = yield* Effect.tryPromise({ try: () => s.connect(), catch: (e) => e });
          yield* Effect.sync(() => {
            transport.textContent = forgeOnline
              ? "Encrypted channel open. Forge verified by its enrolled key."
              : "Encrypted channel open. Forge side not yet attached — threads will load once it is.";
            transport.className = "status ok";
          });
          const nextFeed = yield* openThreads(ctl, view);
          yield* Effect.sync(() => {
            feed = nextFeed;
          });
        }).pipe(
          Effect.catchAll((err) =>
            Effect.sync(() => {
              transport.textContent = friendly(err);
              transport.className = "status err";
              session = null;
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              connectBtn.disabled = false;
            }),
          ),
        );
        void run_promise(connect);
      });
    });
  }).pipe(
    Effect.catchAll((err) =>
      Effect.sync(() => {
        status.textContent = friendly(err);
        status.className = "status err";
      }),
    ),
  );
