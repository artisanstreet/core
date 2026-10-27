import { Effect, Either, Match } from "effect";
import type { CoreApi } from "../api.ts";
import { run_promise } from "../core/run-promise.ts";
import { clear, el, idSpan, when } from "../ui.ts";
import type { PageContext } from "../main.ts";
import { fetchPresence, newEphemeralCnf } from "../relay-forge.ts";
import { friendly } from "./signin.ts";

export function relayDefaults(): { ws: string; http: string } {
  const ws_default = "wss://relay.artisanstreet.dev";
  const http_default = "https://relay.artisanstreet.dev";
  const read_key = (key: string): string | null =>
    Either.match(Either.try({ try: () => localStorage.getItem(key), catch: () => null }), {
      onLeft: (): string | null => null,
      onRight: (value): string | null => value,
    });
  return {
    ws: read_key("ast-core:relay-ws") ?? ws_default,
    http: read_key("ast-core:relay-http") ?? http_default,
  };
}

type SaveRelayState = { readonly _tag: "Saved" } | { readonly _tag: "Unavailable" };

const save_relay_state = (ws: string, http: string): SaveRelayState => {
  const stored = Either.match(
    Either.try({
      try: () => {
        localStorage.setItem("ast-core:relay-ws", ws);
        localStorage.setItem("ast-core:relay-http", http);
      },
      catch: () => null,
    }),
    { onLeft: () => false, onRight: () => true },
  );
  return stored ? { _tag: "Saved" } : { _tag: "Unavailable" };
};

const save_message = (state: SaveRelayState): string =>
  Match.value(state).pipe(
    Match.tag("Saved", () => "Saved."),
    Match.tag("Unavailable", () => "Could not save (storage unavailable)."),
    Match.exhaustive,
  );

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
    const program: Effect.Effect<void, never> = Effect.sync(() => save_relay_state(wsInput.value.trim(), httpInput.value.trim())).pipe(
      Effect.map((state) => {
        savedMsg.textContent = save_message(state);
      }),
    );
    void run_promise(program);
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

  void run_promise(load_machines_effect(api, list, status));
}

const load_machines_effect = (api: CoreApi, list: HTMLElement, status: HTMLElement): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const machines = (yield* Effect.tryPromise({ try: () => api.machines(), catch: (e) => e })).machines;
    yield* Effect.sync(() => {
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
            const revoke_one: Effect.Effect<void, unknown> = Effect.gen(function* () {
              yield* Effect.tryPromise({ try: () => api.revokeMachine(m.id), catch: (e) => e });
              yield* Effect.sync(() => {
                revokeBtn.disabled = true;
                presenceCell.textContent = "revoked";
              });
            }).pipe(
              Effect.catchAll((err: unknown) =>
                Effect.sync(() => {
                  presenceCell.textContent = friendly(err);
                  presenceCell.className = "err";
                }),
              ),
            );
            void run_promise(revoke_one);
          });
          void run_promise(check_presence_effect(api, m.id, presenceCell));
        } else {
          presenceCell.textContent = "—";
        }
      }
      list.append(table);
    });
  }).pipe(
    Effect.catchAll((err: unknown) =>
      Effect.sync(() => {
        status.textContent = friendly(err);
        status.className = "status err";
      }),
    ),
  );

const check_presence_effect = (api: CoreApi, machineId: string, cell: HTMLElement): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const me = yield* Effect.tryPromise({ try: () => api.me(), catch: (e) => e });
    const grant = yield* Effect.tryPromise({
      try: () =>
        api.issueGrant({
          audience: "ast-relay",
          scope: ["relay:connect"],
          ttlSeconds: 300,
          targetMachineId: machineId,
          cnf: ephemeralCnfJwk(),
        }),
      catch: (e) => e,
    });
    const { http } = relayDefaults();
    const p = yield* Effect.tryPromise({ try: () => fetchPresence(http, me.accountId, machineId, grant.token), catch: (e) => e });
    yield* Effect.sync(() => {
      cell.textContent = p.forgeOnline ? `online (${p.clients} browser${p.clients === 1 ? "" : "s"})` : "offline";
      cell.className = p.forgeOnline ? "ok" : "muted";
    });
  }).pipe(
    Effect.catchAll(() =>
      Effect.sync(() => {
        cell.textContent = "presence unavailable";
        cell.className = "muted";
      }),
    ),
  );

const ephemeralCnfJwk = (): { kty: "OKP"; crv: "Ed25519"; x: string } => newEphemeralCnf().jwk;

const claimForm = (api: CoreApi): HTMLElement => {
  const form = el("form", {});
  const label = el("label", { for: "claim-code" }, "Enrollment code");
  const input = el("input", { id: "claim-code", type: "text", required: "true", autocomplete: "off", maxlength: "8", placeholder: "ABCDEFGH" }) as HTMLInputElement;
  const btn = el("button", { type: "submit" }, "Claim into this account");
  const msg = el("p", { class: "status", role: "status" });
  form.append(label, input, btn, msg);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = input.value.trim().toUpperCase();
    const claim: Effect.Effect<void, unknown> = Effect.gen(function* () {
      yield* Effect.sync(() => {
        btn.disabled = true;
        msg.textContent = "Claiming…";
      });
      const res = yield* Effect.tryPromise({ try: () => api.claimEnrollment(code), catch: (err) => err });
      yield* Effect.sync(() => {
        msg.textContent = `Claimed enrollment ${res.enrollmentId}. Confirm it on the Forge — nothing is enrolled until the local operator approves your exact identity.`;
        msg.className = "status ok";
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
    void run_promise(claim);
  });
  return form;
};
