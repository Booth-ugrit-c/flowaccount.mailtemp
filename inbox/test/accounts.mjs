import path from "node:path";
import { launchBrowser } from "./browser.mjs";

const base = process.env.INBOX_URL ?? "http://127.0.0.1:8090";
const [nameA, nameB, subjectA, subjectB, shotDir] = process.argv.slice(2);
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${detail})`}`);
  if (!ok) failures += 1;
};

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1366, height: 800 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await context.newPage();
const side = page.locator("#sideList");
const rows = () => side.locator("[data-account]");
const activeName = () => side.locator("[data-account].list-group-item-primary").getAttribute("data-account");
const hasMail = async (subject) => (await page.locator("#message-page .message", { hasText: subject }).count()) > 0;
const settle = (ms = 1500) => page.waitForTimeout(ms);
const openAddress = async (name) => {
  await page.fill("#user", name);
  await page.click("#go");
  await settle();
};

await page.goto(base);
await openAddress(nameA);
check("first address opens its inbox", await hasMail(subjectA));
check("account list shows the first address as active", (await rows().count()) === 1 && (await activeName()) === nameA);

await side.locator("[data-act=add]").click();
check("Add address shows the entry field", await page.locator("#user").isVisible());
await openAddress(nameB);
check("second address opens a different inbox", (await hasMail(subjectB)) && !(await hasMail(subjectA)));
check("account list shows both with the second active", (await rows().count()) === 2 && (await activeName()) === nameB);

await side.locator(`[data-account="${nameA}"] [data-act=switch]`).click();
await settle();
check("switching to the first address shows its mail only", (await hasMail(subjectA)) && !(await hasMail(subjectB)));
check("active mark follows the switch", (await activeName()) === nameA);

await side.locator("[data-act=add]").click();
let randomRequests = 0;
page.on("request", (req) => { if (new URL(req.url()).pathname === "/api/random") randomRequests += 1; });
const randomBtn = page.getByRole("button", { name: "Random username" });
check("Random username button has an aria-label and a tooltip", (await randomBtn.getAttribute("aria-label")) === "Random username" && (await randomBtn.getAttribute("title")) === "Random username");
check("Random username button shows no visible text", (await randomBtn.innerText()).trim() === "");
const randomWidth = (await randomBtn.boundingBox()).width;
const inputBox = await page.locator("#user").boundingBox();
const buttonBox = await randomBtn.boundingBox();
check("Random username button sits inside the username input box", buttonBox.x >= inputBox.x && buttonBox.x + buttonBox.width <= inputBox.x + inputBox.width + 0.5 && buttonBox.y >= inputBox.y && buttonBox.y + buttonBox.height <= inputBox.y + inputBox.height + 0.5, JSON.stringify({ inputBox, buttonBox }));
const suffixBox = await page.locator(".input-group-text", { hasText: "@booth.pp.ua" }).boundingBox();
check("the suffix is the last item of the row, after the input", suffixBox.x >= inputBox.x + inputBox.width - 1);
await randomBtn.click();
await page.waitForFunction(() => /^rand-[a-z0-9]{6}$/.test(document.getElementById("user").value));
const first = await page.inputValue("#user");
check("Random Username click fires one request", randomRequests === 1, String(randomRequests));
check("Random Username button is disabled with a countdown", (await randomBtn.isDisabled()) && /^[1-2]$/.test((await randomBtn.innerText()).trim()), (await randomBtn.innerText()).trim());
check("Random username button keeps its width during the cooldown", Math.abs((await randomBtn.boundingBox()).width - randomWidth) < 1);
await randomBtn.click({ force: true, timeout: 500 }).catch(() => {});
await page.waitForTimeout(300);
check("a click inside the 2 s cooldown fires no request", randomRequests === 1, String(randomRequests));
await page.waitForTimeout(2000);
check("Random Username is enabled again after the cooldown", (await randomBtn.isEnabled()) && (await randomBtn.innerText()).trim() === "");
await randomBtn.click();
await page.waitForFunction((previous) => document.getElementById("user").value !== previous, first);
const second = await page.inputValue("#user");
console.log(`INFO  random-name ${second}`);
check("Random Username fills rand-xxxxxx", /^rand-[a-z0-9]{6}$/.test(first), first);
check("a second click re-rolls the value", second !== first && /^rand-[a-z0-9]{6}$/.test(second), `${first} -> ${second}`);
await page.click("#go");
await settle();
check("opening the random name loads its inbox", (await page.locator("#sideList [data-addr]").textContent()) === `${second}@booth.pp.ua` && (await page.locator("#message-page .message").count()) === 0);
check("account list now has three addresses", (await rows().count()) === 3 && (await activeName()) === second);

page.once("dialog", (dialog) => dialog.dismiss());
await side.locator(`[data-account="${second}"] [data-act=forget]`).click();
await settle(500);
check("declining the confirm keeps the address", (await rows().count()) === 3);

let confirmText = "";
page.once("dialog", (dialog) => { confirmText = dialog.message(); dialog.accept(); });
await side.locator(`[data-account="${second}"] [data-act=forget]`).click();
await settle();
check("forget asks for confirmation that mail stays on the server", /stays on the server/.test(confirmText), confirmText);
check("forgotten address leaves the list", (await rows().count()) === 2 && (await side.locator(`[data-account="${second}"]`).count()) === 0);
check("another address becomes active after forget", (await activeName()) === nameB && (await hasMail(subjectB)));

await page.reload();
await settle();
check("reload keeps the remaining addresses (cookie)", (await rows().count()) === 2);

await side.locator("[data-act=copy]").click();
const copied = await side.locator("[data-copy-label]", { hasText: "Copied" }).waitFor({ timeout: 1200 }).then(() => true, () => false);
check("Copy shows Copied", copied);
const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
check("clipboard holds the active address", clip === `${nameB}@booth.pp.ua`, String(clip));
await page.waitForTimeout(1900);
check("Copy label returns after about 1.5 s", (await side.locator("[data-copy-label]").innerText()).trim() === "Copy address");

if (shotDir) {
  for (const scheme of ["light", "dark"]) {
    for (const [width, height] of [[1366, 800], [375, 700]]) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(base);
      await settle(1200);
      if (width < 768) {
        await page.click("[data-act=openMenu]");
        await page.waitForTimeout(500);
        await page.locator("#offcanvas").screenshot({ path: path.join(shotDir, `accounts-${width}-${scheme}.png`) });
        await page.click("#offcanvas [data-act=closeMenu]");
      } else {
        await side.screenshot({ path: path.join(shotDir, `accounts-${width}-${scheme}.png`) });
      }
    }
  }
  await page.setViewportSize({ width: 1366, height: 800 });
  await page.emulateMedia({ colorScheme: "light" });
}

page.on("dialog", (dialog) => dialog.accept());
await side.locator(`[data-account="${nameB}"] [data-act=forget]`).click();
await settle(800);
await side.locator(`[data-account="${nameA}"] [data-act=forget]`).click();
await settle();
check("forgetting the last address shows the entry card", await page.locator("#entryView").isVisible());
const after = await page.evaluate(() => fetch("/api/messages").then((r) => r.status));
check("reads are refused once every address is forgotten", after === 401, String(after));

await browser.close();
process.exit(failures === 0 ? 0 : 1);
