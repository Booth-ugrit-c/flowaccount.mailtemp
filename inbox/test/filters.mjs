import { launchBrowser } from "./browser.mjs";

const base = process.env.INBOX_URL ?? "http://127.0.0.1:8090";
const [username, shotDir] = process.argv.slice(2);
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${detail})`}`);
  if (!ok) failures += 1;
};

const NOW = new Date(2026, 9, 16, 15, 30);
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();
const who = (name, address) => ({ Name: name, Address: address });
const addr = (...locals) => locals.map((l) => who("", `${l}@booth.pp.ua`));
const alice = who("Alice Admin", "alice@example.com");
const bob = who("Bob Builder", "bob@example.com");
const carol = who("Carol", "carol@example.org");
const fixture = [
  { id: "fx1", from: alice, to: addr(username), subject: "Invoice May", snippet: "pay this", created: at(16, 15, 20), size: 5000, attachments: 1, read: false },
  { id: "fx2", from: bob, to: addr(`${username}+01`), subject: "Welcome", snippet: "hello there", created: at(16, 9), size: 120000, attachments: 0, read: true },
  { id: "fx3", from: alice, to: addr(`${username}+01`, `${username}+02`), subject: "Receipt 02", snippet: "thanks", created: at(15, 22), size: 900, attachments: 0, read: false },
  { id: "fx5", from: bob, to: addr(`${username}+02`), subject: "Zebra report", snippet: "quarterly", created: at(13, 11), size: 2500000, attachments: 2, read: true },
  { id: "fx4", from: carol, to: addr(username), subject: "Old newsletter", snippet: "news", created: at(6, 8), size: 40000, attachments: 0, read: true },
];
const detail = (m) => ({ ...m, cc: [], text: `body of ${m.subject}`, html: "", attachments: [] });
const SORTED = {
  "received.desc": ["fx1", "fx2", "fx3", "fx5", "fx4"],
  "size.desc": ["fx5", "fx2", "fx4", "fx1", "fx3"],
  "size.asc": ["fx3", "fx1", "fx4", "fx2", "fx5"],
  "from.asc": ["fx1", "fx3", "fx2", "fx5", "fx4"],
  "subject.asc": ["fx1", "fx4", "fx3", "fx2", "fx5"],
};

const browser = await launchBrowser();
const contrast = (fg, bg) => {
  const lum = (css) => {
    const [r, g, b] = css.match(/[\d.]+/g).slice(0, 3).map((v) => { const c = Number(v) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};

async function makeContext(options = {}, truncated = false) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 800 }, ...options });
  await context.clock.setFixedTime(NOW);
  await context.route("**/api/messages", (route) => route.fulfill({ json: { messages: fixture, truncated } }));
  await context.route("**/api/messages/fx*", (route) => route.fulfill({ json: detail(fixture.find((m) => route.request().url().endsWith(m.id))) }));
  return context;
}

async function load(page, hash = "") {
  await page.goto("about:blank");
  await page.goto(`${base}/${hash}`);
  await page.locator("#chips [data-chip=unread]").waitFor({ timeout: 8000 });
  await page.waitForTimeout(200);
}

async function signIn(context) {
  const page = await context.newPage();
  await page.goto(base);
  await page.evaluate((name) => fetch("/api/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: name }) }), username);
  return page;
}

const rows = (page) => page.locator("#message-page a.message").evaluateAll((els) => els.map((el) => el.id));
const hash = (page) => page.evaluate(() => location.hash);
const count = async (page) => (await page.locator("#countText").innerText()).replace(/\s+/g, " ").trim();
const pressed = (page, chip) => page.locator(`[data-chip="${chip}"]`).getAttribute("aria-pressed");
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const settle = (page) => page.waitForTimeout(150);
const search = async (page, text) => { await page.fill("#search", text); await settle(page); };
const clear = async (page) => { if (await page.locator("[data-act=clearFilters]").count()) await page.locator("[data-act=clearFilters]").click(); await settle(page); };

const context = await makeContext();
const page = await signIn(context);
await load(page);

check("default order is Received, newest first", sameList(await rows(page), SORTED["received.desc"]), (await rows(page)).join());
check("the page shows the count as x of y", (await count(page)) === "5 of 5", await count(page));
check("the Received header carries a descending arrow", (await page.locator("[data-sort=received] i.bi-caret-down-fill").count()) === 1);
check("the default view keeps the bare list hash", (await hash(page)) === "#/" || (await hash(page)) === "", await hash(page));
check("all four sortable headers exist", (await page.locator("[data-sort]").evaluateAll((els) => els.map((el) => el.dataset.sort))).join() === "from,subject,size,received");

const headBox = await page.locator(".list-head > div:nth-child(3)").boundingBox();
const rowBox = await page.locator("#message-page a.message >> nth=0").locator("> div:nth-child(3)").boundingBox();
check("the header row aligns with the Size column of the rows", Math.abs(headBox.x - rowBox.x) <= 1 && Math.abs(headBox.width - rowBox.width) <= 1, JSON.stringify({ headBox, rowBox }));
const headReceived = await page.locator(".list-head > div:nth-child(4)").boundingBox();
const rowReceived = await page.locator("#message-page a.message >> nth=0").locator("> div:nth-child(4)").boundingBox();
check("the header row aligns with the Received column of the rows", Math.abs(headReceived.x - rowReceived.x) <= 1 && Math.abs(headReceived.width - rowReceived.width) <= 1, JSON.stringify({ headReceived, rowReceived }));

for (const [key, label, expected] of [["size", "size.desc", SORTED["size.desc"]], ["size", "size.asc", SORTED["size.asc"]], ["from", "from.asc", SORTED["from.asc"]], ["subject", "subject.asc", SORTED["subject.asc"]]]) {
  await page.locator(`[data-sort=${key}]`).click();
  await settle(page);
  check(`header ${key} gives ${label}`, sameList(await rows(page), expected), (await rows(page)).join());
  check(`${label} is in the hash`, (await hash(page)).includes(`sort=${label}`), await hash(page));
}
check("the arrow follows the active column", (await page.locator("[data-sort=subject] i.bi-caret-up-fill").count()) === 1 && (await page.locator("[data-sort=received] i").count()) === 0);
check("the choice is stored in the browser", (await page.evaluate(() => localStorage.getItem("inboxSort"))) === "subject.asc");
await load(page);
check("a fresh visit without a hash restores the stored sort", sameList(await rows(page), SORTED["subject.asc"]), (await rows(page)).join());
await page.locator("[data-sort=received]").click();
await settle(page);
check("one click on Received is back to newest first", sameList(await rows(page), SORTED["received.desc"]) && (await hash(page)) === "#/", `${(await rows(page)).join()} ${await hash(page)}`);

await page.locator("[data-chip=unread]").click();
await settle(page);
check("Unread keeps unread mail", sameList(await rows(page), ["fx1", "fx3"]) && (await pressed(page, "unread")) === "true", (await rows(page)).join());
await page.locator("[data-chip=att]").click();
await settle(page);
check("Unread with Has attachment keeps one message", sameList(await rows(page), ["fx1"]) && (await count(page)) === "1 of 5", (await rows(page)).join());
check("the hash carries both chips", /unread=1/.test(await hash(page)) && /att=1/.test(await hash(page)), await hash(page));
await page.locator("[data-chip=unread]").click();
await settle(page);
check("Has attachment alone", sameList(await rows(page), ["fx1", "fx5"]), (await rows(page)).join());
await clear(page);
check("Clear restores the full list and hides itself", sameList(await rows(page), SORTED["received.desc"]) && (await page.locator("[data-act=clearFilters]").count()) === 0 && (await hash(page)) === "#/", `${(await rows(page)).join()} ${await hash(page)}`);

for (const [chip, expected] of [["range-1h", ["fx1"]], ["range-today", ["fx1", "fx2"]], ["range-7d", ["fx1", "fx2", "fx3", "fx5"]]]) {
  await page.locator(`[data-chip="${chip}"]`).click();
  await settle(page);
  check(`${chip} filters by age`, sameList(await rows(page), expected), (await rows(page)).join());
}
check("the time range is single-select", (await pressed(page, "range-7d")) === "true" && (await pressed(page, "range-today")) === "false" && (await pressed(page, "range-1h")) === "false");
await page.locator('[data-chip="range-7d"]').click();
await settle(page);
check("clicking the active range clears it", sameList(await rows(page), SORTED["received.desc"]) && (await pressed(page, "range-7d")) === "false");

const tagLabels = await page.locator("[data-chip^=tag-]").evaluateAll((els) => els.map((el) => el.textContent));
check("tag chips show +tag and a count", sameList(tagLabels, ["+01 (2)", "+02 (2)"]), tagLabels.join());
await page.locator('[data-chip="tag-01"]').click();
await settle(page);
check("a tag chip keeps mail addressed to that tag", sameList(await rows(page), ["fx2", "fx3"]) && /tag=01/.test(await hash(page)), `${(await rows(page)).join()} ${await hash(page)}`);
await clear(page);

const senderOptions = await page.locator("[data-chip=sender] option").evaluateAll((els) => els.map((el) => el.textContent));
check("the sender dropdown lists each sender once with a count", sameList(senderOptions, ["All senders", "Alice Admin <alice@example.com> (2)", "Bob Builder <bob@example.com> (2)", "Carol <carol@example.org> (1)"]), senderOptions.join(" | "));
await page.locator("[data-chip=sender]").selectOption("bob@example.com");
await settle(page);
check("choosing a sender filters by it", sameList(await rows(page), ["fx2", "fx5"]) && /from=bob%40example\.com/.test(await hash(page)), `${(await rows(page)).join()} ${await hash(page)}`);
await clear(page);
check("Clear resets the sender dropdown", (await page.locator("[data-chip=sender]").inputValue()) === "");

for (const [query, expected] of [
  ["from:bob", ["fx2", "fx5"]],
  ["from:bob has:attachment", ["fx5"]],
  ["is:unread subject:receipt", ["fx3"]],
  ['subject:"old newsletter"', ["fx4"]],
  ['from:"alice admin" is:unread', ["fx1", "fx3"]],
  ["to:+02", ["fx3", "fx5"]],
  ["welcome", ["fx2"]],
  ["welcome hello", ["fx2"]],
  ["x:foo", []],
  ["from:", SORTED["received.desc"]],
]) {
  await search(page, query);
  check(`search "${query}"`, sameList(await rows(page), expected), (await rows(page)).join());
}
check("the count reflects the search", (await count(page)) === "5 of 5", await count(page));
await search(page, "from:alice");
await page.locator("[data-chip=unread]").click();
await page.locator('[data-chip="range-today"]').click();
await settle(page);
check("search, chips and ranges combine", sameList(await rows(page), ["fx1"]) && (await count(page)) === "1 of 5", (await rows(page)).join());
check("the search text is in the hash", /q=from%3Aalice/.test(await hash(page)), await hash(page));

await search(page, "from:nobody");
check("no match keeps the sort header and says so", (await rows(page)).length === 0 && (await page.locator("[data-sort]").count()) === 4 && /No matching messages/.test(await page.locator("#message-page").innerText()));
await search(page, "");
await page.locator("[data-chip=unread]").click();
await page.locator('[data-chip="range-today"]').click();
await page.locator("[data-chip=att]").click();
await page.locator("[data-chip=sender]").selectOption("bob@example.com");
await page.locator('[data-chip="tag-02"]').click();
await page.locator("[data-sort=size]").click();
await search(page, "from:bob");
const shared = await hash(page);
check("the shared hash holds every setting", ["q=from%3Abob", "sort=size.desc", "tag=02", "att=1", "from=bob%40example.com"].every((part) => shared.includes(part)), shared);
const guest = await context.newPage();
await load(guest, shared);
check("opening the hash in a new tab rebuilds the view", sameList(await rows(guest), ["fx5"]) && (await guest.locator("#search").inputValue()) === "from:bob" && (await pressed(guest, "att")) === "true" && (await pressed(guest, "tag-02")) === "true" && (await guest.locator("[data-chip=sender]").inputValue()) === "bob@example.com", `${(await rows(guest)).join()} ${await hash(guest)}`);
await guest.close();

await page.locator("#message-page a.message >> nth=0").click();
await page.locator("#message-view").waitFor();
check("opening a message uses the view hash", (await hash(page)) === "#/view/fx5", await hash(page));
await page.goBack();
await settle(page);
check("browser Back from a message keeps the filters", sameList(await rows(page), ["fx5"]) && (await page.locator("#search").inputValue()) === "from:bob" && (await hash(page)) === shared, `${(await rows(page)).join()} ${await hash(page)}`);
await page.locator("#message-page a.message >> nth=0").click();
await page.locator("#message-view").waitFor();
await page.locator("#returnLink").click();
await settle(page);
check("Return to inbox from a message keeps the filters", sameList(await rows(page), ["fx5"]) && (await hash(page)) === shared, `${(await rows(page)).join()} ${await hash(page)}`);
await clear(page);

const evil = "#/?q=%3Cimg%20src%3Dx%20onerror%3Dwindow.pwned%3D1%3E&tag=%3Cscript%3Ewindow.pwned%3D1%3C%2Fscript%3E&range=bad&sort=zzz&from=%22%3E%3Cb%3E&unread=yes";
await load(page, evil);
await page.waitForTimeout(400);
check("a hostile hash is shown as plain text and runs nothing", (await page.evaluate(() => window.pwned)) === undefined && (await page.locator("#message-page img, #chips img, #chips script, #countText img").count()) === 0 && (await page.locator("#search").inputValue()).startsWith("<img src=x"), await page.locator("#search").inputValue());
check("a hostile hash falls back to safe defaults", (await pressed(page, "unread")) === "false" && (await page.locator("[data-chip^=range-][aria-pressed=true]").count()) === 0 && (await page.locator("[data-sort] i.bi-caret-down-fill").count()) === 1);
await load(page, "#/?%%%&q=%E0%A4%A");
check("a malformed hash does not break the page", (await page.locator("#chips button").count()) > 3);
await clear(page);

check("no truncation note when the list is complete", await page.locator("#listNote").isHidden());
const capped = await makeContext({}, true);
const cappedPage = await signIn(capped);
await load(cappedPage);
check("a capped list shows the truncation note", (await cappedPage.locator("#listNote").isVisible()) && /more mail than is loaded/.test(await cappedPage.locator("#listNote").innerText()), await cappedPage.locator("#listNote").innerText());
await capped.close();

await load(page);
const sortFocus = page.locator("[data-sort=from]");
await sortFocus.focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(5600);
check("keyboard focus stays on the sort header across the 5 s refresh", await page.evaluate(() => document.activeElement?.dataset?.sort === "from"));
await page.locator("[data-chip=sender]").focus();
await page.waitForTimeout(5600);
check("an open sender dropdown keeps focus across the 5 s refresh", await page.evaluate(() => document.activeElement?.dataset?.chip === "sender"));

for (const scheme of ["light", "dark"]) {
  const themed = await makeContext({ colorScheme: scheme });
  const themedPage = await signIn(themed);
  await load(themedPage, "#/?sort=size.desc&unread=1");
  await themedPage.waitForTimeout(600);
  const colors = await themedPage.evaluate(() => {
    const chip = document.querySelector("[data-chip=unread]");
    const sort = document.querySelector("[data-sort=size]");
    const head = document.querySelector(".list-head");
    return { chipFg: getComputedStyle(chip).color, chipBg: getComputedStyle(chip).backgroundColor, sortFg: getComputedStyle(sort).color, headBg: getComputedStyle(head).backgroundColor, theme: document.documentElement.getAttribute("data-bs-theme") };
  });
  check(`${scheme}: the theme is applied`, colors.theme === scheme, colors.theme);
  check(`${scheme}: the active chip is readable`, contrast(colors.chipFg, colors.chipBg) >= 4.5, JSON.stringify(colors));
  await themedPage.locator("[data-chip=unread]").hover();
  await themedPage.waitForTimeout(400);
  const hovered = await themedPage.evaluate(() => { const cs = getComputedStyle(document.querySelector("[data-chip=unread]")); return [cs.color, cs.backgroundColor]; });
  check(`${scheme}: the active chip stays readable under the pointer`, contrast(hovered[0], hovered[1]) >= 4.5, hovered.join(" on "));
  check(`${scheme}: the sort header is readable`, contrast(colors.sortFg, colors.headBg) >= 4.5, JSON.stringify(colors));
  if (shotDir) await themedPage.screenshot({ path: `${shotDir}/filters-${scheme}.png` });
  await themed.close();
}

const phone = await makeContext({ viewport: { width: 375, height: 700 } });
const phonePage = await signIn(phone);
await load(phonePage);
check("narrow: the header row is hidden", await phonePage.locator(".list-head").isHidden());
check("narrow: a Sort by control is shown", (await phonePage.locator("[data-chip=sort]").isVisible()) && /^Sort by /.test(await phonePage.locator("[data-chip=sort] option >> nth=0").innerText()));
await phonePage.locator("[data-chip=sort]").selectOption("size.asc");
await settle(phonePage);
check("narrow: the Sort by control reorders the list", sameList(await rows(phonePage), SORTED["size.asc"]) && /sort=size\.asc/.test(await hash(phonePage)), (await rows(phonePage)).join());
await phonePage.locator("[data-chip=att]").click();
await settle(phonePage);
check("narrow: chips filter too", sameList(await rows(phonePage), ["fx1", "fx5"]), (await rows(phonePage)).join());
check("narrow: nothing scrolls sideways", await phonePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), String(await phonePage.evaluate(() => document.documentElement.scrollWidth)));
if (shotDir) await phonePage.screenshot({ path: `${shotDir}/filters-narrow.png` });
await phone.close();

const wide = await context.newPage();
await load(wide);
check("wide: the Sort by control is hidden", await wide.locator("[data-chip=sort]").isHidden());
await wide.close();

await browser.close();
process.exit(failures === 0 ? 0 : 1);
