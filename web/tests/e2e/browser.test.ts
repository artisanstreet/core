// Playwright-rendered browser flows against the labeled MOCK Core+Relay
// (tests/e2e/mock.ts) — real Chromium, real built bundle, real grant JWTs,
// real Noise XX handshake, real chunked tunnel answers. The mock is UI
// State testing only: it is NOT Core/Relay and proves nothing about them.
// Screenshots land in tests/e2e/shots/ for root visual review.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Locator } from "playwright-core";
import { startMock, type MockHandles } from "./mock.ts";

/** expect.poll-based visibility (vitest's expect has no Playwright matchers). */
async function shown(locator: Locator, timeout = 30_000): Promise<void> {
  await expect.poll(async () => locator.isVisible(), { timeout }).toBe(true);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const shots = join(dirname(fileURLToPath(import.meta.url)), "shots");

const CHROME = "/home/sander/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

let mock: MockHandles;
let browser: Browser;

async function outboxToken(): Promise<string> {
  const res = await fetch(`${mock.url}/mock/outbox`);
  const body = (await res.json()) as { tokens: string[] };
  const last = body.tokens[body.tokens.length - 1];
  if (!last) throw new Error("mock outbox empty");
  return last;
}

async function newContext(): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  await ctx.addInitScript((base: string) => {
    localStorage.setItem("ast-core:relay-ws", base.replace(/^http/, "ws"));
    localStorage.setItem("ast-core:relay-http", base);
  }, mock.url);
  return ctx;
}

interface MailedLink {
  tab1: import("playwright-core").Page;
  tab2: import("playwright-core").Page;
}

/**
 * The real mailed-link journey: tab1 requests the link; the email opens in
 * a NEW tab (tab2, same browser — no shared sessionStorage), which follows
 * the actual /v1/auth/magic/confirm URL and hands off to the portal.
 * Approval happens in tab2; finishing happens in tab1.
 */
async function signInViaMailedLink(ctx: BrowserContext, email: string): Promise<MailedLink> {
  const tab1 = await ctx.newPage();
  await tab1.goto(`${mock.url}/#/signin`);
  await tab1.fill("#signin-email", email);
  await tab1.click("form button[type=submit]");
  await tab1.waitForSelector("#signin-progress:not([hidden])");
  const token = await outboxToken();
  const tab2 = await ctx.newPage();
  await tab2.goto(`${mock.url}/v1/auth/magic/confirm?token=${encodeURIComponent(token)}`);
  await shown(tab2.locator("text=Approve this sign-in?"));
  return { tab1, tab2 };
}

/** Click the handoff from the mailed confirm page into the portal. */
async function continueToPortal(tab2: import("playwright-core").Page): Promise<void> {
  await tab2.click("#continue");
  await tab2.waitForURL(/#\/approve\?token=/);
}

beforeAll(async () => {
  if (!existsSync(join(root, "dist", "index.html"))) {
    throw new Error("web/dist is missing: run `npm run build` in core/web first (Core author wires dist into the worker; see docs/browser.md).");
  }
  mkdirSync(shots, { recursive: true });
  mock = await startMock(join(root, "dist"));
  browser = await chromium.launch({ executablePath: CHROME });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await mock?.close();
});


describe("rendered browser flows (mock backend, labeled)", () => {
  it("signs in, shows the account portal shell", async () => {
    const ctx = await newContext();
    const { tab1, tab2 } = await signInViaMailedLink(ctx, "cafe@example.com");
    await tab1.screenshot({ path: join(shots, "00-signin.png") });
    await tab2.screenshot({ path: join(shots, "00-confirm.png") });
    await continueToPortal(tab2);
    await tab2.click("text=Approve this request");
    // The new tab holds no request secret: it approves, tab1 finishes.
    await shown(tab2.locator("text=finish in the tab that requested the link"));
    await tab2.screenshot({ path: join(shots, "01-approve.png") });
    await shown(tab1.getByRole("button", { name: "Finish sign-in" }));
    await tab1.getByRole("button", { name: "Finish sign-in" }).click();
    await tab1.waitForURL(/#\/account/);
    await shown(tab1.locator("text=Cafe User"));
    await shown(tab1.locator("text=Machines on this account"));
    await tab1.screenshot({ path: join(shots, "02-account-shell.png"), fullPage: true });
    await ctx.close();
  }, 120_000);

  it("TOTP path: finishing without the code is a readable error, not a sign-in", async () => {
    const ctx = await newContext();
    const { tab1, tab2 } = await signInViaMailedLink(ctx, "totp@example.com");
    await continueToPortal(tab2);
    await tab2.click("text=Approve this request");
    await shown(tab1.getByRole("button", { name: "Finish sign-in" }));
    await tab1.screenshot({ path: join(shots, "03-totp-required.png") });
    // The TOTP field exists on the originating tab; submit empty.
    await tab1.getByRole("button", { name: "Finish sign-in" }).click();
    await shown(tab1.locator("text=needs its authenticator code"));
    // Still signed out: the account page bounces to sign-in, not data.
    await tab1.goto(`${mock.url}/#/account`);
    await expect.poll(async () => tab1.locator("text=Cafe User").count()).toBe(0);
    await ctx.close();
  }, 120_000);

  it("machines: list, presence, enrollment claim", async () => {
    const ctx = await newContext();
    const { tab1, tab2 } = await signInViaMailedLink(ctx, "cafe@example.com");
    await continueToPortal(tab2);
    await tab2.click("text=Approve this request");
    await shown(tab1.getByRole("button", { name: "Finish sign-in" }));
    await tab1.getByRole("button", { name: "Finish sign-in" }).click();
    await tab1.waitForURL(/#\/account/);
    await tab1.goto(`${mock.url}/#/machines`);
    await shown(tab1.locator("text=cafe-forge"));
    await shown(tab1.locator("text=online"));
    await tab1.fill("#claim-code", "mock1234");
    await tab1.click("form button[type=submit]");
    await tab1.waitForSelector("text=Claimed enrollment");
    await shown(tab1.locator("text=Confirm it on the Forge"));
    await tab1.screenshot({ path: join(shots, "04-machines.png"), fullPage: true });
    await ctx.close();
  }, 120_000);

  it("config: publish a manifest and read it back", async () => {
    const ctx = await newContext();
    const { tab1, tab2 } = await signInViaMailedLink(ctx, "cafe@example.com");
    await continueToPortal(tab2);
    await tab2.click("text=Approve this request");
    await shown(tab1.getByRole("button", { name: "Finish sign-in" }));
    await tab1.getByRole("button", { name: "Finish sign-in" }).click();
    await tab1.waitForURL(/#\/account/);
    await tab1.goto(`${mock.url}/#/config`);
    await tab1.waitForSelector("text=No bundle published yet.");
    await tab1.click("text=Validate + publish");
    await tab1.waitForSelector("text=Published version 1.");
    await shown(tab1.locator("text=MCP servers: 1"));
    await tab1.screenshot({ path: join(shots, "08-config.png"), fullPage: true });
    await ctx.close();
  }, 120_000);

  it("forge: encrypted channel, thread list, long transcript, send, cancel, approval", async () => {
    const ctx = await newContext();
    const { tab1, tab2 } = await signInViaMailedLink(ctx, "cafe@example.com");
    await continueToPortal(tab2);
    await tab2.click("text=Approve this request");
    await shown(tab1.getByRole("button", { name: "Finish sign-in" }));
    await tab1.getByRole("button", { name: "Finish sign-in" }).click();
    await tab1.waitForURL(/#\/account/);
    await tab1.goto(`${mock.url}/#/forge`);
    await tab1.click("text=Connect encrypted channel");
    await tab1.waitForSelector("text=Encrypted channel open", { timeout: 30_000 });
    await tab1.waitForSelector("text=Mock: long transcript");
    await tab1.screenshot({ path: join(shots, "05-forge-connected.png") });
    await tab1.click("text=Mock: long transcript");
    // The 73 KiB transcript arrives chunked and renders whole (no silent
    // cap): wait for the actual content length, not first visibility.
    const body = tab1.locator(".thread-body").first();
    await expect.poll(async () => ((await body.textContent()) ?? "").length, { timeout: 30_000 }).toBeGreaterThan(60_000);
    await tab1.screenshot({ path: join(shots, "06-thread-long.png") });
    await tab1.fill("#send-thread_long", "hello mock forge");
    await tab1.getByRole("button", { name: "Send", exact: true }).click();
    await tab1.waitForSelector("text=Sent.");
    await tab1.click("text=Cancel the live run");
    await tab1.waitForSelector("text=Cancel requested.");
    // Approval flow on the short thread.
    await tab1.click("text=Mock: short thread");
    await tab1.waitForSelector("text=Waiting on your decision.");
    await tab1.click("text=Allow once");
    await tab1.waitForSelector("text=Answered: allow_once.");
    await tab1.screenshot({ path: join(shots, "07-thread-short.png"), fullPage: true });
    await ctx.close();
  }, 180_000);

  it("accessibility: axe + rendered contrast (Color.js), mobile, keyboard", async () => {
    const ctx = await newContext();
    const { tab1, tab2 } = await signInViaMailedLink(ctx, "cafe@example.com");
    await continueToPortal(tab2);
    await tab2.click("text=Approve this request");
    await shown(tab1.getByRole("button", { name: "Finish sign-in" }));
    await tab1.getByRole("button", { name: "Finish sign-in" }).click();
    await tab1.waitForURL(/#\/account/);
    const axePath = import.meta.resolve("axe-core");
    const axeFile = axePath.startsWith("file://") ? new URL(axePath).pathname : axePath;
    const src = readFileSync(axeFile.includes("/axe.js") ? axeFile : join(axeFile, "..", "axe.min.js"), "utf8");
    await tab1.addScriptTag({ content: src });
    const violations = await tab1.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (el: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; impact?: string; nodes: unknown[] }> }> } }).axe;
      const res = await axe.run(document, { runOnly: ["color-contrast", "label", "link-name", "button-name", "aria-required-attr"] });
      return res.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
    });
    const serious = violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(serious, JSON.stringify(violations)).toEqual([]);
    // Rendered contrast via Color.js on computed styles (not hardcoded
    // pairs, not eyeballing): text and controls against their backgrounds.
    const { default: Color } = await import("colorjs.io");
    const samples = await tab1.evaluate(() => {
      const css = (el: Element | null, prop: string) => (el ? getComputedStyle(el).getPropertyValue(prop) : "");
      const link = document.querySelector(".topbar nav a");
      const muted = document.querySelector(".card .muted");
      const card = document.querySelector(".card");
      const btn = document.querySelector("button");
      return {
        linkFg: css(link, "color"),
        bodyBg: css(document.body, "background-color"),
        mutedFg: css(muted, "color"),
        cardBg: css(card, "background-color"),
        btnBg: btn ? css(btn, "background-color") : "",
        btnFg: btn ? css(btn, "color") : "",
        hasButton: !!btn,
      };
    });
    const ratio = (a: string, b: string) => new Color(a).contrast(new Color(b), "WCAG21") as number;
    expect(ratio(samples.linkFg, samples.bodyBg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(samples.mutedFg, samples.cardBg)).toBeGreaterThanOrEqual(4.5);
    // Buttons live on the sign-in form; sample the rendered primary button.
    await tab1.goto(`${mock.url}/#/signin`);
    const btnSample = await tab1.evaluate(() => {
      const css = (el: Element | null, prop: string) => (el ? getComputedStyle(el).getPropertyValue(prop) : "");
      const btn = document.querySelector("form button[type=submit]");
      return { bg: css(btn, "background-color"), fg: css(btn, "color") };
    });
    expect(btnSample.bg.length).toBeGreaterThan(0);
    expect(ratio(btnSample.fg, btnSample.bg)).toBeGreaterThanOrEqual(4.5);
    // Keyboard: tab from the top reaches nav and controls with a visible
    // focus indicator; the order follows the visual order.
    await tab1.goto(`${mock.url}/#/account`);
    await shown(tab1.locator("text=Account details"));
    await tab1.locator("body").click();
    const focusTrail: string[] = [];
    for (let i = 0; i < 12; i++) {
      await tab1.keyboard.press("Tab");
      const desc = await tab1.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return "body";
        const style = getComputedStyle(el);
        const outlined = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
        return `${el.tagName.toLowerCase()}:${(el.textContent ?? "").trim().slice(0, 24)}${outlined ? ":outlined" : ":NO-OUTLINE"}`;
      });
      focusTrail.push(desc);
      if (desc === "body") break;
    }
    expect(focusTrail[0]).toMatch(/^(a|summary):/);
    expect(focusTrail.some((f) => f.includes(":NO-OUTLINE"))).toBe(false);
    expect(focusTrail.filter((f) => f.startsWith("a:")).length).toBeGreaterThan(3);
    await ctx.close();
  }, 120_000);

  it("mobile viewport reflows without horizontal scroll", async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addInitScript((base: string) => {
      localStorage.setItem("ast-core:relay-ws", base.replace(/^http/, "ws"));
      localStorage.setItem("ast-core:relay-http", base);
    }, mock.url);
    const page = await ctx.newPage();
    await page.goto(`${mock.url}/#/signin`);
    await page.screenshot({ path: join(shots, "08-mobile-signin.png") });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
    await ctx.close();
  }, 120_000);
});
