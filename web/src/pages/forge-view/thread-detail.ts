import { Effect, Either, Match } from "effect";
import { base64urlnopad as base64url_nopad } from "@scure/base";
import { clear, el, id_span } from "../../ui.ts";
import { run_promise } from "../../core/run-promise.ts";
import { friendly } from "../signin.ts";
import {
  approval_answer,
  as_items_page,
  as_tunnel_bytes,
  first_text,
  item_summary,
  new_request_id,
  pending_approval,
  pending_questions,
  question_answer,
  send_message_body,
  text_of,
  throw_if_tunnel_error,
  transcript_text,
  TRANSCRIPT_BODY_CAP,
  type ForgeItem,
  type ForgeThread,
  type StoredRef,
} from "../../forge.ts";
import type { LiveFeed } from "../../live.ts";
import { create_polling_feed, create_stream_feed } from "../../live.ts";
import { ForgeSession, ForgeStream } from "../../relay-forge.ts";
import type { ConnCtl } from "./shared.ts";
import { tunnel_get, tunnel_hint } from "./shared.ts";
import { thread_title } from "./shared.ts";

let thread_generation = 0;

export const open_thread = (ctl: ConnCtl, detail: HTMLElement, thread: ForgeThread): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const gen = ++thread_generation;
    const alive = () => gen === thread_generation;
    const session0 = ctl.current;
    if (!session0) return;
    const box = el("div", { class: "card" });
    box.append(el("h2", {}, thread_title(thread)));
    const status = el("p", { class: "status muted", role: "status" }, "Loading transcript…");
    box.append(status);
    yield* Effect.sync(() => {
      clear(detail);
      detail.append(box);
    });

    const items_box = el("div", {});
    let last_pos = 0;
    let last_event_seq: number | null = null;
    const object_urls = new Set<string>();
    const release_url = (u: string | null): void => {
      if (u && object_urls.delete(u)) {
        Either.getOrNull(Either.try({ try: () => URL.revokeObjectURL(u), catch: () => null }));
      }
    };
    const tracker: ObjectUrlTracker = {
      track: (u: string): void => {
        object_urls.add(u);
      },
      release: (u: string | null): void => {
        release_url(u);
      },
    };
    const release_subtree_urls = (root: Element): void => {
      for (const img of root.querySelectorAll('img[src^="blob:"],a[href^="blob:"]')) {
        const src = img.getAttribute("src") ?? img.getAttribute("href");
        if (src) tracker.release(src);
      }
    };
    const render_new = (items: ForgeItem[], session: ForgeSession) => {
      const fresh = items.filter((i) => (i.position ?? 0) > last_pos).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      for (const item of fresh) {
        last_pos = Math.max(last_pos, item.position ?? last_pos);
        const node = render_item(session, thread.id, item, tracker);
        node.id = `item-${item.id}`;
        const prev = items_box.querySelector(`#${CSS.escape(node.id)}`);
        if (prev) {
          release_subtree_urls(prev);
          prev.replaceWith(node);
        } else items_box.append(node);
      }
    };
    const render_replace = (item: ForgeItem, session: ForgeSession) => {
      const node = render_item(session, thread.id, item, tracker);
      node.id = `item-${item.id}`;
      const prev = items_box.querySelector(`#${CSS.escape(node.id)}`);
      if (prev) {
        release_subtree_urls(prev);
        prev.replaceWith(node);
        last_pos = Math.max(last_pos, item.position ?? last_pos);
      } else {
        render_new([item], session);
      }
    };

    const feed_note = el("p", { class: "muted small", role: "status" }, "Live updates: connecting…");
    const feed_holder: { feed: LiveFeed | null } = { feed: null };
    const stop_feed = () => {
      feed_holder.feed?.stop();
      feed_holder.feed = null;
    };

    const start_poll = (session: ForgeSession): LiveFeed => {
      const feed = create_polling_feed({
        thread_poll: (after) =>
          run_promise(
            Effect.gen(function* () {
              const raw = yield* Effect.tryPromise({
                try: () => tunnel_get(session, `/threads/${encodeURIComponent(thread.id)}/transcript?after=${after}&limit=100`),
                catch: (e) => e,
              });
              const p = yield* Effect.try({ try: () => as_items_page(raw), catch: (e) => e });
              return p.items;
            }).pipe(Effect.orElseSucceed(() => [])),
          ),
        get_after: () => last_pos,
        on_items: (items) => {
          if (alive()) render_new(items, ctl.current ?? session);
        },
      });
      feed.start();
      return feed;
    };

    const start_stream = (session: ForgeSession): LiveFeed => {
      const feed = create_stream_feed({
        open: (events) =>
          new ForgeStream({
            core: ctl.opts.core,
            relay_ws_url: ctl.opts.relay_ws_url,
            relay_http_url: ctl.opts.relay_http_url,
            account_id: ctl.opts.account_id,
            machine_id: ctl.opts.machine_id,
            forge_cnf_x: ctl.opts.forge_cnf_x,
            on_event: (ev) => {
              if (ev.type === "error" && alive()) feed_note.textContent = `Stream notice: ${ev.message}`;
            },
            events,
          }),
        path: (since) => `/events?since=${since ?? 0}&thread=${encodeURIComponent(thread.id)}`,
        get_since: () => last_event_seq,
        set_since: (seq) => {
          last_event_seq = seq;
        },
        on_envelope: (env) => {
          if (!alive()) return;
          if (env.type === "item") {
            const item = (env.event as { item?: unknown }).item as ForgeItem | undefined;
            const s = ctl.current;
            if (item && typeof item.id === "string" && item.thread_id === thread.id && s) render_replace(item, s);
          }
        },
        on_stream_lost: (message) => {
          if (!alive()) return;
          feed_note.textContent = `Live stream paused (${message}); polling instead.`;
          stop_feed();
          feed_holder.feed = start_poll(ctl.current ?? session);
        },
        on_reset_notice: () => {
          if (alive()) feed_note.textContent = "Stream reset by the Forge; resuming from the last event.";
        },
      });
      feed.start();
      return feed;
    };

    const reestablish_effect = Effect.gen(function* () {
      if (!alive()) return;
      yield* Effect.sync(() => {
        feed_note.textContent = "Refreshing encryption (grant about to expire)…";
        stop_feed();
      });
      const ns = new ForgeSession(ctl.opts);
      const connected = yield* Effect.either(Effect.tryPromise({ try: () => ns.connect(), catch: (e) => e }));
      if (connected._tag === "Left") {
        yield* Effect.sync(() => {
          if (!alive()) return;
          feed_note.textContent = `Refresh failed (${friendly(connected.left)}); polling on the old channel.`;
          const s = ctl.current;
          if (s) feed_holder.feed = start_poll(s);
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
        feed_holder.feed = start_stream(ns);
        feed_note.textContent = "Live updates: streaming.";
      });
    }).pipe(Effect.catchAll(() => Effect.void));

    const page = yield* Effect.tryPromise({
      try: () => tunnel_get(session0, `/threads/${encodeURIComponent(thread.id)}/transcript?limit=100`),
      catch: (e) => e,
    }).pipe(
      Effect.flatMap((raw) => Effect.try({ try: () => as_items_page(raw), catch: (e) => e })),
      Effect.catchAll((err) =>
        Effect.sync(() => {
          if (!alive()) return null;
          status.textContent = tunnel_hint(err);
          status.className = "status err";
          return null;
        }),
      ),
    );
    if (page === null) return;
    if (!alive()) return;
    yield* Effect.sync(() => {
      clear(box);
      box.append(el("h2", {}, thread_title(thread)));
      box.append(feed_note);
      box.append(items_box);
      render_new(page.items, session0);
      if (page.items.length === 0) box.append(el("p", { class: "muted" }, "No items in this thread yet."));
      box.append(send_box(() => ctl.current, thread.id));
      const row = el("div", { class: "row" });
      const cancel = el("button", { class: "danger", type: "button" }, "Cancel the live run");
      const carry = el("button", { class: "secondary", type: "button" }, "Carry on with no new message");
      const cmsg = el("p", { class: "status small", role: "status" });
      const live_call = (method: "POST", path: string) =>
        Effect.gen(function* () {
          const s = ctl.current;
          if (!s) {
            yield* Effect.sync(() => {
              cmsg.textContent = "Not connected.";
            });
            return yield* Effect.fail(new Error("Not connected."));
          }
          const res = yield* Effect.tryPromise({ try: () => s.call({ method, path }), catch: (e) => e });
          yield* Effect.try({ try: () => throw_if_tunnel_error(res), catch: (e) => e });
        });
      cancel.addEventListener("click", () => {
        const program = live_call("POST", `/threads/${encodeURIComponent(thread.id)}/cancel`).pipe(
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
        const program = live_call("POST", `/threads/${encodeURIComponent(thread.id)}/continue`).pipe(
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
      feed_holder.feed = start_stream(session0);
      feed_note.textContent = "Live updates: streaming.";
    });
    const watch_fiber = Effect.runFork(
      Effect.forever(
        Effect.gen(function* () {
          yield* Effect.sleep("10 seconds");
          if (!alive() || !detail.isConnected) {
            yield* Effect.sync(stop_feed);
            return yield* Effect.interrupt;
          }
          const s = ctl.current;
          if (!s) return;
          if (s.needs_refresh() || feed_holder.feed?.needs_refresh?.()) {
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

const render_item = (session: ForgeSession, thread_id: string, item: ForgeItem, on_object_url: ObjectUrlTracker): HTMLElement => {
  const { kind, text } = item_summary(item);
  const wrap = el("div", { class: "thread-item" });
  const head = el("div", { class: "kind" }, `${kind} · #${item.position ?? "?"} · `, id_span(item.id));
  wrap.append(head);
  wrap.append(transcript_body(session, thread_id, item, on_object_url));
  void text;
  if (kind === "image") wrap.append(image_loader(session, item.kind, on_object_url));
  const approval = pending_approval(item.kind);
  if (approval) wrap.append(approval_box(session, item.id, approval));
  const questions = pending_questions(item.kind);
  if (questions) wrap.append(questions_box(session, item.id, questions));
  void thread_id;
  return wrap;
};

const transcript_body = (
  session: ForgeSession,
  thread_id: string,
  item: ForgeItem,
  on_object_url: ObjectUrlTracker,
): HTMLElement => {
  void thread_id;
  const wrap = el("div", {});
  const t = transcript_text(item.kind);
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
      let dl_url: string | null = null;
      const dl = el("a", { href: "#", download: `thread-item-${item.id}.txt` }, "Download full text");
      dl.addEventListener("click", (e) => {
        e.preventDefault();
        on_object_url.release(dl_url);
        dl_url = URL.createObjectURL(new Blob([t.text], { type: "text/plain;charset=utf-8" }));
        on_object_url.track(dl_url);
        const a = el("a", { href: dl_url, download: `thread-item-${item.id}.txt` }) as unknown as HTMLAnchorElement;
        document.body.append(a);
        a.click();
        a.remove();
      });
      wrap.append(shown, el("p", { class: "small" }, show, " · ", dl));
      wrap.append(rest);
    }
  }
  for (const n of t.notices) wrap.append(el("p", { class: "muted small" }, n));
  for (const s of t.stored) wrap.append(stored_loader(session, s));
  return wrap;
};

const stored_loader = (session: ForgeSession, ref: StoredRef): HTMLElement => {
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
        try: () => tunnel_get(session, `/content/${encodeURIComponent(ref.id)}?offset=${offset}&limit=131072`),
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

const image_loader = (session: ForgeSession, kind: unknown, on_object_url: ObjectUrlTracker): HTMLElement => {
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
  let current_url: string | null = null;
  btn.addEventListener("click", () => {
    const program = Effect.gen(function* () {
      const res = yield* Effect.tryPromise({
        try: () => session.call({ method: "GET", path: `/blobs/${encodeURIComponent(hash)}` }),
        catch: (e) => e,
      });
      const ok = yield* Effect.try({ try: () => throw_if_tunnel_error(res), catch: (e) => e });
      const env = yield* Effect.try({
        try: () => {
          const parsed = as_tunnel_bytes(ok.body);
          if (!parsed) throw new Error("Forge did not return image bytes.");
          return parsed;
        },
        catch: (e) => e,
      });
      const bytes = yield* Effect.try({ try: () => base64url_nopad.decode(env.b64u), catch: (e) => e });
      yield* Effect.sync(() => {
        on_object_url.release(current_url);
        current_url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: env.content_type }));
        on_object_url.track(current_url);
        const img = el("img", { src: current_url, alt: "Forge image" }) as HTMLImageElement;
        img.style.maxWidth = "100%";
        wrap.append(img);
        btn.remove();
        msg.textContent = "";
      });
    }).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => {
          on_object_url.release(current_url);
          current_url = null;
          msg.textContent = friendly(err);
        }),
      ),
    );
    void run_promise(program);
  });
  wrap.append(btn, msg);
  return wrap;
};

const approval_box = (session: ForgeSession, item_id: string, approval: { request: unknown; reason: string | null; options: string[] }): HTMLElement => {
  const wrap = el("div", {});
  wrap.append(el("p", {}, el("strong", {}, "Waiting on your decision.")));
  if (approval.reason) wrap.append(el("p", { class: "muted" }, approval.reason));
  const req = approval.request;
  if (typeof req === "object" && req !== null) {
    const r = req as Record<string, unknown>;
    const desc = text_of((r.command as Record<string, unknown> | undefined)?.command ?? r.description) ?? first_text(req);
    if (desc) wrap.append(el("p", { class: "mono small" }, desc));
  }
  const msg = el("p", { class: "status small", role: "status" });
  const options = approval.options.length > 0 ? approval.options : ["allow_once", "deny_once"];
  for (const opt of options) {
    const b = el("button", opt.startsWith("allow") ? { type: "button" } : { class: "secondary", type: "button" }, label_for(opt));
    b.addEventListener("click", () => {
      const program = Effect.gen(function* () {
        const res = yield* Effect.tryPromise({
          try: () => session.call({ method: "POST", path: `/items/${encodeURIComponent(item_id)}/answer`, body: approval_answer(opt) }),
          catch: (e) => e,
        });
        yield* Effect.try({ try: () => throw_if_tunnel_error(res), catch: (e) => e });
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

const label_for = (opt: string): string =>
  Match.value(opt).pipe(
    Match.when("allow_once", () => "Allow once"),
    Match.when("allow_always", () => "Always allow"),
    Match.when("deny_once", () => "Deny once"),
    Match.when("deny_always", () => "Always deny"),
    Match.orElse(() => opt),
  );

const questions_box = (session: ForgeSession, item_id: string, pending: { blocking: boolean; questions: Array<{ id: string; header: string | null; text: string | null; multi_select: boolean; options: Array<{ id: string; label: string; description: string | null }> }> }): HTMLElement => {
  const wrap = el("div", {});
  wrap.append(el("p", {}, el("strong", {}, pending.blocking ? "The engine is waiting on answers." : "Questions from the engine:")));
  const picks = new Map<string, Set<string>>();
  const texts = new Map<string, string>();
  for (const q of pending.questions) {
    picks.set(q.id, new Set());
    wrap.append(el("p", {}, (q.header ? `${q.header}: ` : "") + (q.text ?? q.id)));
    for (const o of q.options) {
      const id = `q-${item_id}-${q.id}-${o.id}`;
      const box = el("input", { id, type: q.multi_select ? "checkbox" : "radio", value: o.id }) as HTMLInputElement;
      box.setAttribute("name", `q-${item_id}-${q.id}`);
      box.addEventListener("change", () => {
        const set = picks.get(q.id);
        if (!set) return;
        if (!q.multi_select) set.clear();
        if (box.checked) set.add(o.id);
        else set.delete(o.id);
      });
      const lab = el("label", { for: id }, `${o.label}${o.description ? ` — ${o.description}` : ""}`);
      wrap.append(el("div", {}, box, lab));
    }
    const t_label = el("label", { for: `t-${item_id}-${q.id}` }, "Or answer in your own words (optional)");
    const t = el("input", { id: `t-${item_id}-${q.id}`, type: "text" }) as HTMLInputElement;
    t.addEventListener("input", () => texts.set(q.id, t.value));
    wrap.append(t_label, t);
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
        try: () => session.call({ method: "POST", path: `/items/${encodeURIComponent(item_id)}/answer`, body: question_answer(answers) }),
        catch: (e) => e,
      });
      yield* Effect.try({ try: () => throw_if_tunnel_error(res), catch: (e) => e });
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

const send_box = (get_session: () => ForgeSession | null, thread_id: string): HTMLElement => {
  const wrap = el("div", {});
  const label = el("label", { for: `send-${thread_id}` }, "Send a message");
  const input = el("textarea", { id: `send-${thread_id}`, placeholder: "Write to the thread…" }) as HTMLTextAreaElement;
  const btn = el("button", { type: "button" }, "Send");
  const msg = el("p", { class: "status small", role: "status" });
  btn.addEventListener("click", () => {
    const text = input.value;
    if (!text.trim()) {
      msg.textContent = "Write something first.";
      return;
    }
    const session = get_session();
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
            path: `/threads/${encodeURIComponent(thread_id)}/messages`,
            body: send_message_body(new_request_id(), text),
          }),
        catch: (e) => e,
      });
      yield* Effect.try({ try: () => throw_if_tunnel_error(res), catch: (e) => e });
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
