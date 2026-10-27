import { Effect, Either, Match } from "effect";
import { clear, el, idSpan } from "../../ui.ts";
import { run_promise } from "../../core/run-promise.ts";
import { friendly } from "../signin.ts";
import {
  approvalAnswer,
  asItemsPage,
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

let threadGeneration = 0;

export const openThread = (ctl: ConnCtl, detail: HTMLElement, thread: ForgeThread): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const gen = ++threadGeneration;
    const alive = () => gen === threadGeneration;
    const session0 = ctl.current;
    if (!session0) return;
    const box = el("div", { class: "card" });
    box.append(el("h2", {}, threadTitle(thread)));
    const status = el("p", { class: "status muted", role: "status" }, "Loading transcript…");
    box.append(status);
    yield* Effect.sync(() => {
      clear(detail);
      detail.append(box);
    });

    const itemsBox = el("div", {});
    let lastPos = 0;
    let lastEventSeq: number | null = null;
    const objectUrls = new Set<string>();
    const release_url = (u: string | null): void => {
      if (u && objectUrls.delete(u)) {
        Either.getOrNull(Either.try({ try: () => URL.revokeObjectURL(u), catch: () => null }));
      }
    };
    const tracker: ObjectUrlTracker = {
      track: (u: string): void => {
        objectUrls.add(u);
      },
      release: (u: string | null): void => {
        release_url(u);
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
        threadPoll: (after) =>
          run_promise(
            Effect.gen(function* () {
              const raw = yield* Effect.tryPromise({
                try: () => tunnelGet(session, `/threads/${encodeURIComponent(thread.id)}/transcript?after=${after}&limit=100`),
                catch: (e) => e,
              });
              const p = yield* Effect.try({ try: () => asItemsPage(raw), catch: (e) => e });
              return p.items;
            }).pipe(Effect.orElseSucceed(() => [])),
          ),
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

    const reestablish_effect = Effect.gen(function* () {
      if (!alive()) return;
      yield* Effect.sync(() => {
        feedNote.textContent = "Refreshing encryption (grant about to expire)…";
        stopFeed();
      });
      const ns = new ForgeSession(ctl.opts);
      const connected = yield* Effect.either(Effect.tryPromise({ try: () => ns.connect(), catch: (e) => e }));
      if (connected._tag === "Left") {
        yield* Effect.sync(() => {
          if (!alive()) return;
          feedNote.textContent = `Refresh failed (${friendly(connected.left)}); polling on the old channel.`;
          const s = ctl.current;
          if (s) feedHolder.feed = startPoll(s);
        });
        return;
      }
      yield* Effect.sync(() => {
        ctl.current?.close();
        ctl.current = ns;
        if (!alive()) {
          ns.close();
          return;
        }
        feedHolder.feed = startStream(ns);
        feedNote.textContent = "Live updates: streaming.";
      });
    }).pipe(Effect.catchAll(() => Effect.void));

    const page = yield* Effect.tryPromise({
      try: () => tunnelGet(session0, `/threads/${encodeURIComponent(thread.id)}/transcript?limit=100`),
      catch: (e) => e,
    }).pipe(
      Effect.flatMap((raw) => Effect.try({ try: () => asItemsPage(raw), catch: (e) => e })),
      Effect.catchAll((err) =>
        Effect.sync(() => {
          if (!alive()) return null;
          status.textContent = tunnelHint(err);
          status.className = "status err";
          return null;
        }),
      ),
    );
    if (page === null) return;
    if (!alive()) return;
    yield* Effect.sync(() => {
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
      const liveCall = (method: "POST", path: string) =>
        Effect.gen(function* () {
          const s = ctl.current;
          if (!s) {
            yield* Effect.sync(() => {
              cmsg.textContent = "Not connected.";
            });
            return yield* Effect.fail(new Error("Not connected."));
          }
          const res = yield* Effect.tryPromise({ try: () => s.call({ method, path }), catch: (e) => e });
          yield* Effect.try({ try: () => throwIfTunnelError(res), catch: (e) => e });
        });
      cancel.addEventListener("click", () => {
        const program = liveCall("POST", `/threads/${encodeURIComponent(thread.id)}/cancel`).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cmsg.textContent = "Cancel requested.";
            }),
          ),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              cmsg.textContent = friendly(err);
            }),
          ),
        );
        void run_promise(program);
      });
      carry.addEventListener("click", () => {
        const program = liveCall("POST", `/threads/${encodeURIComponent(thread.id)}/continue`).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cmsg.textContent = "Carrying on.";
            }),
          ),
          Effect.catchAll((err) =>
            Effect.sync(() => {
              cmsg.textContent = friendly(err);
            }),
          ),
        );
        void run_promise(program);
      });
      box.append(el("div", {}, cancel, " ", carry, cmsg));
      if (page.more) box.append(el("p", { class: "muted small" }, "Older items exist; this view shows the newest 100."));
    });

    yield* Effect.sync(() => {
      feedHolder.feed = startStream(session0);
      feedNote.textContent = "Live updates: streaming.";
    });
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
            yield* reestablish_effect;
          }
        }),
      ).pipe(Effect.catchAll(() => Effect.void)),
    );
    void watch_fiber;
  }).pipe(
    Effect.catchAll(() => Effect.void),
  );

export interface ObjectUrlTracker {
  track(url: string): void;
  release(url: string | null): void;
}

const renderItem = (session: ForgeSession, threadId: string, item: ForgeItem, onObjectUrl: ObjectUrlTracker): HTMLElement => {
  const { kind, text } = itemSummary(item);
  const wrap = el("div", { class: "thread-item" });
  const head = el("div", { class: "kind" }, `${kind} · #${item.position ?? "?"} · `, idSpan(item.id));
  wrap.append(head);
  wrap.append(transcriptBody(session, threadId, item, onObjectUrl));
  void text;
  if (kind === "image") wrap.append(imageLoader(session, item.kind, onObjectUrl));
  const approval = pendingApproval(item.kind);
  if (approval) wrap.append(approvalBox(session, item.id, approval));
  const questions = pendingQuestions(item.kind);
  if (questions) wrap.append(questionsBox(session, item.id, questions));
  void threadId;
  return wrap;
};

const transcriptBody = (
  session: ForgeSession,
  threadId: string,
  item: ForgeItem,
  onObjectUrl: ObjectUrlTracker,
): HTMLElement => {
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
};

const storedLoader = (session: ForgeSession, ref: StoredRef): HTMLElement => {
  const wrap = el("div", {});
  const btn = el("button", { class: "secondary", type: "button" },
    `Load stored text (${ref.label}, ${(ref.bytes / 1024).toFixed(0)} KiB)`);
  const msg = el("p", { class: "status small", role: "status" });
  const out = el("div", { class: "thread-body" });
  let offset = 0;
  let total = ref.bytes;
  const load = () => {
    const program = Effect.gen(function* () {
      yield* Effect.sync(() => {
        btn.disabled = true;
      });
      const body = (yield* Effect.tryPromise({
        try: () => tunnelGet(session, `/content/${encodeURIComponent(ref.id)}?offset=${offset}&limit=131072`),
        catch: (e) => e,
      })) as {
        text?: unknown; end?: unknown; total?: unknown;
      };
      const text = yield* Effect.try({
        try: () => {
          if (typeof body.text !== "string") throw new Error("Forge did not return text.");
          return body.text;
        },
        catch: (e) => e,
      });
      yield* Effect.sync(() => {
        out.textContent += text;
        if (typeof body.end === "number") offset = body.end;
        else offset += text.length;
        if (typeof body.total === "number") total = body.total;
        if (offset < total) {
          btn.disabled = false;
          msg.textContent = `Loaded ${(offset / 1024).toFixed(0)} of ${(total / 1024).toFixed(0)} KiB — load more.`;
        } else {
          msg.textContent = "";
          btn.remove();
        }
      });
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          msg.textContent = friendly(err);
          btn.disabled = false;
        }),
      ),
    );
    void run_promise(program);
  };
  btn.addEventListener("click", load);
  wrap.append(el("p", { class: "muted small" }, `Long text lives in the Forge store (${ref.label}).`), btn, msg, out);
  return wrap;
};

const imageLoader = (session: ForgeSession, kind: unknown, onObjectUrl: ObjectUrlTracker): HTMLElement => {
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
    const program = Effect.gen(function* () {
      const res = yield* Effect.tryPromise({
        try: () => session.call({ method: "GET", path: `/blobs/${encodeURIComponent(hash)}` }),
        catch: (e) => e,
      });
      const ok = yield* Effect.try({ try: () => throwIfTunnelError(res), catch: (e) => e });
      const env = yield* Effect.try({
        try: () => {
          const parsed = asTunnelBytes(ok.body);
          if (!parsed) throw new Error("Forge did not return image bytes.");
          return parsed;
        },
        catch: (e) => e,
      });
      const bytes = yield* Effect.try({ try: () => base64urlDecode(env.b64u), catch: (e) => e });
      yield* Effect.sync(() => {
        onObjectUrl.release(currentUrl);
        currentUrl = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: env.content_type }));
        onObjectUrl.track(currentUrl);
        const img = el("img", { src: currentUrl, alt: "Forge image" }) as HTMLImageElement;
        img.style.maxWidth = "100%";
        wrap.append(img);
        btn.remove();
        msg.textContent = "";
      });
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          onObjectUrl.release(currentUrl);
          currentUrl = null;
          msg.textContent = friendly(err);
        }),
      ),
    );
    void run_promise(program);
  });
  wrap.append(btn, msg);
  return wrap;
};

const approvalBox = (session: ForgeSession, itemId: string, approval: { request: unknown; reason: string | null; options: string[] }): HTMLElement => {
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
      const program = Effect.gen(function* () {
        const res = yield* Effect.tryPromise({
          try: () => session.call({ method: "POST", path: `/items/${encodeURIComponent(itemId)}/answer`, body: approvalAnswer(opt) }),
          catch: (e) => e,
        });
        yield* Effect.try({ try: () => throwIfTunnelError(res), catch: (e) => e });
        yield* Effect.sync(() => {
          msg.textContent = `Answered: ${opt}.`;
        });
      }).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            msg.textContent = friendly(err);
          }),
        ),
      );
      void run_promise(program);
    });
    wrap.append(b, " ");
  }
  wrap.append(msg);
  return wrap;
};

const labelFor = (opt: string): string =>
  Match.value(opt).pipe(
    Match.when("allow_once", () => "Allow once"),
    Match.when("allow_always", () => "Always allow"),
    Match.when("deny_once", () => "Deny once"),
    Match.when("deny_always", () => "Always deny"),
    Match.orElse(() => opt),
  );

const questionsBox = (session: ForgeSession, itemId: string, pending: { blocking: boolean; questions: Array<{ id: string; header: string | null; text: string | null; multiSelect: boolean; options: Array<{ id: string; label: string; description: string | null }> }> }): HTMLElement => {
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
    const program = Effect.gen(function* () {
      const answers = pending.questions.map((q) => {
        const free = (texts.get(q.id) ?? "").trim();
        const chosen = [...(picks.get(q.id) ?? [])];
        if (free && chosen.length === 0) return { text: free };
        if (chosen.length > 0) return chosen;
        return null;
      });
      const res = yield* Effect.tryPromise({
        try: () => session.call({ method: "POST", path: `/items/${encodeURIComponent(itemId)}/answer`, body: questionAnswer(answers) }),
        catch: (e) => e,
      });
      yield* Effect.try({ try: () => throwIfTunnelError(res), catch: (e) => e });
      yield* Effect.sync(() => {
        msg.textContent = "Answers sent.";
      });
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          msg.textContent = friendly(err);
        }),
      ),
    );
    void run_promise(program);
  });
  wrap.append(send, msg);
  return wrap;
};

const sendBox = (getSession: () => ForgeSession | null, threadId: string): HTMLElement => {
  const wrap = el("div", {});
  const label = el("label", { for: `send-${threadId}` }, "Send a message");
  const input = el("textarea", { id: `send-${threadId}`, placeholder: "Write to the thread…" }) as HTMLTextAreaElement;
  const btn = el("button", { type: "button" }, "Send");
  const msg = el("p", { class: "status small", role: "status" });
  btn.addEventListener("click", () => {
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
    const program = Effect.gen(function* () {
      yield* Effect.sync(() => {
        btn.disabled = true;
      });
      const res = yield* Effect.tryPromise({
        try: () =>
          session.call({
            method: "POST",
            path: `/threads/${encodeURIComponent(threadId)}/messages`,
            body: sendMessageBody(newRequestId(), text),
          }),
        catch: (e) => e,
      });
      yield* Effect.try({ try: () => throwIfTunnelError(res), catch: (e) => e });
      yield* Effect.sync(() => {
        input.value = "";
        msg.textContent = "Sent.";
      });
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          msg.textContent = friendly(err);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          btn.disabled = false;
        }),
      ),
    );
    void run_promise(program);
  });
  wrap.append(label, input, btn, msg);
  return wrap;
};
