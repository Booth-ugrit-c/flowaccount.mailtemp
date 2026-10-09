import { launchBrowser } from "./browser.mjs";

const base = process.env.INBOX_URL ?? "http://127.0.0.1:8090";
const username = process.argv[2];
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${detail})`}`);
  if (!ok) failures += 1;
};

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1366, height: 800 } });
let listRequests = 0;
page.on("request", (req) => { if (new URL(req.url()).pathname === "/api/messages") listRequests += 1; });

await page.goto(base);
await page.fill("#user", username);
await page.click("#go");
await page.waitForSelector("#refreshBtn");
await page.waitForTimeout(1200);
const button = page.locator("#refreshBtn");
check("refresh button is enabled on the inbox", await button.isEnabled());

await page.waitForTimeout(500);
const before = listRequests;
await button.click();
await page.waitForTimeout(300);
check("click fires one list request immediately", listRequests === before + 1, `${listRequests - before} requests`);
check("button is disabled during the cooldown", await button.isDisabled());
const label = (await button.innerText()).trim();
check("button shows a countdown", /^Refresh [1-5]$/.test(label), label);

const afterFirst = listRequests;
await button.click({ force: true, timeout: 1000 }).catch(() => {});
await page.waitForTimeout(500);
check("second click inside 5 s fires no request", listRequests === afterFirst, `${listRequests - afterFirst} requests`);

await page.waitForTimeout(1500);
const later = (await button.innerText()).trim();
check("countdown has decreased", /^Refresh [1-4]$/.test(later) && later !== label, `${label} -> ${later}`);

await page.waitForTimeout(3600);
check("button is enabled again after about 5 s", await button.isEnabled());
check("label is back to Refresh", (await button.innerText()).trim() === "Refresh");

const beforeThird = listRequests;
await button.click();
await page.waitForTimeout(300);
check("click after the cooldown fires a request again", listRequests === beforeThird + 1, `${listRequests - beforeThird} requests`);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
