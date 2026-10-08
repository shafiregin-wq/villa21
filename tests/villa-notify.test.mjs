// The "villa-notify" Edge Function, run in Node against a fake Supabase database and fake phones
// that decrypt what they receive with the independent http_ece library (the one web-push uses).
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomBytes, webcrypto } from "node:crypto";
import ece from "http_ece";
import { handle, encryptPayload, vapidHeader, generateVapidKeys, b64uEncode, b64uDecode, villaId, messages, aed } from "../supabase/functions/villa-notify/index.ts";

const CODE = "ABCD-EFGH-JKLM-NPQR-STUV", OTHER = "ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ";
const env = { url: "https://project.supabase.test", key: "service-key" };
let tables, inbox, realFetch, gone, refused;

// A tiny stand-in for Supabase's REST API: just enough of PostgREST for this function.
function fakeRest(url, init) {
  const u = new URL(url), table = u.pathname.split("/").pop(), rows = tables[table];
  if (!rows) return new Response(JSON.stringify({ code: "PGRST205", message: "table not found" }), { status: 404 });
  const filters = [...u.searchParams].filter(([k]) => !["select", "order", "offset", "on_conflict"].includes(k));
  const match = r => filters.every(([k, v]) => {
    const [op, ...rest] = v.split("."), val = rest.join(".");
    return op === "eq" ? String(r[k]) === val : op === "in" ? val.slice(1, -1).split(",").includes(String(r[k])) : false;
  });
  const method = init.method || "GET";
  if (method === "GET") {
    let out = rows.filter(match);
    if (u.searchParams.get("order") === "created_at.desc") out = out.slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
    out = out.slice(+(u.searchParams.get("offset") || 0));
    return new Response(JSON.stringify(out), { status: 200 });
  }
  if (method === "POST") {
    const row = JSON.parse(init.body), key = u.searchParams.get("on_conflict"), i = rows.findIndex(r => r[key] === row[key]);
    if (i >= 0) { if (/merge-duplicates/.test(init.headers.Prefer)) rows[i] = { ...rows[i], ...row }; }
    else rows.push(row);
    return new Response("", { status: 201 });
  }
  if (method === "DELETE") { tables[table] = rows.filter(r => !match(r)); return new Response(null, { status: 204 }); }
}

function phone(name) {
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  const auth = randomBytes(16);
  return { endpoint: `https://push.example/${name}`, p256dh: b64uEncode(ecdh.getPublicKey()), auth: b64uEncode(auth), ecdh, secret: auth, name };
}
const phones = {};

beforeEach(() => {
  tables = { villa_push: [], push_config: [] }; inbox = []; gone = new Set(); refused = {};
  for (const n of ["regin", "regin2", "tm", "rafi", "elsewhere"]) phones[n] = phone(n);
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith(env.url)) return fakeRest(url, init);
    const p = Object.values(phones).find(x => x.endpoint === url);
    assert.ok(p, "only known phones get messages");
    if (gone.has(p.name)) return new Response("", { status: 410 });
    if (refused[p.name]) return new Response(refused[p.name].body, { status: refused[p.name].status });
    assert.match(init.headers.Authorization, /^vapid t=.+, k=.+$/);
    const plain = ece.decrypt(Buffer.from(init.body), { version: "aes128gcm", privateKey: p.ecdh, authSecret: p.secret });
    inbox.push({ to: p.name, ...JSON.parse(plain.toString("utf8")) });
    return new Response("", { status: 201 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const call = body => handle(new Request("https://fn.test/villa-notify", { method: "POST", headers: { "content-type": "application/json", origin: "https://shafiregin-wq.github.io" }, body: JSON.stringify(body) }), env);
const subscribe = (name, person, code = CODE) => call({ action: "subscribe", code, person, subscription: { ...phones[name], userAgent: "test" } });

test("a phone can decrypt what the function sends (RFC 8291, aes128gcm)", async () => {
  const p = phones.regin, message = JSON.stringify({ title: "TM added an expense", body: "🍔 Chicken · AED 120" });
  const body = await encryptPayload(message, p.p256dh, p.auth);
  assert.equal(new DataView(body.buffer, body.byteOffset).getUint32(16), 4096, "record size");
  assert.equal(ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: p.ecdh, authSecret: p.secret }).toString("utf8"), message);
});

test("VAPID header is a valid ES256 token for the push service", async () => {
  const keys = await generateVapidKeys();
  const h = await vapidHeader("https://web.push.apple.com/QAbc?x=1", { ...keys, subject: "https://shafiregin-wq.github.io" }, Date.UTC(2026, 9, 8));
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
  assert.equal(m[4], keys.publicKey);
  assert.deepEqual(JSON.parse(Buffer.from(m[2], "base64url")), { aud: "https://web.push.apple.com", exp: Date.UTC(2026, 9, 8) / 1000 + 43200, sub: "https://shafiregin-wq.github.io" });
  const pub = await webcrypto.subtle.importKey("raw", b64uDecode(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.ok(await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64uDecode(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`)));
});

test("phones subscribe; the code is stored only as a fingerprint", async () => {
  const k1 = await (await call({ action: "key" })).json(), k2 = await (await call({ action: "key" })).json();
  assert.equal(b64uDecode(k1.publicKey).length, 65);
  assert.equal(k1.publicKey, k2.publicKey, "keys are made once and kept");
  assert.equal((await subscribe("regin", "regin")).status, 200);
  assert.equal((await subscribe("regin", "regin")).status, 200, "subscribing again is fine");
  assert.equal(tables.villa_push.length, 1);
  const row = tables.villa_push[0];
  assert.equal(row.villa, await villaId("ABCDEFGHJKLMNPQRSTUV"), "dashes and case don't matter");
  assert.match(row.villa, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(tables).includes("ABCDEFGH"), "the code itself is never stored");
  assert.equal((await call({ action: "subscribe", code: "short", person: "regin", subscription: phones.tm })).status, 400);
  assert.equal((await call({ action: "subscribe", code: CODE, person: "boss", subscription: phones.tm })).status, 400);
  assert.equal((await call({ action: "subscribe", code: CODE, person: "tm", subscription: { ...phones.tm, endpoint: "http://insecure/x" } })).status, 400);
});

test("a new expense notifies the other two, each with their share", async () => {
  for (const [n, p] of [["regin", "regin"], ["regin2", "regin"], ["tm", "tm"], ["rafi", "rafi"]]) await subscribe(n, p);
  await subscribe("elsewhere", "tm", OTHER);
  const r = await (await call({ action: "notify", code: CODE, person: "regin", kind: "expense", id: "abc123", amountF: 12000, description: "Chicken & rice", emoji: "🍔", shares: { regin: 6000, tm: 6000 } })).json();
  assert.equal(r.sent, 2);
  const byPhone = Object.fromEntries(inbox.map(m => [m.to, m]));
  assert.deepEqual(Object.keys(byPhone).sort(), ["rafi", "tm"], "not the sender's phones, not another villa");
  assert.deepEqual(byPhone.tm, { to: "tm", title: "Regin added an expense", body: "🍔 Chicken & rice · AED 120 · your share AED 60", tag: "v21-abc123" });
  assert.equal(byPhone.rafi.body, "🍔 Chicken & rice · AED 120 · not split with you");
});

test("a payment tells the other person in it, and the third", async () => {
  for (const n of ["regin", "tm", "rafi"]) await subscribe(n, n);
  await call({ action: "notify", code: CODE, person: "tm", kind: "payment", id: "p1", from: "tm", to: "regin", amountF: 5050 });
  const byPhone = Object.fromEntries(inbox.map(m => [m.to, m.body]));
  assert.deepEqual(byPhone, { regin: "TM paid you AED 50.50", rafi: "TM paid Regin AED 50.50" });
  inbox = [];
  await call({ action: "notify", code: CODE, person: "regin", kind: "payment", from: "rafi", to: "regin", amountF: 2000 });
  assert.deepEqual(Object.fromEntries(inbox.map(m => [m.to, m.body])), { rafi: "Regin marked your AED 20 payment as received", tm: "Rafi paid Regin AED 20" });
  inbox = [];
  const r = await (await call({ action: "notify", code: CODE, person: "rafi", kind: "payment", from: "tm", to: "regin", amountF: 2000 })).json();
  assert.equal(r.sent, 0, "someone outside the payment can't announce it");
});

test("test notifications go only to the sender's own phones; expired phones are forgotten", async () => {
  for (const [n, p] of [["regin", "regin"], ["regin2", "regin"], ["tm", "tm"]]) await subscribe(n, p);
  gone.add("regin2");
  const r = await (await call({ action: "test", code: CODE, person: "regin" })).json();
  assert.deepEqual(r, { sent: 1, phones: 2, failures: ["Regin: 410"], reached: ["Regin"], missing: [] }, "says what happened to each phone");
  assert.deepEqual(inbox.map(m => m.to), ["regin"]);
  assert.ok(!tables.villa_push.some(x => x.endpoint === phones.regin2.endpoint), "the expired phone was removed");
  await call({ action: "unsubscribe", code: CODE, person: "regin", endpoint: phones.regin.endpoint });
  assert.deepEqual(await (await call({ action: "test", code: CODE, person: "regin" })).json(), { sent: 0, phones: 0, failures: [], reached: [], missing: ["Regin"] });
});

test("when Apple refuses a notification, the reason comes back (and the phone is kept)", async () => {
  await subscribe("tm", "tm");
  refused.tm = { status: 403, body: '{"reason":"BadJwtToken"}' };
  const r = await (await call({ action: "test", code: CODE, person: "tm" })).json();
  assert.deepEqual(r, { sent: 0, phones: 1, failures: ['TM: 403 {"reason":"BadJwtToken"}'], reached: [], missing: [] });
  assert.equal(tables.villa_push.length, 1);
});

test("keys with \"=\" padding at the end are accepted", async () => {
  const p = phones.rafi;
  const res = await call({ action: "subscribe", code: CODE, person: "rafi", subscription: { endpoint: p.endpoint, p256dh: p.p256dh + "=", auth: p.auth + "==" } });
  assert.equal(res.status, 200);
  assert.equal(tables.villa_push[0].p256dh, p.p256dh, "stored without the padding");
  assert.equal((await (await call({ action: "test", code: CODE, person: "rafi" })).json()).sent, 1);
});

test("a new expense says who was reached and who hasn't turned notifications on", async () => {
  await subscribe("rafi", "rafi");
  const r = await (await call({ action: "notify", code: CODE, person: "regin", kind: "expense", amountF: 100, shares: { tm: 50, rafi: 50 } })).json();
  assert.deepEqual([r.sent, r.reached, r.missing], [1, ["Rafi"], ["TM"]]);
});

test("status: who has notifications on, and whether this phone is signed up", async () => {
  await subscribe("regin", "regin"); await subscribe("regin2", "regin"); await subscribe("rafi", "rafi");
  await subscribe("elsewhere", "tm", OTHER);
  const s = await (await call({ action: "status", code: CODE, person: "rafi", endpoint: phones.rafi.endpoint })).json();
  assert.deepEqual(s, { people: { regin: 2, tm: 0, rafi: 1 }, thisPhone: true }, "only this villa's phones count");
  assert.equal((await (await call({ action: "status", code: CODE, person: "tm", endpoint: phones.tm.endpoint })).json()).thisPhone, false);
  assert.equal((await (await call({ action: "status", code: CODE, person: "tm", endpoint: phones.rafi.endpoint })).json()).thisPhone, false, "signed up as someone else doesn't count");
  assert.equal((await (await call({ action: "status", code: CODE, person: "tm" })).json()).thisPhone, false);
});

test("a clear answer when the Supabase table hasn't been created", async () => {
  delete tables.villa_push;
  const res = await subscribe("regin", "regin");
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "not_set_up");
});

test("messages are built from the details, never as free text", () => {
  assert.deepEqual(messages("tm", { kind: "expense", amountF: 0 }), {}, "no amount, no message");
  const m = messages("tm", { kind: "expense", amountF: 999, description: "x".repeat(500) + "\u0007", shares: { regin: "abc" } });
  assert.ok(m.regin.body.length < 100);
  assert.ok(!/\u0007/.test(m.regin.body));
  assert.equal(aed(150025), "AED 1,500.25");
  assert.equal(aed(100), "AED 1");
});
