// Villa 21 in a real browser, three phones at once, against the Firebase emulators running the
// real firestore.rules. The notification function is replaced by a recorder.
// Run: npm run test:rules   (starts the Firestore and Auth emulators, then runs this)
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

let chromium;
try { ({ chromium } = await import("playwright")); }
catch (e) { ({ chromium } = await import("/opt/node22/lib/node_modules/playwright/index.mjs")); }

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const PUSH_URL = "https://push.test/functions/v1/villa-notify";
const CONFIG = `export const firebaseConfig = { apiKey: "demo-key", authDomain: "demo-villa21.firebaseapp.com", projectId: "demo-villa21", appId: "1:1:web:1",
  emulator: { auth: "http://127.0.0.1:9099", host: "127.0.0.1", port: 8085 } };
export const pushConfig = { url: "${PUSH_URL}", key: "sb_publishable_test" };`;

let server, base, browser;
const calls = [];

before(async () => {
  await fetch("http://127.0.0.1:8085/emulator/v1/projects/demo-villa21/databases/(default)/documents", { method: "DELETE" });
  await fetch("http://127.0.0.1:9099/emulator/v1/projects/demo-villa21/accounts", { method: "DELETE" });
  server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^\/+/, "") || "index.html";
    try { const body = await readFile(join(ROOT, path)); res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream" }); res.end(body); }
    catch (e) { res.writeHead(404); res.end("not found"); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://localhost:${server.address().port}/`;
  // The full Chromium build: the lighter headless shell refuses notification permission.
  browser = await chromium.launch({ channel: "chromium" });
});
after(async () => { await browser?.close(); server?.close(); });

// sw: let the service worker run. Off for the phones that reload, because requests made by the
// service worker skip the test's redirects of config.js and the Firebase library.
async function phone(name, { storage, sw = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: sw ? "allow" : "block" });
  await ctx.grantPermissions(["notifications"], { origin: base.replace(/\/$/, "") });
  // The Firebase library comes from the npm package instead of gstatic.com (blocked in the test sandbox).
  await ctx.route("https://www.gstatic.com/firebasejs/10.12.2/*", async route => {
    const file = new URL(route.request().url()).pathname.split("/").pop();
    route.fulfill({ status: 200, contentType: "text/javascript", body: await readFile(join(ROOT, "node_modules/firebase", file)) });
  });
  await ctx.route("**/config.js", route => route.fulfill({ status: 200, contentType: "text/javascript", body: CONFIG }));
  await ctx.route(PUSH_URL, route => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "apikey, content-type" } });
    const body = JSON.parse(req.postData() || "{}");
    calls.push({ phone: name, apikey: req.headers().apikey, ...body });
    const reply = body.action === "key" ? { publicKey: "BOrP2QvjQbqXqUtDAj-aoYiNb2a4_Jk0dDl4iY_rBAgV8L0VoSz4JnArDF0wMNHcIJgq5I1MyMaP_RTEBaq0TQM" } : body.action === "test" ? { sent: 1 } : body.action === "notify" ? { sent: 2 } : { ok: true };
    route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(reply) });
  });
  // Stand-in for the phone's push service, which isn't reachable from the test browser.
  await ctx.addInitScript(() => {
    if (!self.PushManager) return;
    let sub = null;
    const fake = { endpoint: "https://web.push.apple.com/fake-" + Math.random().toString(36).slice(2), toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } }; }, unsubscribe: async () => { sub = null; return true; } };
    PushManager.prototype.getSubscription = async function () { return sub; };
    PushManager.prototype.subscribe = async function (opts) { if (!opts || !opts.applicationServerKey) throw new Error("no key"); sub = fake; return sub; };
  });
  if (storage) await ctx.addInitScript(s => { if (!sessionStorage.getItem("seeded")) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); sessionStorage.setItem("seeded", "1"); } }, storage);
  const page = await ctx.newPage();
  page.on("pageerror", e => console.error(`[${name}] page error:`, e.message));
  await page.goto(base);
  return page;
}
const ok = page => page.locator(".sheet.open [data-x=ok]").click();
async function choose(page, id) {
  await page.locator(`[data-act=pick-user][data-id=${id}]`).click();
  await page.locator(".sheet.open").getByText("can't be switched later").waitFor();
  await ok(page);
  await page.locator("#fab").waitFor();
}
async function joinWith(page, code) {
  await page.locator("#codeInp").fill(code);
  await page.getByRole("button", { name: "Join Villa 21" }).click();
}
const sheetGone = page => page.waitForFunction(() => !document.querySelector(".sheet"));
const owes = page => page.locator(".owe-row").evaluateAll(rows => rows.map(r => ({ who: r.querySelector(".owe-names").textContent, paid: !!r.querySelector(".paid-btn") })));

let regin, tm, rafi, code;

test("Regin creates the villa and locks the phone; TM and Rafi join", async () => {
  regin = await phone("regin");
  await createVilla(regin);
  await regin.getByText("Who are you?").waitFor();
  await choose(regin, "regin");
  code = await regin.evaluate(() => localStorage.getItem("v21.code"));
  assert.match(code, /^[A-Z0-9]{20}$/);
  assert.equal(await regin.evaluate(() => localStorage.getItem("v21.lock")), `${code}:regin`);

  tm = await phone("tm");
  await joinWith(tm, code);
  await tm.getByText("Who are you?").waitFor();
  await choose(tm, "tm");
  rafi = await phone("rafi");
  await joinWith(rafi, code);
  await choose(rafi, "rafi");
});
async function createVilla(page) {
  await page.locator("[data-act=create]").click();
  await ok(page);
}

test("Regin adds an expense: the others are notified and can't change it", async () => {
  await regin.locator("#fab").click();
  await regin.locator("#f-amount").fill("120");
  await regin.locator("#f-desc").fill("Chicken & rice");
  assert.equal((await regin.locator("#f-paid").textContent()).trim(), "You (Regin Shafi)", "no choosing who paid");
  await regin.locator(".sheet.open [data-x=save]").click();
  await sheetGone(regin);

  await assert.doesNotReject(waitFor(() => calls.find(c => c.action === "notify" && c.kind === "expense")));
  const note = calls.find(c => c.action === "notify" && c.kind === "expense");
  assert.equal(note.phone, "regin");
  assert.equal(note.person, "regin");
  assert.equal(note.code, code);
  assert.equal(note.apikey, "sb_publishable_test");
  assert.deepEqual([note.amountF, note.description, note.shares], [12000, "Chicken & rice", { regin: 4000, tm: 4000, rafi: 4000 }]);
  await regin.getByText("🔔 Notified 2 phones").waitFor();

  await tm.getByText("Chicken & rice").first().click();
  await tm.locator(".sheet.open").getByText("Only Regin can change or delete this expense.").waitFor();
  assert.equal(await tm.locator(".sheet.open [data-x=edit], .sheet.open [data-x=delete]").count(), 0, "no Edit or Delete for TM");
  await tm.locator(".sheet.open [data-sx=left]").click();

  // Even going around the app, the database refuses.
  const attempt = await tm.evaluate(async () => {
    const { getApp } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
    const fs = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const db = fs.getFirestore(getApp());
    const code = localStorage.getItem("v21.code");
    const snap = await fs.getDocs(fs.collection(db, "villas", "v21-" + code, "expenses"));
    const id = snap.docs[0].id;
    const tries = {
      edit: fs.updateDoc(fs.doc(db, "villas", "v21-" + code, "expenses", id), { amountF: 1 }),
      del: fs.deleteDoc(fs.doc(db, "villas", "v21-" + code, "expenses", id)),
      addAsRegin: fs.setDoc(fs.doc(db, "villas", "v21-" + code, "expenses", "fake"), { ...snap.docs[0].data(), createdBy: "regin" }),
      switchPerson: fs.setDoc(fs.doc(db, "villas", "v21-" + code, "devices", (await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js")).getAuth().currentUser.uid), { person: "regin" })
    };
    const out = {};
    for (const [k, p] of Object.entries(tries)) out[k] = await p.then(() => "allowed", e => e.code);
    return out;
  });
  assert.deepEqual(attempt, { edit: "permission-denied", del: "permission-denied", addAsRegin: "permission-denied", switchPerson: "permission-denied" });

  await regin.getByText("Chicken & rice").first().click();
  assert.equal(await regin.locator(".sheet.open [data-x=edit]").count(), 1, "Regin can edit his own");
  await regin.locator(".sheet.open [data-x=edit]").click();
  await regin.locator(".sheet.open #f-amount").fill("150");
  await regin.locator(".sheet.open [data-x=save]").click();
  await sheetGone(regin);
  await tm.getByText("AED 150").first().waitFor();
  assert.equal(calls.filter(c => c.kind === "expense").length, 1, "edits don't notify");
});

test("only the two people in a debt can mark it paid", async () => {
  await rafi.getByText("Who owes who?").waitFor();
  await waitFor(async () => (await owes(rafi)).length === 2);
  assert.deepEqual(await owes(regin), [{ who: "TM→Regin Shafi", paid: true }, { who: "Rafi→Regin Shafi", paid: true }]);
  assert.deepEqual(await owes(rafi), [{ who: "TM→Regin Shafi", paid: false }, { who: "Rafi→Regin Shafi", paid: true }]);
  await rafi.locator(".paid-btn").click();
  await rafi.locator(".sheet.open").getByText("You paid Regin Shafi").waitFor();
  await ok(rafi);
  await waitFor(() => calls.find(c => c.kind === "payment"));
  const p = calls.find(c => c.kind === "payment");
  assert.deepEqual([p.person, p.from, p.to, p.amountF], ["rafi", "rafi", "regin", 5000]);
  await waitFor(async () => (await owes(regin)).length === 1);
  await tm.getByText("Rafi paid Regin").first().click();
  await tm.locator(".sheet.open").getByText("Only Rafi can change or delete this payment.").waitFor();
  await tm.locator(".sheet.open [data-sx=left]").click();
});

test("the phone stays locked: no switching in Settings, and it remembers after a reset", async () => {
  await tm.locator(".tab[data-to=settings]").click();
  await tm.getByText("Each phone belongs to one person").waitFor();
  assert.equal(await tm.locator("[data-act=set-user]").count(), 0);
  assert.equal(await tm.locator(".kv").first().textContent(), "TM");

  await tm.evaluate(() => localStorage.clear());
  await tm.reload();
  await joinWith(tm, code);
  await tm.locator("#fab").waitFor();
  assert.equal(await tm.locator("text=Who are you?").count(), 0, "Firebase remembers the phone is TM");
  assert.equal(await tm.evaluate(() => localStorage.getItem("v21.lock")), `${code}:tm`);
});

test("a phone used before this update chooses once, with its last person suggested", async () => {
  const old = await phone("old", { storage: { "v21.code": code, "v21.user": "rafi" } });
  await old.getByText("Who are you?").waitFor();
  assert.equal(await old.locator("[data-id=rafi] .who-hint").textContent(), "Last used on this phone");
  await old.close();
});

test("before the new rules are published, phones still get in, and are saved once they are", async () => {
  const rules = content => fetch("http://127.0.0.1:8085/emulator/v1/projects/demo-villa21:securityRules", { method: "PUT", body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content }] } }) });
  const devices = async () => ((await (await fetch(`http://127.0.0.1:8085/v1/projects/demo-villa21/databases/(default)/documents/villas/v21-${code}/devices`, { headers: { Authorization: "Bearer owner" } })).json()).documents || []).map(d => d.fields.person.stringValue);
  const before = await devices();
  await rules(`rules_version = '2';
service cloud.firestore { match /databases/{database}/documents {
  match /villas/{villa}/meta/{d} { allow read, write: if request.auth != null; }
  match /villas/{villa}/expenses/{e} { allow read, write: if request.auth != null; }
} }`);
  try {
    const legacy = await phone("legacy");
    await joinWith(legacy, code);
    await choose(legacy, "rafi");
    assert.deepEqual(await devices(), before, "the old rules don't allow saving it yet");
    await rules(await readFile(join(ROOT, "firestore.rules"), "utf8"));
    await legacy.reload();
    await legacy.locator("#fab").waitFor();
    await waitFor(async () => (await devices()).length === before.length + 1);
    assert.deepEqual((await devices()).sort(), [...before, "rafi"].sort());
    await legacy.close();
  } finally { await rules(await readFile(join(ROOT, "firestore.rules"), "utf8")); }
});

test("a phone that chose under the old rules can still save after the new rules go live, without reopening", async () => {
  const rules = content => fetch("http://127.0.0.1:8085/emulator/v1/projects/demo-villa21:securityRules", { method: "PUT", body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content }] } }) });
  await rules(`rules_version = '2';
service cloud.firestore { match /databases/{database}/documents {
  match /villas/{villa}/meta/{d} { allow read, write: if request.auth != null; }
  match /villas/{villa}/expenses/{e} { allow read, write: if request.auth != null; }
} }`);
  try {
    const legacy = await phone("legacy2");
    await joinWith(legacy, code);
    await choose(legacy, "tm");
    await rules(await readFile(join(ROOT, "firestore.rules"), "utf8"));
    const before = calls.filter(c => c.kind === "expense").length;
    await legacy.locator("#fab").click();
    await legacy.locator("#f-amount").fill("30");
    await legacy.locator("#f-desc").fill("Water cans");
    await legacy.locator(".sheet.open [data-x=save]").click();
    await sheetGone(legacy);
    await regin.getByText("Water cans").first().waitFor({ timeout: 15000 });
    await waitFor(() => calls.filter(c => c.kind === "expense").length === before + 1);
    assert.equal(await legacy.locator(".toast.bad").count(), 0, "no error shown");
    await legacy.close();
  } finally { await rules(await readFile(join(ROOT, "firestore.rules"), "utf8")); }
});

test("who owes who is person to person; paying one person clears only that line", async () => {
  const r = await regin.evaluate(() => {
    const { pairwise, myMonth, balances } = window.Villa21Logic;
    const e = (paidBy, split, extra = {}) => ({ type: "expense", paidBy, split, amountF: Object.values(split).reduce((a, b) => a + b, 0), category: "food", date: "2026-10-08", ...extra });
    const list = [e("tm", { tm: 2550, rafi: 2550 }), e("regin", { regin: 3334, tm: 3333, rafi: 3333 })];   // the 51 and the 100 from the owner's screenshot
    const paid = [...list, { type: "payment", paidBy: "tm", split: { regin: 3333 }, amountF: 3333, date: "2026-10-09" }];
    return { before: pairwise(list), after: pairwise(paid), net: balances(list), regin: myMonth(paid, "regin", "2026-10"), tm: myMonth(paid, "tm", "2026-10"), next: myMonth(paid, "regin", "2026-11") };
  });
  assert.deepEqual(r.before, [{ from: "tm", to: "regin", amountF: 3333 }, { from: "rafi", to: "regin", amountF: 3333 }, { from: "rafi", to: "tm", amountF: 2550 }]);
  assert.deepEqual(r.after, [{ from: "rafi", to: "regin", amountF: 3333 }, { from: "rafi", to: "tm", amountF: 2550 }], "TM paid Regin: only that line goes");
  assert.deepEqual(r.net, { regin: 6666, tm: -783, rafi: -5883 }, "the overall balances are unchanged");
  assert.deepEqual(r.regin, { total: 3334, byCat: [["food", 3334]] }, "your share only, payments don't count");
  assert.deepEqual(r.tm, { total: 5883, byCat: [["food", 5883]] });
  assert.deepEqual(r.next, { total: 0, byCat: [] }, "a new month starts at zero");
});

test("Home shows your own spending by category and what each person owes you", async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  await ctx.route("**/config.js", route => route.fulfill({ status: 200, contentType: "text/javascript", body: `export const firebaseConfig = { apiKey: "PASTE" };` }));
  const page = await ctx.newPage();
  await page.goto(base);
  await page.locator("[data-act=demo]").click();
  await choose(page, "rafi");
  const card = page.locator(".month-card");
  assert.match(await card.textContent(), /Your expenses/);
  assert.equal(await card.locator(".total").textContent(), "AED 1,276.66", "Rafi's shares: rent 1,000 + DEWA 116.66 + chicken 40 + Carrefour 70 + cleaner 50");
  assert.deepEqual(await card.locator(".cat-line > span").allTextContents(), ["🏠 Rent AED 1,000", "💡 Electricity AED 116.66", "🛒 Groceries AED 70", "🧹 Cleaning AED 50", "🍔 Food AED 40"]);
  assert.match(await page.locator(".bal .amt").textContent(), /You owe AED 926.66/);
  assert.deepEqual(await page.locator(".bal-lines > span").allTextContents(), ["You owe TM AED 933.33", "Regin owes you AED 6.67"]);
  assert.deepEqual(await owes(page), [{ who: "Rafi→TM", paid: true }, { who: "Regin Shafi→TM", paid: false }, { who: "Regin Shafi→Rafi", paid: true }]);
  await ctx.close();
});

let regin2;
test("notifications: turn on, test, turn off (on Regin's second phone)", async () => {
  regin2 = await phone("regin2", { sw: true });
  await joinWith(regin2, code);
  await choose(regin2, "regin");
  assert.equal(await regin.locator(".banner").count(), 0, "no banner where notifications can't work");
  await regin2.getByText("Get notified when TM or Rafi add an expense").waitFor();
  await regin2.locator(".banner [data-act=push-on]").click();
  await regin2.getByText("Notifications are on for this phone.").waitFor();
  const sub = calls.find(c => c.phone === "regin2" && c.action === "subscribe");
  assert.equal(sub.person, "regin");
  assert.equal(sub.code, code);
  assert.match(sub.subscription.endpoint, /^https:\/\/web\.push\.apple\.com\//);
  assert.equal(await regin2.locator(".banner").count(), 0, "the banner goes away");

  await regin2.locator(".tab[data-to=settings]").click();
  await regin2.getByText("Send a test").click();
  await regin2.getByText("Test sent to your phone").waitFor();
  assert.ok(calls.find(c => c.phone === "regin2" && c.action === "test" && c.person === "regin"));
  await regin2.getByText("Turn off on this phone").click();
  await regin2.getByText("Notifications are off for this phone.").waitFor();
  assert.ok(calls.find(c => c.phone === "regin2" && c.action === "unsubscribe"));
  await regin2.getByText("Turn on notifications").waitFor();
});

test("a push becomes a notification", async () => {
  const page = regin2, ctx = page.context(), origin = base.replace(/\/$/, "");
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cdp = await ctx.newCDPSession(page);
  const regs = new Promise(resolve => cdp.on("ServiceWorker.workerRegistrationUpdated", e => { if (e.registrations.length) resolve(e.registrations); }));
  await cdp.send("ServiceWorker.enable");
  const [reg] = await regs;
  await cdp.send("ServiceWorker.deliverPushMessage", { origin, registrationId: reg.registrationId, data: JSON.stringify({ title: "Regin added an expense", body: "🍔 Chicken & rice · AED 120 · your share AED 40", tag: "v21-x" }) });
  const shown = await waitFor(async () => {
    const list = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(n => ({ title: n.title, body: n.body, tag: n.tag })));
    return list.length ? list : null;
  });
  assert.deepEqual(shown, [{ title: "Regin added an expense", body: "🍔 Chicken & rice · AED 120 · your share AED 40", tag: "v21-x" }]);
});

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise(r => setTimeout(r, 100));
  }
}
