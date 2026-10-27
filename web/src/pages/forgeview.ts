// Remote Forge threads (#/forge): pick an enrolled Forge, open a verified
// Noise channel through Relay, then read threads over the tunnel protocol
// (editor/crates/artisan-api/src/tunnel.rs + docs/plans/ast-account-wire.md:
// unary {id,method,path,body} calls, $bytes bodies, chunked transfers,
// SUBSCRIBE streams + UNSUBSCRIBE).
//
// Live updates stream over a dedicated tunnel channel (own Noise session,
// own grant; wire doc §6): SUBSCRIBE, then backlog + live envelopes with
// the standard `since` cursor, chunked when oversized. Reset re-subscribes
// from the last seen seq; end/error/Reset-storm falls back to cursor
// polling. Grants refresh before the 300 s TTL while the browser retains
// the Core session (new grant, new channel, re-handshake, re-subscribe).
//
// What is real here: the Core grant, Relay admission, the Noise handshake
// and every byte on the wire. When the Forge answers 404/501 on a tunnel
// path, this page says the Forge side is not there yet instead of faking.

import type { CoreApi } from "../api.ts";
import { ApiError } from "../api.ts";
import { clear, el, idSpan } from "../ui.ts";
import type { PageContext } from "../main.ts";
import { newEphemeralCnf } from "../relay-forge.ts";
import { fetchPresence, ForgeSession, ForgeStream, type ForgeSessionOptions, type Presence } from "../relay-forge.ts";
import { createPollingFeed, createStreamFeed, type LiveFeed } from "../live.ts";
import { relayDefaults } from "./machines.ts";
import { friendly } from "./signin.ts";
import {
  approvalAnswer,
  asItemsPage,
  asThreadsPage,
  asTunnelBytes,
  base64urlDecode,
  firstText,
  itemSummary,
  newRequestId,
  pendingApproval,
  pendingQuestions,
  questionAnswer,
  sendMessageBody,
  textOf,
  throwIfTunnelError,
  transcriptText,
  TRANSCRIPT_BODY_CAP,
  type ForgeItem,
  type ForgeThread,
  type StoredRef,
} from "../forge.ts";

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

/** Shared connection state so an open thread can refresh grants/channels. */
interface ConnCtl {
  opts: ForgeSessionOptions;
  current: ForgeSession | null;
}

async function tunnelGet(session: ForgeSession, path: string): Promise<unknown> {
  const res = await session.call({ method: "GET", path });
  return throwIfTunnelError(res).body;
}

async function openThreads(ctl: ConnCtl, view: HTMLElement): Promise<LiveFeed | null> {
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

function threadTitle(t: ForgeThread): string {
  const title = t.title?.trim();
  return title ? `${title} (${t.id})` : t.id;
}

/** Generation token: only the latest opened thread's feed may render. */
let threadGeneration = 0;

async function openThread(ctl: ConnCtl, detail: HTMLElement, thread: ForgeThread): Promise<void> {
  const gen = ++threadGeneration;
  const alive = () => gen === threadGeneration;
  const session0 = ctl.current;
  if (!session0) return;
  clear(detail);
  const box = el("div", { class: "card" });
  box.append(el("h2", {}, threadTitle(thread)));
  const status = el("p", { class: "status muted", role: "status" }, "Loading transcript…");
  box.append(status);
  detail.append(box);

  const itemsBox = el("div", {});
  let lastPos = 0;
  let lastEventSeq: number | null = null;
  // Object URLs created for transcript content (blob: images, downloads).
  // Blob bytes would otherwise be retained for the tab lifetime; every URL
  // below is revoked on replace, on load error, and on route disposal.
  const objectUrls = new Set<string>();
  const tracker: ObjectUrlTracker = {
    track: (u: string): void => {
      objectUrls.add(u);
    },
    release: (u: string | null): void => {
      if (u && objectUrls.delete(u)) {
        try {
          URL.revokeObjectURL(u);
        } catch {
          // Already revoked or never created: nothing retained either way.
        }
      }
    },
  };
  const releaseSubtreeUrls = (root: Element): void => {
    for (const img of root.querySelectorAll('img[src^="blob:"],a[href^="blob:"]')) {
      const src = img.getAttribute("src") ?? img.getAttribute("href");
      if (src) tracker.release(src);
    }
  };
  const renderNew = (items: ForgeItem[], session: ForgeSession) => {
    const fresh = items.filter((i) => (i.position ?? 0) > lastPos).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (const item of fresh) {
      lastPos = Math.max(lastPos, item.position ?? lastPos);
      const node = renderItem(session, thread.id, item, tracker);
      node.id = `item-${item.id}`;
      const prev = itemsBox.querySelector(`#${CSS.escape(node.id)}`);
      if (prev) {
        releaseSubtreeUrls(prev);
        prev.replaceWith(node);
      } else itemsBox.append(node);
    }
  };
  const renderReplace = (item: ForgeItem, session: ForgeSession) => {
    const node = renderItem(session, thread.id, item, tracker);
    node.id = `item-${item.id}`;
    const prev = itemsBox.querySelector(`#${CSS.escape(node.id)}`);
    if (prev) {
      releaseSubtreeUrls(prev);
      prev.replaceWith(node);
      lastPos = Math.max(lastPos, item.position ?? lastPos);
    } else {
      renderNew([item], session);
    }
  };

  const feedNote = el("p", { class: "muted small", role: "status" }, "Live updates: connecting…");
  const feedHolder: { feed: LiveFeed | null } = { feed: null };
  const stopFeed = () => {
    feedHolder.feed?.stop();
    feedHolder.feed = null;
  };

  const startPoll = (session: ForgeSession): LiveFeed => {
    const feed = createPollingFeed({
      threadPoll: async (after) => {
        const p = asItemsPage(
          await tunnelGet(session, `/threads/${encodeURIComponent(thread.id)}/transcript?after=${after}&limit=100`),
        );
        return p.items;
      },
      getAfter: () => lastPos,
      onItems: (items) => {
        if (alive()) renderNew(items, ctl.current ?? session);
      },
    });
    feed.start();
    return feed;
  };

  const startStream = (session: ForgeSession): LiveFeed => {
    const feed = createStreamFeed({
      open: (events) =>
        new ForgeStream({
          core: ctl.opts.core,
          relayWsUrl: ctl.opts.relayWsUrl,
          relayHttpUrl: ctl.opts.relayHttpUrl,
          accountId: ctl.opts.accountId,
          machineId: ctl.opts.machineId,
          forgeCnfX: ctl.opts.forgeCnfX,
          onEvent: (ev) => {
            if (ev.type === "error" && alive()) feedNote.textContent = `Stream notice: ${ev.message}`;
          },
          events,
        }),
      path: (since) => `/events?since=${since ?? 0}&thread=${encodeURIComponent(thread.id)}`,
      getSince: () => lastEventSeq,
      setSince: (seq) => {
        lastEventSeq = seq;
      },
      onEnvelope: (env) => {
        if (!alive()) return;
        if (env.type === "item") {
          const item = (env.event as { item?: unknown }).item as ForgeItem | undefined;
          const s = ctl.current;
          if (item && typeof item.id === "string" && item.thread_id === thread.id && s) renderReplace(item, s);
        }
      },
      onStreamLost: (message) => {
        if (!alive()) return;
        feedNote.textContent = `Live stream paused (${message}); polling instead.`;
        stopFeed();
        feedHolder.feed = startPoll(ctl.current ?? session);
      },
      onResetNotice: () => {
        if (alive()) feedNote.textContent = "Stream reset by the Forge; resuming from the last event.";
      },
    });
    feed.start();
    return feed;
  };

  /** Refresh grants + channels before the 300 s TTL while retained. */
  const reestablish = async (): Promise<void> => {
    if (!alive()) return;
    feedNote.textContent = "Refreshing encryption (grant about to expire)…";
    stopFeed();
    try {
      const ns = new ForgeSession(ctl.opts);
      await ns.connect();
      ctl.current?.close();
      ctl.current = ns;
      if (!alive()) {
        ns.close();
        return;
      }
      feedHolder.feed = startStream(ns);
      feedNote.textContent = "Live updates: streaming.";
    } catch (err) {
      if (alive()) {
        feedNote.textContent = `Refresh failed (${friendly(err)}); polling on the old channel.`;
        const s = ctl.current;
        if (s) feedHolder.feed = startPoll(s);
      }
    }
  };

  try {
    const page = asItemsPage(await tunnelGet(session0, `/threads/${encodeURIComponent(thread.id)}/transcript?limit=100`));
    if (!alive()) return;
    clear(box);
    box.append(el("h2", {}, threadTitle(thread)));
    box.append(feedNote);
    box.append(itemsBox);
    renderNew(page.items, session0);
    if (page.items.length === 0) box.append(el("p", { class: "muted" }, "No items in this thread yet."));
    box.append(sendBox(() => ctl.current, thread.id));
    const row = el("div", { class: "row" });
    const cancel = el("button", { class: "danger", type: "button" }, "Cancel the live run");
    const carry = el("button", { class: "secondary", type: "button" }, "Carry on with no new message");
    const cmsg = el("p", { class: "status small", role: "status" });
    const liveCall = (method: "POST", path: string) => {
      const s = ctl.current;
      if (!s) {
        cmsg.textContent = "Not connected.";
        return Promise.reject(new Error("Not connected."));
      }
      return s.call({ method, path }).then((r) => throwIfTunnelError(r));
    };
    cancel.addEventListener("click", () => {
      void (async () => {
        try {
          await liveCall("POST", `/threads/${encodeURIComponent(thread.id)}/cancel`);
          cmsg.textContent = "Cancel requested.";
        } catch (err) {
          cmsg.textContent = friendly(err);
        }
      })();
    });
    carry.addEventListener("click", () => {
      void (async () => {
        try {
          await liveCall("POST", `/threads/${encodeURIComponent(thread.id)}/continue`);
          cmsg.textContent = "Carrying on.";
        } catch (err) {
          cmsg.textContent = friendly(err);
        }
      })();
    });
    box.append(el("div", {}, cancel, " ", carry, cmsg));
    if (page.more) box.append(el("p", { class: "muted small" }, "Older items exist; this view shows the newest 100."));
  } catch (err) {
    if (!alive()) return;
    status.textContent = tunnelHint(err);
    status.className = "status err";
    return;
  }

  // Live updates: stream first (dedicated channel, own Noise session, own
  // grant), polling fallback if the Forge has no stream yet. Grants refresh
  // before the 300 s TTL while the browser retains the Core session.
  feedHolder.feed = startStream(session0);
  feedNote.textContent = "Live updates: streaming.";
  const watch = setInterval(() => {
    if (!alive() || !detail.isConnected) {
      stopFeed();
      clearInterval(watch);
      return;
    }
    const s = ctl.current;
    if (!s) return;
    if (s.needsRefresh() || feedHolder.feed?.needsRefresh?.()) void reestablish();
  }, 10_000);
}

/** Tracks blob: object URLs created for one open thread so they can be
 * revoked on replace, on load error, and on route disposal instead of
 * pinning transcript bytes for the tab lifetime. */
export interface ObjectUrlTracker {
  track(url: string): void;
  release(url: string | null): void;
}

function renderItem(session: ForgeSession, threadId: string, item: ForgeItem, onObjectUrl: ObjectUrlTracker): HTMLElement {
  const { kind, text } = itemSummary(item);
  const wrap = el("div", { class: "thread-item" });
  const head = el("div", { class: "kind" }, `${kind} · #${item.position ?? "?"} · `, idSpan(item.id));
  wrap.append(head);
  // Full contract-faithful body: every message part in defined order.
  // Over the render cap the rest hides behind an explicit Show-rest
  // control (in-DOM) or a download — never a silent cut.
  wrap.append(transcriptBody(session, threadId, item, onObjectUrl));
  void text;
  if (kind === "image") wrap.append(imageLoader(session, item.kind, onObjectUrl));
  const approval = pendingApproval(item.kind);
  if (approval) wrap.append(approvalBox(session, item.id, approval));
  const questions = pendingQuestions(item.kind);
  if (questions) wrap.append(questionsBox(session, item.id, questions));
  void threadId;
  return wrap;
}

/** Item body: full contract text with explicit expansion, never a silent cut. */
function transcriptBody(
  session: ForgeSession,
  threadId: string,
  item: ForgeItem,
  onObjectUrl: ObjectUrlTracker,
): HTMLElement {
  void threadId;
  const wrap = el("div", {});
  const t = transcriptText(item.kind);
  if (t.text) {
    if (t.text.length <= TRANSCRIPT_BODY_CAP) {
      wrap.append(el("div", { class: "thread-body" }, t.text));
    } else {
      const shown = el("div", { class: "thread-body" }, t.text.slice(0, TRANSCRIPT_BODY_CAP));
      const rest = el("div", { class: "thread-body", hidden: "true" }, t.text.slice(TRANSCRIPT_BODY_CAP));
      const show = el("button", { class: "secondary", type: "button" }, `Show rest (${((t.text.length - TRANSCRIPT_BODY_CAP) / 1024).toFixed(0)} KiB more)`);
      show.addEventListener("click", () => {
        rest.hidden = false;
        show.remove();
      });
      let dlUrl: string | null = null;
      const dl = el("a", { href: "#", download: `thread-item-${item.id}.txt` }, "Download full text");
      dl.addEventListener("click", (e) => {
        e.preventDefault();
        onObjectUrl.release(dlUrl);
        dlUrl = URL.createObjectURL(new Blob([t.text], { type: "text/plain;charset=utf-8" }));
        onObjectUrl.track(dlUrl);
        const a = el("a", { href: dlUrl, download: `thread-item-${item.id}.txt` }) as unknown as HTMLAnchorElement;
        document.body.append(a);
        a.click();
        a.remove();
      });
      wrap.append(shown, el("p", { class: "small" }, show, " · ", dl));
      wrap.append(rest);
    }
  }
  for (const n of t.notices) wrap.append(el("p", { class: "muted small" }, n));
  for (const s of t.stored) wrap.append(storedLoader(session, s));
  return wrap;
}

/** Stored text sources load explicitly via /content range reads. */
function storedLoader(session: ForgeSession, ref: StoredRef): HTMLElement {
  const wrap = el("div", {});
  const btn = el("button", { class: "secondary", type: "button" },
    `Load stored text (${ref.label}, ${(ref.bytes / 1024).toFixed(0)} KiB)`);
  const msg = el("p", { class: "status small", role: "status" });
  const out = el("div", { class: "thread-body" });
  let offset = 0;
  let total = ref.bytes;
  const load = () => {
    void (async () => {
      btn.disabled = true;
      try {
        const body = (await tunnelGet(session, `/content/${encodeURIComponent(ref.id)}?offset=${offset}&limit=131072`)) as {
          text?: unknown; end?: unknown; total?: unknown;
        };
        if (typeof body.text !== "string") throw new Error("Forge did not return text.");
        out.textContent += body.text;
        if (typeof body.end === "number") offset = body.end;
        else offset += body.text.length;
        if (typeof body.total === "number") total = body.total;
        if (offset < total) {
          btn.disabled = false;
          msg.textContent = `Loaded ${(offset / 1024).toFixed(0)} of ${(total / 1024).toFixed(0)} KiB — load more.`;
        } else {
          msg.textContent = "";
          btn.remove();
        }
      } catch (err) {
        msg.textContent = friendly(err);
        btn.disabled = false;
      }
    })();
  };
  btn.addEventListener("click", load);
  wrap.append(el("p", { class: "muted small" }, `Long text lives in the Forge store (${ref.label}).`), btn, msg, out);
  return wrap;
}

/** `Image` items carry a blob hash; bytes load on explicit press ($bytes). */
function imageLoader(session: ForgeSession, kind: unknown, onObjectUrl: ObjectUrlTracker): HTMLElement {
  const wrap = el("div", {});
  const k = kind as Record<string, unknown>;
  const hash = typeof k.blob === "string" ? k.blob : null;
  if (typeof k.caption === "string" && k.caption) wrap.append(el("p", { class: "muted" }, k.caption));
  if (!hash) {
    wrap.append(el("p", { class: "muted small" }, "Image has no retrievable bytes."));
    return wrap;
  }
  const btn = el("button", { class: "secondary", type: "button" }, "Load image");
  const msg = el("p", { class: "status small", role: "status" });
  let currentUrl: string | null = null;
  btn.addEventListener("click", () => {
    void (async () => {
      try {
        const res = await session.call({ method: "GET", path: `/blobs/${encodeURIComponent(hash)}` });
        const ok = throwIfTunnelError(res);
        const env = asTunnelBytes(ok.body);
        if (!env) throw new Error("Forge did not return image bytes.");
        const bytes = base64urlDecode(env.b64u);
        onObjectUrl.release(currentUrl);
        currentUrl = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: env.content_type }));
        onObjectUrl.track(currentUrl);
        const img = el("img", { src: currentUrl, alt: "Forge image" }) as HTMLImageElement;
        img.style.maxWidth = "100%";
        wrap.append(img);
        btn.remove();
        msg.textContent = "";
      } catch (err) {
        onObjectUrl.release(currentUrl);
        currentUrl = null;
        msg.textContent = friendly(err);
      }
    })();
  });
  wrap.append(btn, msg);
  return wrap;
}

function approvalBox(session: ForgeSession, itemId: string, approval: { request: unknown; reason: string | null; options: string[] }): HTMLElement {
  const wrap = el("div", {});
  wrap.append(el("p", {}, el("strong", {}, "Waiting on your decision.")));
  if (approval.reason) wrap.append(el("p", { class: "muted" }, approval.reason));
  const req = approval.request;
  if (typeof req === "object" && req !== null) {
    const r = req as Record<string, unknown>;
    const desc = textOf((r.command as Record<string, unknown> | undefined)?.command ?? r.description) ?? firstText(req);
    if (desc) wrap.append(el("p", { class: "mono small" }, desc));
  }
  const msg = el("p", { class: "status small", role: "status" });
  const options = approval.options.length > 0 ? approval.options : ["allow_once", "deny_once"];
  for (const opt of options) {
    const b = el("button", opt.startsWith("allow") ? { type: "button" } : { class: "secondary", type: "button" }, labelFor(opt));
    b.addEventListener("click", () => {
      void (async () => {
        try {
          await session
            .call({ method: "POST", path: `/items/${encodeURIComponent(itemId)}/answer`, body: approvalAnswer(opt) })
            .then((r) => throwIfTunnelError(r));
          msg.textContent = `Answered: ${opt}.`;
        } catch (err) {
          msg.textContent = friendly(err);
        }
      })();
    });
    wrap.append(b, " ");
  }
  wrap.append(msg);
  return wrap;
}

function labelFor(opt: string): string {
  switch (opt) {
    case "allow_once": return "Allow once";
    case "allow_always": return "Always allow";
    case "deny_once": return "Deny once";
    case "deny_always": return "Always deny";
    default: return opt;
  }
}

function questionsBox(session: ForgeSession, itemId: string, pending: { blocking: boolean; questions: Array<{ id: string; header: string | null; text: string | null; multiSelect: boolean; options: Array<{ id: string; label: string; description: string | null }> }> }): HTMLElement {
  const wrap = el("div", {});
  wrap.append(el("p", {}, el("strong", {}, pending.blocking ? "The engine is waiting on answers." : "Questions from the engine:")));
  const picks = new Map<string, Set<string>>();
  const texts = new Map<string, string>();
  for (const q of pending.questions) {
    picks.set(q.id, new Set());
    wrap.append(el("p", {}, (q.header ? `${q.header}: ` : "") + (q.text ?? q.id)));
    for (const o of q.options) {
      const id = `q-${itemId}-${q.id}-${o.id}`;
      const box = el("input", { id, type: q.multiSelect ? "checkbox" : "radio", value: o.id }) as HTMLInputElement;
      box.setAttribute("name", `q-${itemId}-${q.id}`);
      box.addEventListener("change", () => {
        const set = picks.get(q.id);
        if (!set) return;
        if (!q.multiSelect) set.clear();
        if (box.checked) set.add(o.id);
        else set.delete(o.id);
      });
      const lab = el("label", { for: id }, `${o.label}${o.description ? ` — ${o.description}` : ""}`);
      wrap.append(el("div", {}, box, lab));
    }
    const tLabel = el("label", { for: `t-${itemId}-${q.id}` }, "Or answer in your own words (optional)");
    const t = el("input", { id: `t-${itemId}-${q.id}`, type: "text" }) as HTMLInputElement;
    t.addEventListener("input", () => texts.set(q.id, t.value));
    wrap.append(tLabel, t);
  }
  const msg = el("p", { class: "status small", role: "status" });
  const send = el("button", { type: "button" }, "Send answers");
  send.addEventListener("click", () => {
    void (async () => {
      try {
        const answers = pending.questions.map((q) => {
          const free = (texts.get(q.id) ?? "").trim();
          const chosen = [...(picks.get(q.id) ?? [])];
          if (free && chosen.length === 0) return { text: free };
          if (chosen.length > 0) return chosen;
          return null;
        });
        await session
          .call({ method: "POST", path: `/items/${encodeURIComponent(itemId)}/answer`, body: questionAnswer(answers) })
          .then((r) => throwIfTunnelError(r));
        msg.textContent = "Answers sent.";
      } catch (err) {
        msg.textContent = friendly(err);
      }
    })();
  });
  wrap.append(send, msg);
  return wrap;
}

function sendBox(getSession: () => ForgeSession | null, threadId: string): HTMLElement {
  const wrap = el("div", {});
  const label = el("label", { for: `send-${threadId}` }, "Send a message");
  const input = el("textarea", { id: `send-${threadId}`, placeholder: "Write to the thread…" }) as HTMLTextAreaElement;
  const btn = el("button", { type: "button" }, "Send");
  const msg = el("p", { class: "status small", role: "status" });
  btn.addEventListener("click", () => {
    void (async () => {
      const text = input.value;
      if (!text.trim()) {
        msg.textContent = "Write something first.";
        return;
      }
      const session = getSession();
      if (!session) {
        msg.textContent = "Not connected.";
        return;
      }
      btn.disabled = true;
      try {
        // Client-made id: a retried send is the same message.
        const res = await session.call({
          method: "POST",
          path: `/threads/${encodeURIComponent(threadId)}/messages`,
          body: sendMessageBody(newRequestId(), text),
        });
        throwIfTunnelError(res);
        input.value = "";
        msg.textContent = "Sent.";
      } catch (err) {
        msg.textContent = friendly(err);
      } finally {
        btn.disabled = false;
      }
    })();
  });
  wrap.append(label, input, btn, msg);
  return wrap;
}

/** Tunnel failures name the transport honestly: 404/501 means the Forge side is not there yet. */
function tunnelHint(err: unknown): string {
  if (err instanceof ApiError) return friendly(err);
  const t = (err as { tunnelStatus?: number }).tunnelStatus;
  if (t === 404 || t === 501) {
    return "This Forge does not serve that path over the tunnel yet (the Rust tunnel endpoint is still landing). The encrypted channel itself is open — try again after the Forge updates.";
  }
  return friendly(err);
}
