import { Effect, Either, Match } from "effect";
import type { CoreApi } from "../api.ts";
import { run_promise } from "../core/run-promise.ts";
import { clear, el, idSpan, when } from "../ui.ts";
import type { PageContext } from "../main.ts";
import { friendly } from "./signin.ts";
import QRCode from "qrcode";

type QrState = { readonly _tag: "Rendered"; readonly node: HTMLElement } | { readonly _tag: "Fallback" };

const qr_effect = (otpauthUrl: string): Effect.Effect<QrState, never> =>
  Effect.tryPromise({
    try: () => QRCode.toString(otpauthUrl, { type: "svg", margin: 1, width: 180 }),
    catch: () => new Error("qr failed"),
  }).pipe(
    Effect.catchAll(() => Effect.succeed(null as string | null)),
    Effect.map((svg) =>
      Match.value(svg).pipe(
        Match.when(
          (v): v is string => typeof v === "string",
          (text): QrState => {
            const wrap = el("div", { class: "qr" });
            const img = el("img", { alt: "Authenticator setup code" }) as HTMLImageElement;
            img.src = `data:image/svg+xml,${encodeURIComponent(text)}`;
            img.width = 180;
            img.height = 180;
            wrap.append(img);
            return { _tag: "Rendered", node: wrap };
          },
        ),
        Match.orElse((): QrState => ({ _tag: "Fallback" })),
      ),
    ),
  );

const render_qr_node = (state: QrState): HTMLElement =>
  Match.value(state).pipe(
    Match.tag("Rendered", (s) => s.node),
    Match.tag("Fallback", () => {
      const wrap = el("div", { class: "qr" });
      wrap.append(el("p", { class: "muted small" }, "The code image did not render — enter the details below manually."));
      return wrap;
    }),
    Match.exhaustive,
  );

export function parseOtpauth(url: string): { account: string; secret: string } {
  const parsed = Either.getOrNull(
    Either.try({ try: () => new URL(url), catch: () => null }),
  );
  if (parsed === null) return { account: "this account", secret: "" };
  const label = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const account = label.includes(":") ? (label.split(":").slice(1).join(":") || label) : label;
  return { account: account || "this account", secret: parsed.searchParams.get("secret") ?? "" };
}

const card = (title: string): { box: HTMLElement; status: HTMLElement } => {
  const box = el("div", { class: "card" });
  box.append(el("h2", {}, title));
  const status = el("p", { class: "status muted", role: "status" }, "Loading…");
  box.append(status);
  return { box, status };
};

export function renderAccount(ctx: PageContext): void {
  const { root, api } = ctx;
  clear(root);
  const { box, status } = card("Account");
  root.append(box);
  const program: Effect.Effect<void, unknown> = Effect.gen(function* () {
    const me = yield* Effect.tryPromise({ try: () => api.me(), catch: (e) => e });
    yield* Effect.sync(() => {
      clear(box);
      box.append(el("h2", {}, "Account"));
      const dl = el("div", {});
      dl.append(
        el("p", {}, "Email: ", el("strong", {}, me.email)),
        el("p", {}, "Name: ", el("strong", {}, me.displayName || "—")),
        el("p", {}, "Two-step sign-in: ", me.totpEnrolled ? el("strong", { class: "ok" }, "on") : el("span", { class: "warn" }, "off")),
        el("p", {}, `Machines on this account: ${me.machines.length} · Provider connections: ${me.providerConnections.length} · Latest config: `,
          me.latestConfigVersion === null ? "none published" : `v${me.latestConfigVersion}`),
      );
      box.append(dl);
      const details = el("details", { class: "small muted" });
      details.append(el("summary", {}, "Account details"), el("p", {}, idSpan(me.accountId)));
      box.append(details);
      box.append(el("p", { class: "small" },
        el("a", { href: "#/machines" }, "Machines"), " · ",
        el("a", { href: "#/sessions" }, "Sessions"), " · ",
        el("a", { href: "#/security" }, "Security"), " · ",
        el("a", { href: "#/vault" }, "Connections"), " · ",
        el("a", { href: "#/forge" }, "Threads"),
      ));
    });
  }).pipe(
    Effect.catchAll((err: unknown) =>
      Effect.sync(() => {
        status.textContent = friendly(err);
        status.className = "status err";
      }),
    ),
  );
  void run_promise(program);
}

export function renderSessions(ctx: PageContext): void {
  const { root, api } = ctx;
  clear(root);
  const { box, status } = card("Sessions");
  root.append(box);
  const note = el("p", { class: "muted small" },
    "Each row is a browser holding a revocable session. Sign-in sets a persistent HttpOnly cookie (30 days): closing the tab does not sign you out — use Sign out above or revoke here. The cookie itself is never visible to scripts.");
  box.append(note);
  const program: Effect.Effect<void, unknown> = Effect.gen(function* () {
    const list = yield* Effect.tryPromise({ try: () => api.sessions(), catch: (e) => e });
    yield* Effect.sync(() => {
      clear(box);
      box.append(el("h2", {}, "Sessions"), note);
      if (list.sessions.length === 0) {
        box.append(el("p", { class: "muted" }, "No sessions — that should not happen while signed in."));
        return;
      }
      const table = el("table", {});
      table.append(el("tr", {}, el("th", {}, "Device"), el("th", {}, "Signed in"), el("th", {}, "Expires"), el("th", {}, "State")));
      for (const s of list.sessions) {
        table.append(el("tr", {},
          el("td", {}, s.deviceName || "unnamed browser", el("br", {}), idSpan(s.id)),
          el("td", {}, when(s.createdAt)),
          el("td", {}, when(s.expiresAt)),
          el("td", {}, s.revokedAt ? `revoked ${when(s.revokedAt)}` : "active"),
        ));
      }
      box.append(table);
      const row = el("div", { class: "row" });
      const revokeAll = el("button", { class: "secondary", type: "button" }, "Sign out everywhere else");
      const out = el("p", { class: "status", role: "status" });
      revokeAll.addEventListener("click", () => {
        const revoke: Effect.Effect<void, unknown> = Effect.gen(function* () {
          yield* Effect.tryPromise({ try: () => api.revokeAllSessions(), catch: (e) => e });
          yield* Effect.sync(() => {
            out.textContent = "All sessions revoked. This browser is signed out too.";
            setTimeout(() => { location.hash = "#/signin"; }, 800);
          });
        }).pipe(
          Effect.catchAll((err: unknown) =>
            Effect.sync(() => {
              out.textContent = friendly(err);
            }),
          ),
        );
        void run_promise(revoke);
      });
      row.append(revokeAll);
      box.append(row, out);
    });
  }).pipe(
    Effect.catchAll((err: unknown) =>
      Effect.sync(() => {
        status.textContent = friendly(err);
        status.className = "status err";
      }),
    ),
  );
  void run_promise(program);
}

export function renderSecurity(ctx: PageContext): void {
  const { root, api } = ctx;
  clear(root);
  const { box, status } = card("Security");
  root.append(box);
  box.append(el("p", { class: "muted small" },
    "Optional authenticator (TOTP) plus recovery codes. Email alone never bypasses it: when enrolled, finishing sign-in always needs a code."));
  const program: Effect.Effect<void, unknown> = Effect.gen(function* () {
    const me = yield* Effect.tryPromise({ try: () => api.me(), catch: (e) => e });
    yield* Effect.sync(() => {
      clear(box);
      box.append(el("h2", {}, "Security"));
      if (!me.totpEnrolled) {
        box.append(enrollBox(api));
      } else {
        box.append(disableBox(api));
      }
    });
  }).pipe(
    Effect.catchAll((err: unknown) =>
      Effect.sync(() => {
        status.textContent = friendly(err);
        status.className = "status err";
      }),
    ),
  );
  void run_promise(program);
}

const enrollBox = (api: CoreApi): HTMLElement => {
  const wrap = el("div", {});
  wrap.append(el("p", {}, "Not enrolled."));
  const start = el("button", { type: "button" }, "Start enrollment");
  const out = el("div", {});
  start.addEventListener("click", () => {
    const enroll: Effect.Effect<void, unknown> = Effect.gen(function* () {
      const res = yield* Effect.tryPromise({ try: () => api.enrollTotp(), catch: (e) => e });
      const qr = yield* qr_effect(res.otpauthUrl);
      const { account, secret } = parseOtpauth(res.otpauthUrl);
      yield* Effect.sync(() => {
        clear(out);
        out.append(
          el("p", {}, "Scan the code with your authenticator, or enter the details manually:"),
          render_qr_node(qr),
          el("p", { class: "small" }, "Account: ", el("strong", {}, account), el("br", {}),
            "Secret: ", el("span", { class: "mono" }, secret), el("br", {}),
            el("span", { class: "muted" }, "Time-based, 6 digits. Keep the secret where only you can find it.")),
          el("p", { class: "warn" }, "Recovery codes — write these down now. Each works once, instead of a code:"),
          el("ul", {}, ...res.recoveryCodes.map((c) => el("li", { class: "mono" }, c))),
        );
        const label = el("label", { for: "totp-confirm" }, "Code from your authenticator");
        const input = el("input", { id: "totp-confirm", type: "text", inputmode: "numeric", autocomplete: "one-time-code" }) as HTMLInputElement;
        const confirm = el("button", { type: "button" }, "Confirm enrollment");
        const msg = el("p", { class: "status", role: "status" });
        confirm.addEventListener("click", () => {
          const code = input.value.trim();
          const verify: Effect.Effect<void, unknown> = Effect.gen(function* () {
            const r = yield* Effect.tryPromise({ try: () => api.verifyTotp(code), catch: (e) => e });
            yield* Effect.sync(() => {
              msg.textContent = r.enrolled ? "Two-step sign-in is on." : "Not confirmed yet.";
            });
          }).pipe(
            Effect.catchAll((err: unknown) =>
              Effect.sync(() => {
                msg.textContent = friendly(err);
              }),
            ),
          );
          void run_promise(verify);
        });
        out.append(label, input, confirm, msg);
      });
    }).pipe(
      Effect.catchAll((err: unknown) =>
        Effect.sync(() => {
          clear(out);
          out.append(el("p", { class: "err" }, friendly(err)));
        }),
      ),
    );
    void run_promise(enroll);
  });
  wrap.append(start, out);
  return wrap;
};

const disableBox = (api: CoreApi): HTMLElement => {
  const wrap = el("div", {});
  wrap.append(el("p", {}, "Enrolled. Disabling needs a current code."));
  const label = el("label", { for: "totp-disable" }, "Authenticator code");
  const input = el("input", { id: "totp-disable", type: "text", inputmode: "numeric", autocomplete: "one-time-code" }) as HTMLInputElement;
  const btn = el("button", { class: "danger", type: "button" }, "Turn off two-step sign-in");
  const msg = el("p", { class: "status", role: "status" });
  btn.addEventListener("click", () => {
    const code = input.value.trim();
    const disable: Effect.Effect<void, unknown> = Effect.gen(function* () {
      const r = yield* Effect.tryPromise({ try: () => api.disableTotp(code), catch: (e) => e });
      yield* Effect.sync(() => {
        msg.textContent = r.disabled ? "Two-step sign-in is off." : "Not disabled.";
      });
    }).pipe(
      Effect.catchAll((err: unknown) =>
        Effect.sync(() => {
          msg.textContent = friendly(err);
        }),
      ),
    );
    void run_promise(disable);
  });
  wrap.append(label, input, btn, msg);
  return wrap;
};

export function renderActivity(ctx: PageContext): void {
  const { root, api } = ctx;
  clear(root);
  const { box, status } = card("Recent activity");
  root.append(box);
  const program: Effect.Effect<void, unknown> = Effect.gen(function* () {
    const res = yield* Effect.tryPromise({ try: () => api.activity(50), catch: (e) => e });
    yield* Effect.sync(() => {
      clear(box);
      box.append(el("h2", {}, "Recent activity"));
      if (res.events.length === 0) {
        box.append(el("p", { class: "muted" }, "Nothing recorded yet."));
        return;
      }
      const table = el("table", {});
      table.append(el("tr", {}, el("th", {}, "When"), el("th", {}, "Event"), el("th", {}, "Machine")));
      for (const e of res.events) {
        table.append(el("tr", {},
          el("td", {}, when(e.createdAt)),
          el("td", {}, e.kind),
          el("td", {}, e.machineId ?? "—"),
        ));
      }
      box.append(table);
    });
  }).pipe(
    Effect.catchAll((err: unknown) =>
      Effect.sync(() => {
        status.textContent = friendly(err);
        status.className = "status err";
      }),
    ),
  );
  void run_promise(program);
};

type DeletionView =
  | { readonly _tag: "Pending"; readonly requestedAt: string | null; readonly purgeAfter: string | null }
  | { readonly _tag: "None" };

export function renderDanger(ctx: PageContext): void {
  const { root, api } = ctx;
  clear(root);
  const { box, status } = card("Delete account");
  root.append(box);
  const program: Effect.Effect<void, unknown> = Effect.gen(function* () {
    const s = yield* Effect.tryPromise({ try: () => api.deletionStatus(), catch: (e) => e });
    const view: DeletionView = s.status === "pending"
      ? { _tag: "Pending", requestedAt: s.requestedAt, purgeAfter: s.purgeAfter }
      : { _tag: "None" };
    const me = view._tag === "None" ? yield* Effect.tryPromise({ try: () => api.me(), catch: (e) => e }) : null;
    yield* Effect.sync(() => {
      clear(box);
      box.append(el("h2", {}, "Delete account"));
      box.append(el("p", {}, `Status: ${s.status}`));
      Match.value(view).pipe(
        Match.tag("Pending", (pending) => {
          box.append(el("p", { class: "warn" }, `Requested ${when(pending.requestedAt)}. Purge after ${when(pending.purgeAfter)}.`));
          const cancel = el("button", { type: "button" }, "Cancel deletion");
          const msg = el("p", { class: "status", role: "status" });
          cancel.addEventListener("click", () => {
            const cancel_one: Effect.Effect<void, unknown> = Effect.gen(function* () {
              yield* Effect.tryPromise({ try: () => api.cancelDeletion(), catch: (e) => e });
              yield* Effect.sync(() => {
                msg.textContent = "Deletion cancelled.";
              });
            }).pipe(
              Effect.catchAll((err: unknown) =>
                Effect.sync(() => {
                  msg.textContent = friendly(err);
                }),
              ),
            );
            void run_promise(cancel_one);
          });
          box.append(cancel, msg);
        }),
        Match.tag("None", () => {
          if (me !== null && me.totpEnrolled) {
            const label = el("label", { for: "del-totp" }, "Authenticator code (required while two-step is on)");
            const input = el("input", { id: "del-totp", type: "text", inputmode: "numeric" }) as HTMLInputElement;
            box.append(label, input);
            const req = el("button", { class: "danger", type: "button" }, "Request deletion");
            const msg = el("p", { class: "status", role: "status" });
            req.addEventListener("click", () => {
              const code = input.value.trim() || undefined;
              const request: Effect.Effect<void, unknown> = Effect.gen(function* () {
                yield* Effect.tryPromise({ try: () => api.requestDeletion(code), catch: (e) => e });
                yield* Effect.sync(() => {
                  msg.textContent = "Deletion requested.";
                });
              }).pipe(
                Effect.catchAll((err: unknown) =>
                  Effect.sync(() => {
                    msg.textContent = friendly(err);
                  }),
                ),
              );
              void run_promise(request);
            });
            box.append(req, msg);
          } else {
            const req = el("button", { class: "danger", type: "button" }, "Request deletion");
            const msg = el("p", { class: "status", role: "status" });
            req.addEventListener("click", () => {
              const request: Effect.Effect<void, unknown> = Effect.gen(function* () {
                yield* Effect.tryPromise({ try: () => api.requestDeletion(undefined), catch: (e) => e });
                yield* Effect.sync(() => {
                  msg.textContent = "Deletion requested.";
                });
              }).pipe(
                Effect.catchAll((err: unknown) =>
                  Effect.sync(() => {
                    msg.textContent = friendly(err);
                  }),
                ),
              );
              void run_promise(request);
            });
            box.append(req, msg);
          }
        }),
        Match.exhaustive,
      );
    });
  }).pipe(
    Effect.catchAll((err: unknown) =>
      Effect.sync(() => {
        status.textContent = friendly(err);
        status.className = "status err";
      }),
    ),
  );
  void run_promise(program);
}
