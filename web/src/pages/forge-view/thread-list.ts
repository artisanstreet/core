import { Effect } from "effect";
import { clear, el } from "../../ui.ts";
import { run_promise } from "../../core/run-promise.ts";
import { asThreadsPage } from "../../forge.ts";
import type { LiveFeed } from "../../live.ts";
import type { ConnCtl } from "./shared.ts";
import { threadTitle, tunnelGet, tunnelHint } from "./shared.ts";
import { openThread } from "./thread-detail.ts";

export const openThreads = (ctl: ConnCtl, view: HTMLElement): Effect.Effect<LiveFeed | null, never> =>
  Effect.gen(function* () {
    const box = el("div", { class: "card" });
    box.append(el("h2", {}, "Threads"));
    const status = el("p", { class: "status muted", role: "status" }, "Loading snapshot…");
    box.append(status);
    const detail = el("div", {});
    yield* Effect.sync(() => {
      clear(view);
      view.append(box, detail);
    });
    const session = ctl.current;
    if (!session) {
      yield* Effect.sync(() => {
        status.textContent = "Not connected.";
        status.className = "status err";
      });
      return null;
    }
    const state = (yield* Effect.tryPromise({
      try: () => tunnelGet(session, "/state"),
      catch: (e) => e,
    })) as {
      threads?: unknown;
      forge_version?: unknown;
    };
    const threads = yield* Effect.try({
      try: () => asThreadsPage({ threads: state.threads ?? [] }).threads,
      catch: (e) => e,
    });
    yield* Effect.sync(() => {
      clear(box);
      box.append(el("h2", {}, "Threads"));
      box.append(el("p", { class: "muted small" },
        typeof state.forge_version === "string" ? `Forge ${state.forge_version}. ` : "",
        "Live updates stream over the tunnel; polling takes over if the stream drops.",
      ));
      if (threads.length === 0) {
        box.append(el("p", { class: "muted" }, "This Forge reports no threads."));
        return;
      }
      const list = el("div", {});
      for (const t of threads) {
        const btn = el("button", { class: "secondary", type: "button" }, threadTitle(t));
        btn.addEventListener("click", () => {
          detail.replaceChildren();
          void run_promise(openThread(ctl, detail, t));
        });
        list.append(el("div", {}, btn));
      }
      box.append(list);
    });
    return null;
  }).pipe(
    Effect.catchAll((err) =>
      Effect.sync(() => {
        const card = view.querySelector(".card");
        const existing = card?.querySelector(".status");
        if (existing) {
          existing.textContent = tunnelHint(err);
          existing.className = "status err";
        } else if (card) {
          card.append(el("p", { class: "status err" }, tunnelHint(err)));
        } else {
          clear(view);
          view.append(el("div", { class: "card" }, el("p", { class: "status err" }, tunnelHint(err))));
        }
        return null as LiveFeed | null;
      }),
    ),
  );
