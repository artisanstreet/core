import { Effect, Match } from "effect";
import { CoreApi, ApiError } from "./api.ts";
import { clear, el } from "./ui.ts";
import { render_signin, render_approve, friendly } from "./pages/signin.ts";
import { render_account, render_sessions, render_security, render_activity, render_danger } from "./pages/account.ts";
import { render_machines } from "./pages/machines.ts";
import { render_vault } from "./pages/vault.ts";
import { render_config } from "./pages/config.ts";
import { render_forge } from "./pages/forgeview.ts";
import { run_promise } from "./core/run-promise.ts";

export interface PageContext {
  api: CoreApi;
  root: HTMLElement;
  signal: AbortSignal;
}

const NAV: Array<{ hash: string; label: string }> = [
  { hash: "#/account", label: "Account" },
  { hash: "#/forge", label: "Threads" },
  { hash: "#/machines", label: "Machines" },
  { hash: "#/sessions", label: "Sessions" },
  { hash: "#/security", label: "Security" },
  { hash: "#/vault", label: "Connections" },
  { hash: "#/config", label: "Configuration" },
  { hash: "#/activity", label: "Activity" },
];

const PUBLIC_HASHES = ["#/signin", "#/approve"];

type ShellMode = { readonly _tag: "Public" } | { readonly _tag: "Authed" };

const shell_mode = (authenticated: boolean): ShellMode =>
  authenticated ? { _tag: "Authed" } : { _tag: "Public" };

export function create_app(root: HTMLElement, api: CoreApi): void {
  let generation = 0;
  let current: AbortController | null = null;

  const render = () => {
    const my_generation = ++generation;
    current?.abort();
    const controller = new AbortController();
    current = controller;
    const fresh = () => my_generation === generation && !controller.signal.aborted;
    const main_of = () => root.querySelector("main") as HTMLElement | null;
    const hash = location.hash || "#/account";
    const path = hash.split("?")[0];
    if (PUBLIC_HASHES.includes(path ?? "")) {
      render_shell(root, api, false);
      const main = main_of();
      if (main) route(hash, { api, root: main, signal: controller.signal });
      return;
    }
    render_shell(root, api, false);
    const main = main_of();
    if (main) main.append(el("p", { class: "muted" }, "Checking your session…"));
    const check_session: Effect.Effect<void, unknown> = Effect.gen(function* () {
      yield* Effect.tryPromise({ try: () => api.me(), catch: (e) => e });
      yield* Effect.sync(() => {
        if (!fresh()) return;
        render_shell(root, api, true);
        const next = main_of();
        if (next) route(hash, { api, root: next, signal: controller.signal });
      });
    }).pipe(
      Effect.catchAll((err: unknown) =>
        Effect.sync(() => {
          if (!fresh()) return;
          if (err instanceof ApiError && err.status === 401) {
            location.hash = "#/signin";
            return;
          }
          const stale = main_of();
          if (stale) {
            clear(stale);
            stale.append(el("div", { class: "card" }, el("p", { class: "err" }, friendly(err))));
          }
        }),
      ),
    );
    void run_promise(check_session);
  };
  window.addEventListener("hashchange", render);
  render();
}

function render_shell(root: HTMLElement, api: CoreApi, authenticated: boolean): void {
  clear(root);
  const skip = el("a", { class: "skip-link", href: "#main" }, "Skip to content");
  const wrap = el("div", { class: "wrap" });
  const bar = el("div", { class: "topbar" });
  bar.append(el("a", { class: "brand", href: authenticated ? "#/account" : "#/signin" }, "AST"));
  Match.value(shell_mode(authenticated)).pipe(
    Match.tag("Authed", () => {
      const nav = el("nav", { "aria-label": "Account" });
      for (const n of NAV) nav.append(el("a", { href: n.hash }, n.label));
      bar.append(nav);
      const out = el("a", { href: "#/signin", id: "signout" }, "Sign out");
      out.addEventListener("click", (e) => {
        e.preventDefault();
        const signout: Effect.Effect<void, never> = Effect.tryPromise({
          try: () => api.revoke_current_session(),
          catch: () => null,
        }).pipe(
          Effect.match({
            onFailure: () => undefined,
            onSuccess: () => undefined,
          }),
          Effect.andThen(Effect.sync(() => {
            location.hash = "#/signin";
          })),
        );
        void run_promise(signout);
      });
      const auth = el("div", { class: "auth-group" });
      auth.append(out);
      bar.append(auth);
    }),
    Match.tag("Public", () => {
      const nav = el("nav", { "aria-label": "Account" });
      nav.append(el("a", { href: "#/signin" }, "Sign in"));
      bar.append(nav);
    }),
    Match.exhaustive,
  );
  const main = el("main", { id: "main" });
  wrap.append(bar, main);
  root.append(skip, wrap);
}

function route(hash: string, ctx: PageContext): void {
  const path = hash.split("?")[0];
  switch (path) {
    case "#/signin": return render_signin(ctx);
    case "#/approve": return render_approve(ctx);
    case "#/account": return render_account(ctx);
    case "#/forge": return render_forge(ctx);
    case "#/machines": return render_machines(ctx);
    case "#/sessions": return render_sessions(ctx);
    case "#/security": return render_security(ctx);
    case "#/vault": return render_vault(ctx);
    case "#/config": return render_config(ctx);
    case "#/activity": return render_activity(ctx);
    case "#/danger": return render_danger(ctx);
    default:
      location.hash = "#/account";
  }
}

const root = document.getElementById("app");
if (root) create_app(root, new CoreApi(""));
