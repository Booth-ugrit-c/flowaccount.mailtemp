import { launchBrowser } from "./browser.mjs";

const base = process.env.INBOX_URL ?? "http://127.0.0.1:8090";
const [prefix, countText, extraName] = process.argv.slice(2);
const count = Number(countText);
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${detail})`}`);
  if (!ok) failures += 1;
};

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1366, height: 800 } });
const page = await context.newPage();
const side = page.locator("#sideList");
const list = side.locator("[data-accounts]");
const rows = side.locator("[data-account]");
const settle = (ms = 1200) => page.waitForTimeout(ms);
const cookieLength = async () => (await context.cookies(base)).find((c) => c.name === "inboxes")?.value.length ?? 0;
const inView = (box) => box && box.y >= 0 && box.y + box.height <= 800 && box.x >= 0 && box.x + box.width <= 1366;

await page.goto(base);
await page.locator("#spot").waitFor({ state: "visible" });
const lengths = [];
for (let i = 1; i <= count; i += 1) {
  const status = await page.evaluate((name) => fetch("/api/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: name }) }).then((r) => r.status), `${prefix}-${i}`);
  if (status !== 200) check(`open ${prefix}-${i}`, false, String(status));
  if ([1, 10, count].includes(i)) lengths.push(await cookieLength());
}
check(`the cookie length is the same with 1, 10 and ${count} addresses`, new Set(lengths).size === 1 && lengths[0] > 0, lengths.join());
console.log(`INFO  cookie value length ${lengths.join(" ")}`);

await page.reload();
await settle();
check(`all ${count} addresses survive a reload`, (await rows.count()) === count, String(await rows.count()));
check("the last opened address is active after the reload", (await side.locator("[data-account].list-group-item-primary").getAttribute("data-account")) === `${prefix}-${count}`);
const metrics = await list.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, top: el.scrollTop, overflow: getComputedStyle(el).overflowY }));
check("the address list scrolls inside a bounded box", metrics.overflow === "auto" && metrics.scroll > metrics.client && metrics.client <= 0.4 * 800 + 1, JSON.stringify(metrics));
check("the active address is scrolled into view", metrics.top > 0 && inView(await side.locator("[data-account].list-group-item-primary").boundingBox()));
const addBox = await side.locator("[data-act=add]").boundingBox();
check("Add address stays reachable without scrolling the whole sidebar", inView(addBox), JSON.stringify(addBox));
check("Add address is enabled with this many addresses", await side.locator("[data-act=add]").isEnabled());

await list.evaluate((el) => { el.scrollTop = 0; });
await page.locator(`#sideList [data-account="${prefix}-2"] [data-act=switch]`).click();
await settle();
check("switching from the top of the list makes that address active", (await side.locator("[data-account].list-group-item-primary").getAttribute("data-account")) === `${prefix}-2`);
await list.evaluate((el) => { el.scrollTop = 120; });
await page.locator("#refreshBtn").click();
await settle(800);
check("a refresh keeps the list scroll position", (await list.evaluate((el) => el.scrollTop)) > 0);

page.on("dialog", (dialog) => dialog.accept());
await side.locator(`[data-account="${prefix}-30"] [data-act=forget]`).click();
await settle();
check("forgetting one of many leaves the others", (await rows.count()) === count - 1);

if (extraName) {
  await side.locator("[data-act=add]").click();
  await page.fill("#user", extraName);
  await page.keyboard.press("Enter");
  await settle();
  check("a new address can still be added to a long list", (await rows.count()) === count && (await side.locator("[data-account].list-group-item-primary").getAttribute("data-account")) === extraName);
}

const phone = await browser.newContext({ viewport: { width: 375, height: 700 } });
const phonePage = await phone.newPage();
await phone.addCookies(await context.cookies(base));
await phonePage.goto(base);
await phonePage.waitForTimeout(1500);
await phonePage.click("[data-act=openMenu]");
await phonePage.waitForTimeout(500);
const phoneList = phonePage.locator("#offBody [data-accounts]");
const phoneMetrics = await phoneList.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
check("narrow: the address list scrolls inside a bounded box", phoneMetrics.scroll > phoneMetrics.client && phoneMetrics.client <= 0.4 * 700 + 1, JSON.stringify(phoneMetrics));
await phone.close();

await browser.close();
process.exit(failures === 0 ? 0 : 1);
