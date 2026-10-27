// App shell: hash router, top navigation, sign-out. Session auth is the
// HttpOnly `ast_session` cookie (never JS-readable); a 401 on any page
// sends the user back to #/signin. The server-rendered /ui/* pages remain
// the fallback when this bundle is not deployed.

import { CoreApi, ApiError } from "./api.ts";
import { clear, el } from "./ui.ts";
import { renderSignin, renderApprove, friendly } from "./pages/signin.ts";
import { renderAccount, renderSessions, renderSecurity, renderActivity, renderDanger } from "./pages/account.ts";
import { renderMachines } from "./pages/machines.ts";
import { renderVault } from "./pages/vault.ts";
import { renderConfig } from "./pages/config.ts";
import { renderForge } from "./pages/forgeview.ts";

export interface PageContext {
  api: CoreApi;
  root: HTMLElement;
  /**
   * Aborted when the user navigates away. Pages must stop timers, feeds,
   * and detached callbacks on abort — no polling or state writes after
   * the route is gone.
   */
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

export function createApp(root: HTMLElement, api: CoreApi): void {
  let generation = 0;
  let current: AbortController | null = null;

  const render = () => {
    const myGeneration = ++generation;
    current?.abort();
    const controller = new AbortController();
    current = controller;
    const fresh = () => myGeneration === generation && !controller.signal.aborted;
    const mainOf = () => root.querySelector("main") as HTMLElement | null;
    const hash = location.hash || "#/account";
    const path = hash.split("?")[0];
    if (PUBLIC_HASHES.includes(path ?? "")) {
      renderShell(root, api, false);
      const main = mainOf();
      if (main) route(hash, { api, root: main, signal: controller.signal });
      return;
    }
    // Protected area: confirm the session before showing its navigation.
    // The session cookie is HttpOnly, so this is a real /v1/me read —
    // signed-out visitors see only the brand and Sign in.
    renderShell(root, api, false);
    const main = mainOf();
    if (main) main.append(el("p", { class: "muted" }, "Checking your session…"));
    void (async () => {
      try {
        await api.me();
        if (!fresh()) return; // the user already navigated elsewhere
        renderShell(root, api, true);
        const next = mainOf();
        if (next) route(hash, { api, root: next, signal: controller.signal });
      } catch (err) {
        if (!fresh()) return;
        if (err instanceof ApiError && err.status === 401) {
          location.hash = "#/signin";
          return;
        }
        const stale = mainOf();
        if (stale) {
          clear(stale);
          stale.append(el("div", { class: "card" }, el("p", { class: "err" }, friendly(err))));
        }
      }
    })();
  };
  window.addEventListener("hashchange", render);
  render();
}

function renderShell(root: HTMLElement, api: CoreApi, authenticated: boolean): void {
  clear(root);
  const skip = el("a", { class: "skip-link", href: "#main" }, "Skip to content");
  const wrap = el("div", { class: "wrap" });
  const bar = el("div", { class: "topbar" });
  bar.append(el("a", { class: "brand", href: authenticated ? "#/account" : "#/signin" }, "AST"));
  if (authenticated) {
    const nav = el("nav", { "aria-label": "Account" });
    for (const n of NAV) nav.append(el("a", { href: n.hash }, n.label));
    bar.append(nav);
    const out = el("a", { href: "#/signin", id: "signout" }, "Sign out");
    out.addEventListener("click", (e) => {
      e.preventDefault();
      void (async () => {
        try {
          await api.revokeCurrentSession();
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 401) {
            // Revocation failed but the cookie may still be live; the
            // sign-in page will say so if the session survives.
          }
        }
        location.hash = "#/signin";
      })();
    });
    // Sign out lives in its own right-aligned group so narrow viewports
    // wrap it as a group, never as a lone orphan under the nav row.
    const auth = el("div", { class: "auth-group" });
    auth.append(out);
    bar.append(auth);
  } else {
    const nav = el("nav", { "aria-label": "Account" });
    nav.append(el("a", { href: "#/signin" }, "Sign in"));
    bar.append(nav);
  }
  const main = el("main", { id: "main" });
  wrap.append(bar, main);
  root.append(skip, wrap);
}

function route(hash: string, ctx: PageContext): void {
  const path = hash.split("?")[0];
  switch (path) {
    case "#/signin": return renderSignin(ctx);
    case "#/approve": return renderApprove(ctx);
    case "#/account": return renderAccount(ctx);
    case "#/forge": return renderForge(ctx);
    case "#/machines": return renderMachines(ctx);
    case "#/sessions": return renderSessions(ctx);
    case "#/security": return renderSecurity(ctx);
    case "#/vault": return renderVault(ctx);
    case "#/config": return renderConfig(ctx);
    case "#/activity": return renderActivity(ctx);
    case "#/danger": return renderDanger(ctx);
    default:
      location.hash = "#/account";
  }
}

const root = document.getElementById("app");
if (root) createApp(root, new CoreApi(""));
