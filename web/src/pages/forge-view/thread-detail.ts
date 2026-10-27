// Remote Forge threads (#/forge).
// Thread detail: transcript, live feed wiring, item renderers, send box.
// Owns the object-URL tracker (blob: cleanup on replace/route disposal).

import { Effect } from "effect";
import { clear, el, idSpan } from "../../ui.ts";
import { friendly } from "../signin.ts";
import {
  approvalAnswer,
  asItemsPage,
  asLiveEnvelope,
  asStreamEvent,
  asStreamStart,
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
} from "../../forge.ts";
import type { LiveFeed } from "../../live.ts";
import { createPollingFeed, createStreamFeed } from "../../live.ts";
import { ForgeSession, ForgeStream } from "../../relay-forge.ts";
import type { ConnCtl } from "./shared.ts";
import { tunnelGet, tunnelHint } from "./shared.ts";
import { threadTitle } from "./shared.ts";

/** Generation token: only the latest opened thread's feed may render. */
let threadGeneration = 0;

export async function openThread(ctl: ConnCtl, detail: HTMLElement, thread: ForgeThread): Promise<void> {
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
  // Refresh watcher as an Effect loop (spaced 10 s, no raw setInterval):
  // the fiber is interrupted when the thread is replaced or detached.
  feedHolder.feed = startStream(session0);
  feedNote.textContent = "Live updates: streaming.";
  const watch_fiber = Effect.runFork(
    Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep("10 seconds");
        if (!alive() || !detail.isConnected) {
          yield* Effect.sync(stopFeed);
          return yield* Effect.interrupt;
        }
        const s = ctl.current;
        if (!s) return;
        if (s.needsRefresh() || feedHolder.feed?.needsRefresh?.()) {
          yield* Effect.promise(() => reestablish());
        }
      }),
    ).pipe(Effect.catchAll(() => Effect.void)),
  );
  void watch_fiber;
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
