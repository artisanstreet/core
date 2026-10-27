// @vitest-environment happy-dom
// Real form behavior: render the actual pages against a stub Core,
// drive them like a user (fill, submit, click), and assert what the UI
// does — including the security rules (no finalize without the secret,
// TOTP gating) and accessible labeling.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CoreApi } from "../src/api.ts";
import { storeRequestSecret, clearRequestSecret } from "../src/auth.ts";
import { renderSignin, renderApprove } from "../src/pages/signin.ts";
import { renderMachines } from "../src/pages/machines.ts";
import type { PageContext } from "../src/main.ts";

const REQUEST_ID = `logreq_01K${"A".repeat(23)}`;
const ACCOUNT_ID = `acct_01K${"A".repeat(23)}`;
const MACHINE_ID = `mch_01K${"A".repeat(23)}`;

function ctxWith(api: CoreApi): PageContext {
  const root = document.createElement("div");
  document.body.append(root);
  return { api, root, signal: new AbortController().signal };
}

function stubApi(handler: (url: string, init: RequestInit) => unknown) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const raw = init.body;
    const body = raw ? JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array)) : {};
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify(handler(String(url), init)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { api: new CoreApi("", { fetchImpl }), calls };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.innerHTML = "";
  location.hash = "";
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("sign-in form", () => {
  it("requests a link, polls to approved, and finishes with secret + TOTP code", async () => {
    let polls = 0;
    const { api, calls } = stubApi((url) => {
      if (url.includes("/magic/request")) return { requestId: REQUEST_ID, requestSecret: "shh", expiresAt: "2026-10-26T20:00:00.000Z" };
      if (url.includes("/magic/status")) {
        polls++;
        return polls >= 1
          ? { requestId: REQUEST_ID, status: "email_approved", totpRequired: true, email: "a@example.com", expiresAt: "2026-10-26T20:00:00.000Z" }
          : { requestId: REQUEST_ID, status: "pending", totpRequired: false, email: "a@example.com", expiresAt: "2026-10-26T20:00:00.000Z" };
      }
      if (url.includes("/magic/finalize")) {
        return { sessionId: `sess_01K${"A".repeat(23)}`, accountId: ACCOUNT_ID, expiresAt: "2026-10-26T20:00:00.000Z", totpVerified: true };
      }
      throw new Error(`unexpected ${url}`);
    });
    const ctx = ctxWith(api);
    renderSignin(ctx);

    (document.getElementById("signin-email") as HTMLInputElement).value = "a@example.com";
    (document.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();

    expect(calls.some((c) => c.url.includes("/magic/request"))).toBe(true);
    // The request secret reached tab storage (never the URL, never logged).
    expect(sessionStorage.getItem(`ast-core:secret:${REQUEST_ID}`)).toBe("shh");
    expect(location.href).not.toContain("shh");

    // Polling saw approval: finish button + TOTP field appear.
    await tick();
    const finish = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Finish sign-in"));
    expect(finish).toBeDefined();
    expect(document.getElementById("signin-totp")).not.toBeNull();

    (document.getElementById("signin-totp") as HTMLInputElement).value = "123456";
    (finish as HTMLButtonElement).click();
    await tick();

    const fin = calls.find((c) => c.url.includes("/magic/finalize"));
    expect(fin?.body).toEqual({ requestId: REQUEST_ID, requestSecret: "shh", totpCode: "123456" });
    expect(location.hash).toBe("#/account");
    // The one-use secret is dropped after use.
    expect(sessionStorage.getItem(`ast-core:secret:${REQUEST_ID}`)).toBeNull();
  });

  it("rejects a malformed email client-side with a field-level message", async () => {
    let sent = 0;
    const fetchImpl = (async () => {
      sent++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const ctx = ctxWith(new CoreApi("", { fetchImpl }));
    renderSignin(ctx);
    (document.getElementById("signin-email") as HTMLInputElement).value = "not-an-email";
    (document.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(sent).toBe(0);
    expect(document.body.textContent).toContain("Enter a valid email address.");
    expect(document.body.textContent).not.toContain("Predicate refinement");
    expect(location.hash).not.toBe("#/account");
  });

  it("stays on the form with a readable error when the server rejects the email", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: "bad_request", message: "that address cannot receive mail", requestId: "r" } }), { status: 400 })) as typeof fetch;
    const ctx = ctxWith(new CoreApi("", { fetchImpl }));
    renderSignin(ctx);
    (document.getElementById("signin-email") as HTMLInputElement).value = "a@example.com";
    (document.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(document.body.textContent).toContain("that address cannot receive mail");
    expect(location.hash).not.toBe("#/account");
  });
});

describe("approve form (email link target)", () => {
  it("approves via POST and finishes when this browser holds the secret", async () => {
    storeRequestSecret(REQUEST_ID, "shh");
    const { api, calls } = stubApi((url) => {
      if (url.includes("/magic/consume")) return { requestId: REQUEST_ID, status: "email_approved", totpRequired: false };
      if (url.includes("/magic/finalize")) {
        return { sessionId: `sess_01K${"A".repeat(23)}`, accountId: ACCOUNT_ID, expiresAt: "2026-10-26T20:00:00.000Z", totpVerified: false };
      }
      throw new Error(`unexpected ${url}`);
    });
    location.hash = "#/approve?token=emailtok";
    const ctx = ctxWith(api);
    renderApprove(ctx);
    const approveBtn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Approve"));
    (approveBtn as HTMLButtonElement).click();
    await tick();
    const cons = calls.find((c) => c.url.includes("/magic/consume"));
    expect(cons?.body).toEqual({ token: "emailtok" });
    const finishBtn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Finish sign-in"));
    expect(finishBtn).toBeDefined();
    (finishBtn as HTMLButtonElement).click();
    await tick();
    expect(calls.find((c) => c.url.includes("/magic/finalize"))?.body).toEqual({ requestId: REQUEST_ID, requestSecret: "shh" });
  });

  it("tells a different browser to finish on the originator instead", async () => {
    clearRequestSecret(REQUEST_ID);
    const { api } = stubApi((url) => {
      if (url.includes("/magic/consume")) return { requestId: REQUEST_ID, status: "email_approved", totpRequired: false };
      throw new Error(`unexpected ${url}`);
    });
    location.hash = "#/approve?token=emailtok";
    const ctx = ctxWith(api);
    renderApprove(ctx);
    const approveBtn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Approve"));
    (approveBtn as HTMLButtonElement).click();
    await tick();
    expect(document.body.textContent).toContain("finish in the tab that requested the link");
    // No finish control appears: this browser must not complete sign-in.
    expect([...document.querySelectorAll("button")].some((b) => b.textContent?.includes("Finish sign-in"))).toBe(false);
  });

  it("missing token shows the invalid-link flow, never a raw token paste box", async () => {
    const { api } = stubApi(() => {
      throw new Error("no network call should happen");
    });
    location.hash = "#/approve";
    const ctx = ctxWith(api);
    renderApprove(ctx);
    expect(document.querySelector("#approve-token")).toBeNull();
    expect(document.body.textContent).toContain("missing its token");
    const fresh = document.querySelector('a[href="#/signin"]');
    expect(fresh?.textContent).toContain("Request a new sign-in link");
  });

  it("signin offers a recovery-code alternate that reaches finalize", async () => {
    const { api, calls } = stubApi((url) => {
      if (url.includes("/magic/request")) return { requestId: REQUEST_ID, requestSecret: "shh", expiresAt: "2026-10-26T20:00:00.000Z" };
      if (url.includes("/magic/status")) return { requestId: REQUEST_ID, status: "email_approved", totpRequired: true, email: "a@example.com", expiresAt: "2026-10-26T20:00:00.000Z" };
      if (url.includes("/magic/finalize")) {
        return { sessionId: `sess_01K${"A".repeat(23)}`, accountId: `acct_01K${"A".repeat(23)}`, expiresAt: "2026-10-26T20:00:00.000Z", totpVerified: false };
      }
      throw new Error(`unexpected ${url}`);
    });
    const ctx = ctxWith(api);
    renderSignin(ctx);
    (document.getElementById("signin-email") as HTMLInputElement).value = "a@example.com";
    (document.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    await tick();
    const swap = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("recovery code"));
    expect(swap).toBeDefined();
    (swap as HTMLButtonElement).click();
    (document.getElementById("signin-rec") as HTMLInputElement).value = "r1";
    const finish = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Finish sign-in"));
    (finish as HTMLButtonElement).click();
    await tick();
    expect(calls.find((c) => c.url.includes("/magic/finalize"))?.body).toEqual({
      requestId: REQUEST_ID,
      requestSecret: "shh",
      recoveryCode: "r1",
    });
  });
});

describe("machines form", () => {
  it("claims an enrollment code and explains the Forge-side confirm", async () => {
    const enrollmentId = `enr_01K${"A".repeat(23)}`;
    const { api, calls } = stubApi((url) => {
      if (url.includes("/machines") && !url.includes("claim")) return { machines: [] };
      if (url.includes("/enrollments/claim")) return { enrollmentId, status: "claimed" };
      if (url.includes("/me")) return { accountId: ACCOUNT_ID, email: "a@example.com", displayName: "", totpEnrolled: false, machines: [], providerConnections: [], latestConfigVersion: null };
      if (url.includes("/grants/issue")) return { token: "t", expiresAt: "2026-10-26T20:00:00.000Z" };
      throw new Error(`unexpected ${url}`);
    });
    const ctx = ctxWith(api);
    renderMachines(ctx);
    await tick();
    (document.getElementById("claim-code") as HTMLInputElement).value = "abcdefgh";
    (document.querySelectorAll("form")[0] as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(calls.find((c) => c.url.includes("/enrollments/claim"))?.body).toEqual({ code: "ABCDEFGH" });
    expect(document.body.textContent).toContain("Confirm it on the Forge");
  });
});

describe("accessibility of rendered forms", () => {
  it("every input has a label, buttons are named", async () => {
    const { api } = stubApi((url) => {
      if (url.includes("/magic/request")) return { requestId: REQUEST_ID, requestSecret: "shh", expiresAt: "2026-10-26T20:00:00.000Z" };
      if (url.includes("/magic/status")) return { requestId: REQUEST_ID, status: "pending", totpRequired: false, email: "a@example.com", expiresAt: "2026-10-26T20:00:00.000Z" };
      throw new Error(`unexpected ${url}`);
    });
    renderSignin(ctxWith(api));
    (document.getElementById("signin-email") as HTMLInputElement).value = "a@example.com";
    (document.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    await tick(60);
    for (const input of document.querySelectorAll("input, textarea, select")) {
      const id = input.getAttribute("id");
      const labelled = (id && document.querySelector(`label[for="${id}"]`)) || input.closest("label");
      expect(labelled, `unlabelled control #${id ?? input.tagName}`).toBeTruthy();
    }
    for (const btn of document.querySelectorAll("button")) {
      expect(btn.textContent?.trim().length).toBeGreaterThan(0);
    }
  });
});
