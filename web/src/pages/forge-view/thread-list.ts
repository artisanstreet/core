// Remote Forge threads (#/forge).
// Thread list: snapshot load + per-thread open buttons.

import { clear, el } from "../../ui.ts";
import { asThreadsPage } from "../../forge.ts";
import type { LiveFeed } from "../../live.ts";
import type { ConnCtl } from "./shared.ts";
import { threadTitle, tunnelGet, tunnelHint } from "./shared.ts";
import { openThread } from "./thread-detail.ts";

export async function openThreads(ctl: ConnCtl, view: HTMLElement): Promise<LiveFeed | null> {
  clear(view);
  const box = el("div", { class: "card" });
  box.append(el("h2", {}, "Threads"));
  const status = el("p", { class: "status muted", role: "status" }, "Loading snapshot…");
  box.append(status);
  view.append(box);
  const detail = el("div", {});
  view.append(detail);
  const session = ctl.current;
  if (!session) {
    status.textContent = "Not connected.";
    status.className = "status err";
    return null;
  }
  try {
    const state = (await tunnelGet(session, "/state")) as {
      threads?: unknown; projects?: Array<{ id?: unknown; name?: unknown; path?: unknown }>;
      waiting?: Array<{ id?: unknown; thread_id?: unknown }>; forge_version?: unknown; head?: unknown;
    };
    const threads = asThreadsPage({ threads: state.threads ?? [] }).threads;
    clear(box);
    box.append(el("h2", {}, "Threads"));
    box.append(el("p", { class: "muted small" },
      typeof state.forge_version === "string" ? `Forge ${state.forge_version}. ` : "",
      "Live updates stream over the tunnel; polling takes over if the stream drops.",
    ));
    if (threads.length === 0) {
      box.append(el("p", { class: "muted" }, "This Forge reports no threads."));
      return null;
    }
    const list = el("div", {});
    for (const t of threads) {
      const btn = el("button", { class: "secondary", type: "button" }, threadTitle(t));
      btn.addEventListener("click", () => {
        detail.replaceChildren();
        void openThread(ctl, detail, t);
      });
      list.append(el("div", {}, btn));
    }
    box.append(list);
    return null;
  } catch (err) {
    status.textContent = tunnelHint(err);
    status.className = "status err";
    return null;
  }
}
