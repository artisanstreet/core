// Real-Core HTTP + mailed-link smoke (NOT the mock): same-origin UI at
// :5173 (vite proxy → real Core :8788), real magic-link email via the
// log mailer, real confirm URL incl. the Core 302 handoff to the SPA.
// Proves the shipped path: mailed link → approve → session → account data.
// Labels what it touches: one dev-DB account row (reported, not cleaned).

import { chromium } from "playwright-core";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = join(root, "tests", "e2e", "shots");
mkdirSync(shots, { recursive: true });

const UI = "http://127.0.0.1:5173";
const EMAIL = "cafe-smoke@example.com";

async function main() {
  // 1. Contract surface on the real service.
  const version = await (await fetch(`${UI}/v1/version`)).json();
  console.log("version:", JSON.stringify(version));
  if (version.api !== "1") throw new Error("bad version");
  const meAnon = await fetch(`${UI}/v1/me`);
  console.log("me-anon:", meAnon.status);
  if (meAnon.status !== 401) throw new Error("me must 401 without a session");
  const strict = await fetch(`${UI}/v1/auth/magic/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, extra: 1 }),
  });
  console.log("strict-unknown-field:", strict.status);
  if (strict.status !== 400) throw new Error("strict requests must 400");

  // 2. Real mailed link through the browser.
  const browser = await chromium.launch({ executablePath: "/home/sander/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome" });
  const ctx = await browser.newContext();
  const tab1 = await ctx.newPage();
  await tab1.goto(`${UI}/#/signin`);
  await tab1.fill("#signin-email", EMAIL);
  await tab1.click("form button[type=submit]");
  await tab1.waitForSelector("#signin-progress:not([hidden])", { timeout: 15000 });

  // The log mailer prints the confirm URL to Core's stdout.
  const log = readFileSync("/tmp/opencode/core-dev.log", "utf8");
  const urls = [...log.matchAll(/https?:\/\/[^\s"']*\/v1\/auth\/magic\/confirm\?token=[A-Za-z0-9_-]+/g)].map((m) => m[0]);
  if (urls.length === 0) throw new Error("no mailed link in Core log");
  const mailed = urls[urls.length - 1];
  if (!mailed) throw new Error("no mailed link in Core log");
  console.log("mailed-link:", mailed.replace(/token=.*/, "token=<redacted>").replace("http://127.0.0.1:5173", "<ui>"));
  if (!mailed.startsWith("http://127.0.0.1:5173")) throw new Error("mailed link must point at the UI origin under test");

  // Email opens in a NEW tab: the real confirm URL (Core 302s to the SPA).
  // The dev DB flakes intermittently (reported); approve/finalize retry
  // bounded times — consume only marks approval, finalize success is
  // verified by session state, not by the click response.
  const tab2 = await ctx.newPage();
  const resp = await tab2.goto(mailed);
  console.log("confirm-status:", resp?.status(), "landed:", tab2.url().replace(/token=.*/, "token=<redacted>"));
  let approved = false;
  for (let i = 0; i < 4 && !approved; i++) {
    await tab2.getByRole("button", { name: "Approve this request" }).click();
    await tab2.waitForTimeout(2500);
    const msgs = await tab2.locator("p.status").allTextContents();
    console.log(`approve attempt ${i}:`, JSON.stringify(msgs));
    approved = msgs.some((m) => m.includes("finish in the tab"));
    if (!approved) await tab2.waitForTimeout(2000);
  }
  if (!approved) throw new Error("approve never landed (dev-DB flakes?)");
  for (let i = 0; i < 30; i++) {
    await tab1.waitForTimeout(2000);
    if (await tab1.getByRole("button", { name: "Finish sign-in" }).count()) break;
  }
  const fin = tab1.getByRole("button", { name: "Finish sign-in" });
  console.log("tab1 finish buttons:", await fin.count());
  console.log("tab1 progress:", JSON.stringify((await tab1.locator("#signin-progress").textContent())?.slice(0, 200)));
  for (let i = 0; i < 4; i++) {
    if (await fin.count()) {
      await fin.click();
      await tab1.waitForTimeout(3000);
    }
    const hash = await tab1.evaluate(() => location.hash);
    let done = "";
    if (!hash.startsWith("#/account")) {
      // Finalize may have succeeded server-side despite a flaky response:
      // session state is the truth, not the click response.
      const status = tab1.locator("#signin-progress .status").last();
      if (await status.count()) done = (await status.textContent()) ?? "";
      console.log("tab1 hash:", hash, "| done:", JSON.stringify(done.slice(0, 120)));
      await tab1.goto(`${UI}/#/account`);
      await tab1.waitForTimeout(1500);
      if ((await tab1.evaluate(() => location.hash)).startsWith("#/account")) break;
    } else {
      console.log("tab1 hash:", hash);
      break;
    }
  }
  await tab1.waitForURL(/#\/account/, { timeout: 15000 });
  await tab1.waitForSelector("text=Cafe User", { timeout: 15000 }).catch(() => undefined);
  const who = await tab1.locator(".card").first().textContent();
  console.log("account-card:", JSON.stringify(who?.slice(0, 120)));
  if (!who || !who.includes(EMAIL)) throw new Error("signed-in account mismatch");
  await tab1.screenshot({ path: join(shots, "real-10-account.png"), fullPage: true });

  // 3. Sessions + sign-out against the real service.
  await tab1.goto(`${UI}/#/sessions`);
  await tab1.waitForSelector("text=Sessions", { timeout: 15000 });
  await tab1.screenshot({ path: join(shots, "real-11-sessions.png") });
  await tab1.goto(`${UI}/#/account`);
  await tab1.click("#signout");
  await tab1.waitForURL(/#\/signin/, { timeout: 15000 });
  console.log("sign-out ok");
  await browser.close();
  console.log("REAL-CORE SMOKE OK (dev-DB row:", EMAIL + ")");
}

await main();
