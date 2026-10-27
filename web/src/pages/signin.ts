// Sign-in (#/signin) and email approval (#/approve).
//
// The emailed link carries only `?token=` and opens #/approve, which POSTs
// `consume` on explicit button press — GET never consumes, so mail-scanner
// prefetches approve nothing. Finishing needs the originating browser's
// request secret (see src/auth.ts).

import { ApiError, type CoreApi } from "../api.ts";
import { finalizePayload, loadRequestSecret, clearRequestSecret, nextLoginState, storeRequestSecret, type LoginState } from "../auth.ts";
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

function emailForm(api: CoreApi, signal: AbortSignal): HTMLElement {
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
    void (async () => {
      submit.disabled = true;
      msg.textContent = "Sending…";
      try {
        const res = await api.requestMagicLink(input.value.trim(), undefined, device.value.trim() || undefined);
        storeRequestSecret(res.requestId, res.requestSecret);
        const state: LoginState = {
          requestId: res.requestId,
          email: input.value.trim(),
          expiresAt: res.expiresAt,
          phase: "requested",
          totpRequired: false,
        };
        showProgress(api, state, signal);
        msg.textContent = "";
      } catch (err) {
        msg.textContent = friendly(err);
      } finally {
        submit.disabled = false;
      }
    })();
  });
  return form;
}

function showProgress(api: CoreApi, initial: LoginState, signal: AbortSignal): void {
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
  let transientFailures = 0;
  signal.addEventListener("abort", () => {
    stopped = true; // route gone: no more polls, no detached DOM writes
  });
  finish.addEventListener("click", () => {
    void (async () => {
      finish.disabled = true;
      try {
        const secret = loadRequestSecret(state.requestId);
        const payload = finalizePayload({
          state,
          opts: {
            requestSecret: secret,
            totpCode: !useRecovery && totp.value.trim() ? totp.value.trim() : undefined,
            recoveryCode: useRecovery && rec.value.trim() ? rec.value.trim() : undefined,
          },
        });
        await api.finalizeMagicLink(payload.requestId, payload.requestSecret, {
          totpCode: payload.totpCode,
          recoveryCode: payload.recoveryCode,
        });
        clearRequestSecret(state.requestId);
        state = { ...state, phase: "completed" };
        stopped = true;
        done.textContent = "Signed in. Opening your account…";
        location.hash = "#/account";
      } catch (err) {
        done.textContent = friendly(err);
      } finally {
        finish.disabled = false;
      }
    })();
  });

  const poll = async (): Promise<void> => {
    if (stopped || signal.aborted || !box.isConnected) return;
    const secret = loadRequestSecret(state.requestId);
    if (!secret) {
      status.textContent = "This browser lost the request secret (storage was cleared). Start over.";
      return;
    }
    try {
      const s = await api.loginStatus(state.requestId, secret);
      state = nextLoginState(state, { status: s.status, totpRequired: s.totpRequired, email: s.email, expiresAt: s.expiresAt });
      if (state.phase === "email_approved") {
        status.textContent = "Approved. Finish sign-in below.";
        status.className = "status ok";
        finish.hidden = false;
        totpWrap.hidden = !state.totpRequired;
        return; // stop polling; the finish button completes the flow.
      }
      if (state.phase === "completed") {
        status.textContent = "Already signed in on this request.";
        return;
      }
      if (state.phase === "expired") {
        status.textContent = "This request expired. Start over with a fresh link.";
        status.className = "status err";
        return;
      }
      status.textContent = "Waiting for approval…";
    } catch (err) {
      // Transient service/network hiccups must not kill the wait: keep
      // polling with backoff. Terminal answers (unknown request, rate
      // limits) stop and say so.
      const transient = err instanceof ApiError ? err.status >= 500 : true;
      if (transient) {
        transientFailures += 1;
        if (transientFailures <= 10 && !signal.aborted) {
          status.textContent = "Connection hiccup — still waiting…";
          status.className = "status muted";
          setTimeout(() => void poll(), 3000 + transientFailures * 1000);
          return;
        }
      }
      status.textContent = friendly(err);
      status.className = "status err";
      return;
    }
    transientFailures = 0;
    if (!signal.aborted) setTimeout(() => void poll(), 3000);
  };
  void poll();
}

export function friendly(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return "Too many attempts. Wait a little and try again.";
    if (err.status >= 500) return "The account service had a problem. Try again in a bit.";
    return err.message;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

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
    btn.addEventListener("click", () => void doConsume(api, token, card, msg));
    card.append(btn);
  }
  root.append(card);
}

async function doConsume(api: CoreApi, token: string, card: HTMLElement, msg: HTMLElement): Promise<void> {
  if (!token) {
    msg.textContent = "This approval link is missing its token. Request a new sign-in link and open the fresh approval link.";
    return;
  }
  msg.textContent = "Approving…";
  try {
    const res = await api.consumeMagicLink(token);
    if (res.status === "expired") {
      msg.textContent = "This link expired. Request a fresh one.";
      return;
    }
    const secret = loadRequestSecret(res.requestId);
    if (secret) {
      msg.textContent = "Approved. This tab started the request — you can finish sign-in here.";
      card.append(finishHere(api, res.requestId, secret, res.totpRequired));
    } else {
      msg.textContent =
        "Approved. This tab did not start the sign-in: finish in the tab that requested the link — it picks up this approval on its own. " +
        "If you requested the link on a different device, finish there.";
    }
  } catch (err) {
    msg.textContent = friendly(err);
  }
}

function finishHere(api: CoreApi, requestId: string, secret: string, totpRequired: boolean): HTMLElement {
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
    void (async () => {
      try {
        const payload = finalizePayload({
          state,
          opts: {
            requestSecret: secret,
            totpCode: !useRecovery && codeInput?.value.trim() ? codeInput.value.trim() : undefined,
            recoveryCode: useRecovery && recInput?.value.trim() ? recInput.value.trim() : undefined,
          },
        });
        await api.finalizeMagicLink(payload.requestId, payload.requestSecret, {
          totpCode: payload.totpCode,
          recoveryCode: payload.recoveryCode,
        });
        out.textContent = "Signed in. Opening your account…";
        location.hash = "#/account";
      } catch (err) {
        out.textContent = friendly(err);
      }
    })();
  });
  wrap.append(btn, out);
  return wrap;
}
