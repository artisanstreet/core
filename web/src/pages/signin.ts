import { Effect, Match } from "effect";
import { ApiError, type CoreApi } from "../api.ts";
import {
  FinalizeExpired,
  FinalizeMissingSecret,
  FinalizeNotApproved,
  FinalizeTotpRequired,
  finalize_effect,
  finalizeFailureMessage,
  loadRequestSecret,
  clearRequestSecret,
  nextLoginState,
  storeRequestSecret,
  type LoginState,
} from "../auth.ts";
import { start_login_poll } from "../core/login-poll.ts";
import { run_promise } from "../core/run-promise.ts";
import { clear, el } from "../ui.ts";
import type { PageContext } from "../main.ts";

export function renderSignin(ctx: PageContext): void {
  const { root, api, signal } = ctx;
  clear(root);
  root.append(
    el("div", { class: "card" },
      el("h2", {}, "Sign in to AST"),
      el("p", { class: "muted" }, "We’ll email you a sign-in link."),
      emailForm(api, signal),
    ),
    el("div", { class: "card", id: "signin-progress", hidden: "true" }),
  );
}

const emailForm = (api: CoreApi, signal: AbortSignal): HTMLElement => {
  const form = el("form", {});
  const label = el("label", { for: "signin-email" }, "Email");
  const input = el("input", { id: "signin-email", type: "email", required: "true", autocomplete: "email", placeholder: "you@example.com" }) as HTMLInputElement;
  const deviceLabel = el("label", { for: "signin-device" }, "Device name (optional)");
  const device = el("input", { id: "signin-device", type: "text", autocomplete: "off", placeholder: "This browser" }) as HTMLInputElement;
  const submit = el("button", { type: "submit" }, "Email me a link");
  const msg = el("p", { class: "status muted", role: "status" });
  form.append(label, input, deviceLabel, device, submit, msg);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = input.value.trim();
    const deviceName = device.value.trim() || undefined;
    const request_link = Effect.gen(function* () {
      yield* Effect.sync(() => {
        submit.disabled = true;
        msg.textContent = "Sending…";
      });
      const res = yield* Effect.tryPromise({ try: () => api.requestMagicLink(email, undefined, deviceName), catch: (err) => err });
      yield* Effect.sync(() => {
        storeRequestSecret(res.requestId, res.requestSecret);
        const state: LoginState = {
          requestId: res.requestId,
          email,
          expiresAt: res.expiresAt,
          phase: "requested",
          totpRequired: false,
        };
        showProgress(api, state, signal);
        msg.textContent = "";
      });
    }).pipe(
      Effect.catchAll((err: unknown) =>
        Effect.sync(() => {
          msg.textContent = friendly(err);
        }),
      ),
      Effect.ensuring(Effect.sync(() => {
        submit.disabled = false;
      })),
    );
    void run_promise(request_link);
  });
  return form;
};

const showProgress = (api: CoreApi, initial: LoginState, signal: AbortSignal): void => {
  const box = document.getElementById("signin-progress");
  if (!box) return;
  box.hidden = false;
  clear(box);
  let state = initial;
  box.append(
    el("h2", {}, "Waiting for approval"),
    el("p", { class: "muted" }, `We emailed ${state.email}. Open the link, then approve. If your email opened on another device, approve there and finish here.`),
  );
  const status = el("p", { class: "status muted", role: "status" }, "Waiting…");
  const totpWrap = el("div", { hidden: "true" });
  const totpLabel = el("label", { for: "signin-totp" }, "Authenticator code");
  const totp = el("input", { id: "signin-totp", type: "text", inputmode: "numeric", autocomplete: "one-time-code", placeholder: "123456" }) as HTMLInputElement;
  const swap = el("button", { class: "secondary", type: "button" }, "Use a recovery code instead");
  const recLabel = el("label", { for: "signin-rec", hidden: "true" }, "Recovery code (use once, instead of the authenticator)");
  const rec = el("input", { id: "signin-rec", type: "text", autocomplete: "off", hidden: "true", placeholder: "recovery code" }) as HTMLInputElement;
  let useRecovery = false;
  swap.addEventListener("click", () => {
    useRecovery = !useRecovery;
    totp.hidden = useRecovery;
    totpLabel.hidden = useRecovery;
    rec.hidden = !useRecovery;
    recLabel.hidden = !useRecovery;
    swap.textContent = useRecovery ? "Use the authenticator instead" : "Use a recovery code instead";
  });
  totpWrap.append(totpLabel, totp, recLabel, rec, swap);
  const finish = el("button", { type: "button", hidden: "true" }, "Finish sign-in on this device");
  const done = el("p", { class: "status", role: "status" });
  box.append(status, totpWrap, finish, done);

  let stopped = false;
  signal.addEventListener("abort", () => {
    stopped = true;
  });
  finish.addEventListener("click", () => {
    const totpValue = !useRecovery && totp.value.trim() ? totp.value.trim() : undefined;
    const recoveryValue = useRecovery && rec.value.trim() ? rec.value.trim() : undefined;
    const finish_signin = Effect.gen(function* () {
      yield* Effect.sync(() => {
        finish.disabled = true;
      });
      const secret = loadRequestSecret(state.requestId);
      const payload = yield* finalize_effect({
        state,
        opts: { requestSecret: secret, totpCode: totpValue, recoveryCode: recoveryValue },
      });
      yield* Effect.tryPromise({
        try: () => api.finalizeMagicLink(payload.requestId, payload.requestSecret, {
          totpCode: payload.totpCode,
          recoveryCode: payload.recoveryCode,
        }),
        catch: (err) => err as ApiError,
      });
      yield* Effect.sync(() => {
        clearRequestSecret(state.requestId);
        state = { ...state, phase: "completed" };
        stopped = true;
        stop_poll();
        done.textContent = "Signed in. Opening your account…";
        location.hash = "#/account";
      });
    }).pipe(
      Effect.catchTags({
        FinalizeExpired: (f) =>
          Effect.sync(() => {
            done.textContent = finalizeFailureMessage(f);
          }),
        FinalizeMissingSecret: (f) =>
          Effect.sync(() => {
            done.textContent = finalizeFailureMessage(f);
          }),
        FinalizeNotApproved: (f) =>
          Effect.sync(() => {
            done.textContent = finalizeFailureMessage(f);
          }),
        FinalizeTotpRequired: (f) =>
          Effect.sync(() => {
            done.textContent = finalizeFailureMessage(f);
          }),
      }),
      Effect.catchAll((err) =>
        Effect.sync(() => {
          done.textContent = friendly(err);
        }),
      ),
      Effect.ensuring(Effect.sync(() => {
        finish.disabled = false;
      })),
    );
    void run_promise(finish_signin);
  });

  const stop_poll = start_login_poll(api, state.requestId, () => loadRequestSecret(state.requestId), {
    on_approved: (s) => {
      state = nextLoginState(state, s);
      status.textContent = "Approved. Finish sign-in below.";
      status.className = "status ok";
      finish.hidden = false;
      totpWrap.hidden = !state.totpRequired;
    },
    on_completed: (s) => {
      state = nextLoginState(state, s);
      status.textContent = "Already signed in on this request.";
    },
    on_expired: () => {
      state = { ...state, phase: "expired" };
      status.textContent = "This request expired. Start over with a fresh link.";
      status.className = "status err";
    },
    on_transient: () => {
      status.textContent = "Connection hiccup — still waiting…";
      status.className = "status muted";
    },
    on_terminal: (message) => {
      status.textContent = message;
      status.className = "status err";
    },
    is_cancelled: () => stopped || signal.aborted || !box.isConnected,
    format_error: (err) => friendly(err),
  }, signal);
  signal.addEventListener("abort", () => stop_poll(), { once: true });
};

export const friendly = (err: unknown): string => {
  if (
    err instanceof FinalizeExpired ||
    err instanceof FinalizeMissingSecret ||
    err instanceof FinalizeNotApproved ||
    err instanceof FinalizeTotpRequired
  ) {
    return finalizeFailureMessage(err);
  }
  return Match.value(err).pipe(
    Match.when(
      (v: unknown): v is ApiError => v instanceof ApiError && v.status === 429,
      () => "Too many attempts. Wait a little and try again.",
    ),
    Match.when(
      (v: unknown): v is ApiError => v instanceof ApiError && v.status >= 500,
      () => "The account service had a problem. Try again in a bit.",
    ),
    Match.when(
      (v: unknown): v is ApiError => v instanceof ApiError,
      (api_err) => api_err.message,
    ),
    Match.when(
      (v: unknown): v is Error => v instanceof Error,
      (e) => e.message,
    ),
    Match.orElse(() => "Something went wrong."),
  );
};

export function renderApprove(ctx: PageContext): void {
  const { root, api } = ctx;
  clear(root);
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const token = params.get("token") ?? "";
  const card = el("div", { class: "card" },
    el("h2", {}, "Approve this sign-in?"),
    el("p", { class: "muted" },
      "This approves the sign-in on the browser that requested it. Only approve if you just tried to sign in — otherwise ignore this page."),
  );
  const msg = el("p", { class: "status muted", role: "status" });
  card.append(msg);
  if (!token) {
    card.append(
      el("p", {}, "This approval link is missing its token, so there is nothing to approve."),
      el("p", {}, el("a", { href: "#/signin" }, "Request a new sign-in link"), " and open the fresh approval link from your email."),
    );
  } else {
    const btn = el("button", { type: "button" }, "Approve this request");
    btn.addEventListener("click", () => {
      void run_promise(consume_effect(api, token, card, msg));
    });
    card.append(btn);
  }
  root.append(card);
}

const consume_effect = (api: CoreApi, token: string, card: HTMLElement, msg: HTMLElement) =>
  Effect.gen(function* () {
    if (!token) {
      yield* Effect.sync(() => {
        msg.textContent = "This approval link is missing its token. Request a new sign-in link and open the fresh approval link.";
      });
      return;
    }
    yield* Effect.sync(() => {
      msg.textContent = "Approving…";
    });
    const res = yield* Effect.tryPromise({ try: () => api.consumeMagicLink(token), catch: (err) => err });
    if (res.status === "expired") {
      yield* Effect.sync(() => {
        msg.textContent = "This link expired. Request a fresh one.";
      });
      return;
    }
    const secret = loadRequestSecret(res.requestId);
    if (secret) {
      yield* Effect.sync(() => {
        msg.textContent = "Approved. This tab started the request — you can finish sign-in here.";
        card.append(finishHere(api, res.requestId, secret, res.totpRequired));
      });
    } else {
      yield* Effect.sync(() => {
        msg.textContent =
          "Approved. This tab did not start the sign-in: finish in the tab that requested the link — it picks up this approval on its own. " +
          "If you requested the link on a different device, finish there.";
      });
    }
  }).pipe(
    Effect.catchAll((err: unknown) =>
      Effect.sync(() => {
        msg.textContent = friendly(err);
      }),
    ),
  );

const finishHere = (api: CoreApi, requestId: string, secret: string, totpRequired: boolean): HTMLElement => {
  const wrap = el("div", {});
  const state: LoginState = { requestId, email: "", expiresAt: "", phase: "email_approved", totpRequired };
  let codeInput: HTMLInputElement | null = null;
  let recInput: HTMLInputElement | null = null;
  let useRecovery = false;
  if (totpRequired) {
    const label = el("label", { for: "approve-totp" }, "Authenticator code");
    codeInput = el("input", { id: "approve-totp", type: "text", inputmode: "numeric", autocomplete: "one-time-code" }) as HTMLInputElement;
    const recLabel = el("label", { for: "approve-rec", hidden: "true" }, "Recovery code (use once, instead of the authenticator)");
    recInput = el("input", { id: "approve-rec", type: "text", autocomplete: "off", hidden: "true" }) as HTMLInputElement;
    const swap = el("button", { class: "secondary", type: "button" }, "Use a recovery code instead");
    swap.addEventListener("click", () => {
      useRecovery = !useRecovery;
      if (codeInput && recInput && label && recLabel) {
        codeInput.hidden = useRecovery;
        label.hidden = useRecovery;
        recInput.hidden = !useRecovery;
        recLabel.hidden = !useRecovery;
        swap.textContent = useRecovery ? "Use the authenticator instead" : "Use a recovery code instead";
      }
    });
    wrap.append(label, codeInput, recLabel, recInput, swap);
  }
  const btn = el("button", { type: "button" }, "Finish sign-in");
  const out = el("p", { class: "status", role: "status" });
  btn.addEventListener("click", () => {
    const codeValue = !useRecovery && codeInput?.value.trim() ? codeInput.value.trim() : undefined;
    const recValue = useRecovery && recInput?.value.trim() ? recInput.value.trim() : undefined;
    const finish_here = Effect.gen(function* () {
      const payload = yield* finalize_effect({
        state,
        opts: { requestSecret: secret, totpCode: codeValue, recoveryCode: recValue },
      });
      yield* Effect.tryPromise({
        try: () =>
          api.finalizeMagicLink(payload.requestId, payload.requestSecret, {
            totpCode: payload.totpCode,
            recoveryCode: payload.recoveryCode,
          }),
        catch: (err) => err as ApiError,
      });
      yield* Effect.sync(() => {
        out.textContent = "Signed in. Opening your account…";
        location.hash = "#/account";
      });
    }).pipe(
      Effect.catchTags({
        FinalizeExpired: (f) =>
          Effect.sync(() => {
            out.textContent = finalizeFailureMessage(f);
          }),
        FinalizeMissingSecret: (f) =>
          Effect.sync(() => {
            out.textContent = finalizeFailureMessage(f);
          }),
        FinalizeNotApproved: (f) =>
          Effect.sync(() => {
            out.textContent = finalizeFailureMessage(f);
          }),
        FinalizeTotpRequired: (f) =>
          Effect.sync(() => {
            out.textContent = finalizeFailureMessage(f);
          }),
      }),
      Effect.catchAll((err) =>
        Effect.sync(() => {
          out.textContent = friendly(err);
        }),
      ),
    );
    void run_promise(finish_here);
  });
  wrap.append(btn, out);
  return wrap;
};
