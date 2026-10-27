// Account views: profile (#/account), sessions (#/sessions), two-step
// sign-in (#/security), activity (#/activity), deletion (#/danger).
// Everything shown comes from live Core responses; empty states say so.

import type { CoreApi } from "../api.ts";
import { clear, el, idSpan, when } from "../ui.ts";
import type { PageContext } from "../main.ts";
import { friendly } from "./signin.ts";
import QRCode from "qrcode";

/** Render the otpauth URL as a local SVG QR (no external service). */
async function renderQrSvg(otpauthUrl: string): Promise<HTMLElement> {
  const wrap = el("div", { class: "qr" });
  try {
    const svg = await QRCode.toString(otpauthUrl, { type: "svg", margin: 1, width: 180 });
    const img = el("img", { alt: "Authenticator setup code" }) as HTMLImageElement;
    img.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    img.width = 180;
    img.height = 180;
    wrap.append(img);
  } catch {
    wrap.append(el("p", { class: "muted small" }, "The code image did not render — enter the details below manually."));
  }
  return wrap;
}

/** Pull the human-enterable parts out of an otpauth://totp/ URL. */
export function parseOtpauth(url: string): { account: string; secret: string } {
  try {
    const u = new URL(url);
    const label = decodeURIComponent(u.pathname.replace(/^\//, ""));
    const account = label.includes(":") ? (label.split(":").slice(1).join(":") || label) : label;
    return { account: account || "this account", secret: u.searchParams.get("secret") ?? "" };
  } catch {
    return { account: "this account", secret: "" };
  }
}

function card(title: string): { box: HTMLElement; status: HTMLElement } {
  const box = el("div", { class: "card" });
  box.append(el("h2", {}, title));
  const status = el("p", { class: "status muted", role: "status" }, "Loading…");
  box.append(status);
  return { box, status };
}

export function renderAccount(ctx: PageContext): void {
  const { root, api } = ctx;
  clear(root);
  const { box, status } = card("Account");
  root.append(box);
  void (async () => {
    try {
      const me = await api.me();
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
    } catch (err) {
      status.textContent = friendly(err);
      status.className = "status err";
    }
  })();
}

export function renderSessions(ctx: PageContext): void {
  const { root, api } = ctx;
  clear(root);
  const { box, status } = card("Sessions");
  root.append(box);
  const note = el("p", { class: "muted small" },
    "Each row is a browser holding a revocable session. Sign-in sets a persistent HttpOnly cookie (30 days): closing the tab does not sign you out — use Sign out above or revoke here. The cookie itself is never visible to scripts.");
  box.append(note);
  void (async () => {
    try {
      const list = await api.sessions();
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
        void (async () => {
          try {
            await api.revokeAllSessions();
            out.textContent = "All sessions revoked. This browser is signed out too.";
            setTimeout(() => { location.hash = "#/signin"; }, 800);
          } catch (err) {
            out.textContent = friendly(err);
          }
        })();
      });
      row.append(revokeAll);
      box.append(row, out);
    } catch (err) {
      status.textContent = friendly(err);
      status.className = "status err";
    }
  })();
}

export function renderSecurity(ctx: PageContext): void {
  const { root, api } = ctx;
  clear(root);
  const { box, status } = card("Security");
  root.append(box);
  box.append(el("p", { class: "muted small" },
    "Optional authenticator (TOTP) plus recovery codes. Email alone never bypasses it: when enrolled, finishing sign-in always needs a code."));
  void (async () => {
    try {
      const me = await api.me();
      clear(box);
      box.append(el("h2", {}, "Security"));
      if (!me.totpEnrolled) {
        box.append(enrollBox(api));
      } else {
        box.append(disableBox(api));
      }
    } catch (err) {
      status.textContent = friendly(err);
      status.className = "status err";
    }
  })();
}

function enrollBox(api: CoreApi): HTMLElement {
  const wrap = el("div", {});
  wrap.append(el("p", {}, "Not enrolled."));
  const start = el("button", { type: "button" }, "Start enrollment");
  const out = el("div", {});
  start.addEventListener("click", () => {
    void (async () => {
      try {
        const res = await api.enrollTotp();
        clear(out);
        // The QR is rendered locally from the otpauth URL — the secret
        // never goes to an external chart/QR service.
        const qr = await renderQrSvg(res.otpauthUrl);
        const { account, secret } = parseOtpauth(res.otpauthUrl);
        out.append(
          el("p", {}, "Scan the code with your authenticator, or enter the details manually:"),
          qr,
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
          void (async () => {
            try {
              const r = await api.verifyTotp(input.value.trim());
              msg.textContent = r.enrolled ? "Two-step sign-in is on." : "Not confirmed yet.";
            } catch (err) {
              msg.textContent = friendly(err);
            }
          })();
        });
        out.append(label, input, confirm, msg);
      } catch (err) {
        clear(out);
        out.append(el("p", { class: "err" }, friendly(err)));
      }
    })();
  });
  wrap.append(start, out);
  return wrap;
}

function disableBox(api: CoreApi): HTMLElement {
  const wrap = el("div", {});
  wrap.append(el("p", {}, "Enrolled. Disabling needs a current code."));
  const label = el("label", { for: "totp-disable" }, "Authenticator code");
  const input = el("input", { id: "totp-disable", type: "text", inputmode: "numeric", autocomplete: "one-time-code" }) as HTMLInputElement;
  const btn = el("button", { class: "danger", type: "button" }, "Turn off two-step sign-in");
  const msg = el("p", { class: "status", role: "status" });
  btn.addEventListener("click", () => {
    void (async () => {
      try {
        const r = await api.disableTotp(input.value.trim());
        msg.textContent = r.disabled ? "Two-step sign-in is off." : "Not disabled.";
      } catch (err) {
        msg.textContent = friendly(err);
      }
    })();
  });
  wrap.append(label, input, btn, msg);
  return wrap;
}

export function renderActivity(ctx: PageContext): void {
  const { root, api } = ctx;
  clear(root);
  const { box, status } = card("Recent activity");
  root.append(box);
  void (async () => {
    try {
      const res = await api.activity(50);
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
    } catch (err) {
      status.textContent = friendly(err);
      status.className = "status err";
    }
  })();
}

export function renderDanger(ctx: PageContext): void {
  const { root, api } = ctx;
  clear(root);
  const { box, status } = card("Delete account");
  root.append(box);
  void (async () => {
    try {
      const s = await api.deletionStatus();
      clear(box);
      box.append(el("h2", {}, "Delete account"));
      box.append(el("p", {}, `Status: ${s.status}`));
      if (s.status === "pending") {
        box.append(el("p", { class: "warn" }, `Requested ${when(s.requestedAt)}. Purge after ${when(s.purgeAfter)}.`));
        const cancel = el("button", { type: "button" }, "Cancel deletion");
        const msg = el("p", { class: "status", role: "status" });
        cancel.addEventListener("click", () => {
          void (async () => {
            try {
              await api.cancelDeletion();
              msg.textContent = "Deletion cancelled.";
            } catch (err) {
              msg.textContent = friendly(err);
            }
          })();
        });
        box.append(cancel, msg);
        return;
      }
      const me = await api.me();
      if (me.totpEnrolled) {
        const label = el("label", { for: "del-totp" }, "Authenticator code (required while two-step is on)");
        const input = el("input", { id: "del-totp", type: "text", inputmode: "numeric" }) as HTMLInputElement;
        box.append(label, input);
        const req = el("button", { class: "danger", type: "button" }, "Request deletion");
        const msg = el("p", { class: "status", role: "status" });
        req.addEventListener("click", () => {
          void (async () => {
            try {
              await api.requestDeletion(input.value.trim() || undefined);
              msg.textContent = "Deletion requested.";
            } catch (err) {
              msg.textContent = friendly(err);
            }
          })();
        });
        box.append(req, msg);
      } else {
        const req = el("button", { class: "danger", type: "button" }, "Request deletion");
        const msg = el("p", { class: "status", role: "status" });
        req.addEventListener("click", () => {
          void (async () => {
            try {
              await api.requestDeletion(undefined);
              msg.textContent = "Deletion requested.";
            } catch (err) {
              msg.textContent = friendly(err);
            }
          })();
        });
        box.append(req, msg);
      }
    } catch (err) {
      status.textContent = friendly(err);
      status.className = "status err";
    }
  })();
}
