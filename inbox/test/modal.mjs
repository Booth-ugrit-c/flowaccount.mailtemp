import { launchBrowser } from "./browser.mjs";

const base = process.env.INBOX_URL ?? "http://127.0.0.1:8090";
const [baseName, tagName, subjectBase, subjectTag, subjectOther] = process.argv.slice(2);
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${detail})`}`);
  if (!ok) failures += 1;
};

const browser = await launchBrowser();
const settle = (page, ms = 1500) => page.waitForTimeout(ms);
const hasMail = async (page, subject) => (await page.locator("#message-page .message", { hasText: subject }).count()) > 0;
const visible = (page, selector) => page.locator(selector).isVisible();
const insideModal = (page) => page.evaluate(() => document.getElementById("addModal").contains(document.activeElement));
const topAt = (page, selector) => page.evaluate((sel) => {
  const r = document.querySelector(sel).getBoundingClientRect();
  const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return el?.closest("[data-act=add]") ? "add" : el?.id || el?.tagName;
}, selector);

const context = await browser.newContext({ viewport: { width: 1366, height: 800 } });
const page = await context.newPage();
await page.goto(base);
await page.locator("#spot").waitFor({ state: "visible" });
await settle(page, 600);

check("the entry page is gone", (await page.locator("#entryView").count()) === 0);
check("first visit shows the inbox layout", (await visible(page, "#sideList")) && (await visible(page, "#navList")));
check("first visit shows the spotlight and no modal", !(await visible(page, "#addModal")));
check("the hint tells the user to add an address", /Add an address/.test(await page.locator("#spotHint").innerText()));
check("the page is dimmed", (await page.evaluate(() => getComputedStyle(document.getElementById("spotDim")).backgroundColor)).replace(/\s/g, "").startsWith("rgba(0,0,0,0.7"));
check("the spotlight hole leaves the Add address button clickable", (await topAt(page, "#sideList [data-act=add]")) === "add");
check("the rest of the page is covered by the dim", (await topAt(page, "#refreshBtn")) === "spotDim" && (await topAt(page, "#search")) === "spotDim");
check("the Add address button has keyboard focus", await page.evaluate(() => document.activeElement?.dataset?.act === "add"));
await page.mouse.click(700, 400);
check("a click on the dimmed page does nothing", (await visible(page, "#spot")) && !(await visible(page, "#addModal")));
const hintBox = await page.locator("#spotHint").boundingBox();
const addBox = await page.locator("#sideList [data-act=add]").boundingBox();
check("the hint sits beside the button without covering it", hintBox.x >= addBox.x + addBox.width && hintBox.x + hintBox.width <= 1366, JSON.stringify({ hintBox, addBox }));

await page.locator("#sideList [data-act=add]").focus();
await page.keyboard.press("Enter");
await page.locator("#addModal").waitFor({ state: "visible" });
check("Enter on the focused Add address button opens the modal", await visible(page, "#addModal"));
check("the spotlight is gone while the modal is open", !(await visible(page, "#spot")));
check("the name input is focused", await page.evaluate(() => document.activeElement?.id === "user"));
check("the modal is a dialog with aria-modal", (await page.locator("#addModal").getAttribute("role")) === "dialog" && (await page.locator("#addModal").getAttribute("aria-modal")) === "true");
const dialogBox = await page.locator("#addModal .modal-content").boundingBox();
check("the modal is centred", Math.abs(dialogBox.x + dialogBox.width / 2 - 683) < 4 && Math.abs(dialogBox.y + dialogBox.height / 2 - 400) < 60, JSON.stringify(dialogBox));
const inputBox = await page.locator("#user").boundingBox();
const suffixBox = await page.locator(".input-group-text", { hasText: "@booth.pp.ua" }).boundingBox();
check("the domain sits beside the input and does not cover it", suffixBox.x >= inputBox.x + inputBox.width - 1 && inputBox.width > 150, JSON.stringify({ inputBox, suffixBox }));
check("the modal explains that names are shared and shows the +tag form", /Names are shared/.test(await page.locator("#addNote").innerText()) && /name\+tag/.test(await page.locator("#addNote").innerText()));
check("the close button is hidden while there is no address", !(await visible(page, "#addClose")));
check("the page behind the modal is inert", await page.evaluate(() => document.getElementById("app").inert));

await page.keyboard.press("Escape");
await page.mouse.click(8, 8);
await page.waitForTimeout(300);
check("Esc and a backdrop click keep the modal open without an address", await visible(page, "#addModal"));

let trapped = true;
for (let i = 0; i < 8; i += 1) { await page.keyboard.press("Tab"); trapped &&= await insideModal(page); }
for (let i = 0; i < 4; i += 1) { await page.keyboard.press("Shift+Tab"); trapped &&= await insideModal(page); }
check("Tab and Shift+Tab never leave the modal", trapped);

const submit = async (value) => {
  await page.fill("#user", value);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
};
for (const [value, pattern] of [["ab", /username must be/], ["test+", /username must be/], ["test+a+b", /username must be/], ["qa+1", /username must be/], ["qa1+x", /username not available/], ["root+1", /username not available/]]) {
  await submit(value);
  check(`"${value}" shows an inline error and keeps the modal open`, (await visible(page, "#addModal")) && (await visible(page, "#authErr")) && pattern.test(await page.locator("#authErr").innerText()), await page.locator("#authErr").innerText());
}

await submit(tagName);
await settle(page);
check("Enter submits and closes the modal", !(await visible(page, "#addModal")));
check("a +tag name opens as the active address", (await page.locator("#sideList [data-addr]").textContent()) === `${tagName}@booth.pp.ua`);
check("the +tag inbox shows its own mail", await hasMail(page, subjectTag));
check("the +tag inbox hides the base name's mail and another tag's mail", !(await hasMail(page, subjectBase)) && !(await hasMail(page, subjectOther)));
check("no spotlight and no inert page once an address is open", !(await visible(page, "#spot")) && !(await page.evaluate(() => document.getElementById("app").inert)));

await page.reload();
await settle(page);
check("reload keeps the +tag address (cookie round trip)", (await page.locator("#sideList [data-addr]").textContent()) === `${tagName}@booth.pp.ua` && (await hasMail(page, subjectTag)));
check("reload shows no spotlight", !(await visible(page, "#spot")));

const addButton = page.locator("#sideList [data-act=add]");
await addButton.click();
check("Add address opens the modal over an existing inbox", await visible(page, "#addModal"));
check("the close button shows once there is an address", await visible(page, "#addClose"));
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("Esc closes the modal when an address exists", !(await visible(page, "#addModal")));
check("focus returns to the Add address button", await page.evaluate(() => document.activeElement?.dataset?.act === "add"));
await addButton.click();
await page.mouse.click(8, 8);
await page.waitForTimeout(300);
check("a backdrop click closes the modal when an address exists", !(await visible(page, "#addModal")));
await addButton.click();
await page.locator("#addClose").click();
check("the close button closes the modal", !(await visible(page, "#addModal")));

await addButton.click();
await submit(baseName);
await settle(page);
check("the base name opens and shows its own and every +tag mail", (await hasMail(page, subjectBase)) && (await hasMail(page, subjectTag)) && (await hasMail(page, subjectOther)));
const rows = await page.locator("#sideList [data-account]").evaluateAll((els) => els.map((el) => el.dataset.account));
check("both addresses are listed", rows.length === 2 && rows.includes(baseName) && rows.includes(tagName), rows.join());
await page.locator(`#sideList [data-account="${tagName}"] [data-act=switch]`).click();
await settle(page);
check("switching to the +tag address hides the other mail again", (await hasMail(page, subjectTag)) && !(await hasMail(page, subjectBase)));

await context.clearCookies();
await page.waitForSelector("#spot:not(.d-none)", { timeout: 12000 }).catch(() => {});
check("a lost session (401) brings the spotlight back", await visible(page, "#spot"));
check("the inbox is emptied after the 401", (await page.locator("#message-page .message").count()) === 0 && (await visible(page, "#sideList")));

page.on("dialog", (dialog) => dialog.accept());
await page.locator("#sideList [data-act=add]").click();
await submit(baseName);
await settle(page);
await page.locator(`#sideList [data-account="${baseName}"] [data-act=forget]`).click();
await settle(page, 800);
check("forgetting the last address brings the spotlight back", (await visible(page, "#spot")) && !(await visible(page, "#addModal")));
check("the list area says there is no address", /No address yet/.test(await page.locator("#message-page").innerText()));
check("reads are refused once every address is forgotten", (await page.evaluate(() => fetch("/api/messages").then((r) => r.status))) === 401);
await context.close();

const tampered = await browser.newContext({ viewport: { width: 1366, height: 800 } });
await tampered.addCookies([{ name: "inboxes", value: `${"A".repeat(20)}.1.${"0".repeat(64)}`, url: base }]);
const tamperedPage = await tampered.newPage();
await tamperedPage.goto(base);
await tamperedPage.locator("#spot").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
check("a tampered cookie lands on the spotlight", await visible(tamperedPage, "#spot"));
await tampered.close();

const phone = await browser.newContext({ viewport: { width: 375, height: 700 } });
const phonePage = await phone.newPage();
await phonePage.goto(base);
await phonePage.locator("#spot").waitFor({ state: "visible" });
await settle(phonePage, 900);
check("narrow: the sidebar opens so the spotlighted button is visible", await phonePage.evaluate(() => document.getElementById("offcanvas").classList.contains("show")));
const phoneAdd = phonePage.locator("#offBody [data-act=add]");
const phoneBox = await phoneAdd.boundingBox();
check("narrow: the button is inside the viewport", phoneBox && phoneBox.x >= 0 && phoneBox.x + phoneBox.width <= 375 && phoneBox.y >= 0 && phoneBox.y + phoneBox.height <= 700, JSON.stringify(phoneBox));
check("narrow: the spotlight hole leaves the button clickable", (await topAt(phonePage, "#offBody [data-act=add]")) === "add");
const phoneHint = await phonePage.locator("#spotHint").boundingBox();
check("narrow: the hint stays inside the viewport", phoneHint.x >= 0 && phoneHint.x + phoneHint.width <= 375 && phoneHint.y >= 0, JSON.stringify(phoneHint));
await phoneAdd.click();
await phonePage.locator("#addModal").waitFor({ state: "visible" });
const phoneModal = await phonePage.locator("#addModal .modal-content").boundingBox();
check("narrow: the modal fits the screen", phoneModal.x >= 0 && phoneModal.x + phoneModal.width <= 375, JSON.stringify(phoneModal));
check("narrow: the sidebar closes behind the modal", !(await phonePage.evaluate(() => document.getElementById("offcanvas").classList.contains("show"))));
const phoneInput = await phonePage.locator("#user").boundingBox();
const phoneSuffix = await phonePage.locator(".input-group-text", { hasText: "@booth.pp.ua" }).boundingBox();
check("narrow: the domain stays beside the input", phoneSuffix.x >= phoneInput.x + phoneInput.width - 1 && phoneSuffix.x + phoneSuffix.width <= 375 && phoneInput.width > 100, JSON.stringify({ phoneInput, phoneSuffix }));
await phone.close();

await browser.close();
process.exit(failures === 0 ? 0 : 1);
