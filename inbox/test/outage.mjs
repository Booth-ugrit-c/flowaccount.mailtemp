import path from "node:path";
import { execFileSync } from "node:child_process";
import { launchBrowser } from "./browser.mjs";

const base = process.env.INBOX_URL;
const project = process.env.OUTAGE_PROJECT;
const shotDir = process.argv[2];
if (!base || !project || project === "capture-poc") throw new Error("outage.mjs only runs against an isolated project");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${detail})`}`);
  if (!ok) failures += 1;
};
const compose = (...args) => execFileSync("docker", ["compose", "-p", project, ...args], { stdio: "pipe" });
const seconds = (since) => ((Date.now() - since) / 1000).toFixed(1);

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1366, height: 800 }, colorScheme: "light" });
const page = await context.newPage();
const banner = page.locator("#statusBanner");

async function waitBanner(text, level, label) {
  const started = Date.now();
  const shown = await banner.filter({ hasText: text }).waitFor({ state: "visible", timeout: 40000 }).then(() => true, () => false);
  const cls = shown ? await banner.getAttribute("class") : "";
  check(`${label}: ${level} banner appears (${seconds(started)} s)`, shown && cls.includes(`alert-${level}`), `class=${cls}`);
  return shown;
}

async function waitHidden(label) {
  const started = Date.now();
  const hidden = await banner.waitFor({ state: "hidden", timeout: 40000 }).then(() => true, () => false);
  check(`${label}: banner disappears after recovery (${seconds(started)} s)`, hidden);
}

async function shoot(name) {
  if (!shotDir) return;
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shotDir, `banner-${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

async function waitStatus(service, wanted) {
  for (let i = 0; i < 60; i += 1) {
    const body = await fetch(`${base}/api/status`, { cache: "no-store" }).then((r) => r.json()).catch(() => null);
    if (body && body[service] === wanted) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

await page.goto(base);
await page.fill("#user", `outage-${Math.random().toString(36).slice(2, 8)}`);
await page.click("#go");
await page.waitForSelector("#sideList [data-addr]");
await page.waitForTimeout(6500);
check("healthy: no banner on the inbox view", await banner.isHidden());

compose("stop", "mailpit");
if (await waitBanner("Inbox service is down. Your mail is safe and will appear when it is back.", "danger", "mailpit down")) {
  await shoot("mailpit-down");
  const entry = await (await browser.newContext({ viewport: { width: 1366, height: 800 } })).newPage();
  await entry.goto(base);
  const onEntry = await entry.locator("#statusBanner").filter({ hasText: "Inbox service is down" }).waitFor({ state: "visible", timeout: 20000 }).then(() => true, () => false);
  check("mailpit down: the banner also shows on the entry card", onEntry && (await entry.locator("#entryView").isVisible()));
  await entry.close();
}
compose("start", "mailpit");
await waitHidden("mailpit back");

compose("stop", "bridge");
await waitBanner("New mail is delayed. It is queued and will arrive when the service recovers.", "warning", "bridge down");
await shoot("bridge-down");
compose("start", "bridge");
await waitHidden("bridge back");

compose("stop", "inbox");
await waitBanner("Lost connection to the mail service. Retrying", "danger", "inbox app unreachable");
await shoot("lost-connection");
compose("start", "inbox");
await waitHidden("inbox app back");
await waitStatus("mailpit", "ok");

await browser.close();
process.exit(failures === 0 ? 0 : 1);
