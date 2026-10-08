// Villa 21 push notifications: Supabase Edge Function "villa-notify".
//
// Villa 21 keeps its expenses in Firebase. This function only sends the notifications: when one
// person adds an expense or records a payment, the app calls it and it notifies the other two.
// It also hands out the public key phones need to subscribe, and sends test notifications.
//
// It runs in the same Supabase project as MITAK and shares its notification keys (push_config).
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name it "villa-notify" →
// replace the example code with this whole file → Deploy. Then in the function's Details, turn
// off "Enforce JWT verification" (Villa 21 phones don't sign in to Supabase).
//
// Who may use it: a phone proves it belongs to the villa with the Villa 21 code, the same secret
// that opens the expenses in Firebase. Only a fingerprint of the code (SHA-256) is stored here.
// Messages are written here from the expense details, never taken as text from the phone.
//
// No libraries: Web Push encryption (RFC 8291) and VAPID (RFC 8292) use the built-in Web Crypto API.

const enc = new TextEncoder();
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
export const PEOPLE: Record<string, string> = { regin: "Regin", tm: "TM", rafi: "Rafi" };
const MAX_PHONES = 30;   // per villa; the oldest are forgotten first

/* ---------- bytes ---------- */

export function b64uEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64uDecode(str: string): Uint8Array {
  const s = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/* ---------- Web Push ---------- */

export type Vapid = { publicKey: string; privateJwk: JsonWebKey; subject: string };
export type Subscription = { endpoint: string; p256dh: string; auth: string };

export async function generateVapidKeys(): Promise<{ publicKey: string; privateJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicKey = b64uEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey, privateJwk: { kty, crv, x, y, d } };
}

// Encrypts a message for one subscription (aes128gcm, single record).
export async function encryptPayload(payload: string, p256dh: string, auth: string): Promise<Uint8Array> {
  const uaPublic = b64uDecode(p256dh), authSecret = b64uDecode(auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const one = new Uint8Array([1]);
  const ikm = await hmac(await hmac(authSecret, shared), concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, one));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), one))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), one))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(enc.encode(payload), new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, sealed);
}

export async function vapidHeader(endpoint: string, vapid: Vapid, now = Date.now()): Promise<string> {
  const head = b64uEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64uEncode(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject })));
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${b64uEncode(sig)}, k=${vapid.publicKey}`;
}

// Returns the push service's answer: 201 means delivered; otherwise its status and reason
// (Apple answers e.g. 403 {"reason":"BadJwtToken"}).
export async function sendPush(sub: Subscription, message: unknown, vapid: Vapid, allowHttp = false): Promise<{ status: number; reason: string }> {
  if (!/^https:\/\//.test(sub.endpoint) && !allowHttp) return { status: 400, reason: "not https" };
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
      Authorization: await vapidHeader(sub.endpoint, vapid)
    },
    body: await encryptPayload(JSON.stringify(message), sub.p256dh, sub.auth)
  });
  if (res.ok) { await res.body?.cancel(); return { status: res.status, reason: "" }; }
  const reason = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 120);
  return { status: res.status, reason };
}

/* ---------- Supabase access (with the project's service key) ---------- */

export type Env = { url: string; key: string; allowHttp?: boolean };

function db(env: Env) {
  const headers: Record<string, string> = { apikey: env.key, "Content-Type": "application/json" };
  if (env.key.startsWith("eyJ")) headers.Authorization = `Bearer ${env.key}`;
  const call = async (method: string, path: string, body?: unknown, prefer?: string) => {
    const res = await fetch(`${env.url}/rest/v1/${path}`, { method, headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 404 || /PGRST205|42P01/.test(text)) throw new Error("not_set_up");
      throw new Error(`database ${res.status}: ${text}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  return {
    get: (path: string) => call("GET", path),
    post: (path: string, body: unknown, prefer = "return=minimal") => call("POST", path, body, prefer),
    del: (path: string) => call("DELETE", path)
  };
}
type Db = ReturnType<typeof db>;

async function vapidKeys(d: Db, origin: string | null): Promise<Vapid> {
  const read = async () => (await d.get("push_config?id=eq.1&select=public_key,private_jwk,subject"))[0];
  let row = await read();
  if (!row) {
    const k = await generateVapidKeys();
    const subject = origin && /^https:\/\//.test(origin) ? origin : "mailto:villa21@users.noreply.github.com";
    await d.post("push_config?on_conflict=id", { id: 1, public_key: k.publicKey, private_jwk: k.privateJwk, subject }, "resolution=ignore-duplicates,return=minimal");
    row = await read();
  }
  return { publicKey: row.public_key, privateJwk: row.private_jwk, subject: row.subject };
}

/* ---------- messages ---------- */

// The villa's fingerprint: the same code always gives the same value, and the code can't be read back from it.
export async function villaId(code: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode("villa21:" + code)));
  return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}
const cleanCode = (s: unknown) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const isPerson = (p: unknown): p is string => typeof p === "string" && Object.hasOwn(PEOPLE, p);
const fils = (v: unknown) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 && n <= 100_000_000 ? n : 0; };
const text = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
export const aed = (f: number) => "AED " + (f / 100).toLocaleString("en-US", { minimumFractionDigits: f % 100 ? 2 : 0, maximumFractionDigits: 2 });

export type Note = { title: string; body: string; tag: string };

// One message per person who should hear about it (everyone except the sender).
export function messages(from: string, body: Record<string, unknown>): Record<string, Note> {
  const out: Record<string, Note> = {};
  const others = Object.keys(PEOPLE).filter(p => p !== from);
  const id = text(body.id, 40).replace(/[^\w-]/g, "");
  if (body.kind === "expense") {
    const amount = fils(body.amountF);
    if (!amount) return out;
    const what = [text(body.emoji, 4), text(body.description, 60)].filter(Boolean).join(" ");
    const shares = (body.shares && typeof body.shares === "object" ? body.shares : {}) as Record<string, unknown>;
    for (const p of others) {
      const share = fils(shares[p]);
      out[p] = {
        title: `${PEOPLE[from]} added an expense`,
        body: `${what ? what + " · " : ""}${aed(amount)}${share ? ` · your share ${aed(share)}` : " · not split with you"}`,
        tag: `v21-${id || "expense"}`
      };
    }
  } else if (body.kind === "payment") {
    const amount = fils(body.amountF), payer = body.from, payee = body.to;
    if (!amount || !isPerson(payer) || !isPerson(payee) || payer === payee) return out;
    if (from !== payer && from !== payee) return out;   // only the two people in it record a payment
    for (const p of others) {
      out[p] = {
        title: "Payment recorded",
        body: p === payee ? `${PEOPLE[payer]} paid you ${aed(amount)}` : p === payer ? `${PEOPLE[from]} marked your ${aed(amount)} payment as received` : `${PEOPLE[payer]} paid ${PEOPLE[payee]} ${aed(amount)}`,
        tag: `v21-${id || "payment"}`
      };
    }
  }
  return out;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Sends to every phone of the given people in this villa; forgets phones whose subscription has expired.
// Reports how many phones it found, how many got it, and why the others didn't.
// reached: people at least one of whose phones got it; missing: people with no phone signed up.
type Delivery = { sent: number; phones: number; failures: string[]; reached: string[]; missing: string[] };
async function deliver(env: Env, d: Db, villa: string, people: Record<string, Note>, vapid: Vapid): Promise<Delivery> {
  const names = Object.keys(people);
  if (!names.length) return { sent: 0, phones: 0, failures: [], reached: [], missing: [] };
  const subs: (Subscription & { person: string })[] = await d.get(`villa_push?villa=eq.${villa}&person=in.(${names.join(",")})&select=endpoint,p256dh,auth,person`);
  let sent = 0;
  const failures: string[] = [], reached = new Set<string>();
  await Promise.all(subs.map(async s => {
    try {
      const r = await sendPush(s, people[s.person], vapid, env.allowHttp);
      if (r.status >= 200 && r.status < 300) { sent++; reached.add(s.person); }
      else {
        failures.push(`${PEOPLE[s.person]}: ${r.status}${r.reason ? " " + r.reason : ""}`);
        if (r.status === 404 || r.status === 410) await d.del(`villa_push?endpoint=eq.${encodeURIComponent(s.endpoint)}`);
      }
    } catch (e) { failures.push(`${PEOPLE[s.person]}: ${String((e as Error).message || e).slice(0, 120)}`); }   // one bad phone shouldn't stop the others
  }));
  return {
    sent, phones: subs.length, failures,
    reached: names.filter(p => reached.has(p)).map(p => PEOPLE[p]),
    missing: names.filter(p => !subs.some(s => s.person === p)).map(p => PEOPLE[p])
  };
}
const unpad = (v: unknown) => String(v || "").replace(/=+$/, "");

export async function handle(req: Request, env: Env): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const d = db(env);
    if (body.action === "key") return json({ publicKey: (await vapidKeys(d, req.headers.get("origin"))).publicKey });

    const code = cleanCode(body.code);
    if (code.length !== 20) return json({ error: "Villa 21 code missing" }, 400);
    if (!isPerson(body.person)) return json({ error: "Unknown person" }, 400);
    const villa = await villaId(code), person: string = body.person;

    if (body.action === "subscribe") {
      const s = body.subscription || {};
      // Keys are base64url; some phones add "=" padding at the end, which isn't needed.
      const endpoint = String(s.endpoint || ""), p256dh = unpad(s.p256dh), auth = unpad(s.auth);
      if (!(/^https:\/\//.test(endpoint) || env.allowHttp) || endpoint.length > 1000 || !/^[\w-]{80,100}$/.test(p256dh) || !/^[\w-]{16,30}$/.test(auth)) return json({ error: "Bad subscription" }, 400);
      await d.post("villa_push?on_conflict=endpoint", { endpoint, villa, person, p256dh, auth, user_agent: text(s.userAgent, 300), created_at: new Date().toISOString() }, "resolution=merge-duplicates,return=minimal");
      const phones: { endpoint: string }[] = await d.get(`villa_push?villa=eq.${villa}&select=endpoint&order=created_at.desc&offset=${MAX_PHONES}`);
      for (const p of phones) await d.del(`villa_push?endpoint=eq.${encodeURIComponent(p.endpoint)}`);
      return json({ ok: true });
    }

    if (body.action === "unsubscribe") {
      const endpoint = String(body.endpoint || "");
      if (endpoint) await d.del(`villa_push?endpoint=eq.${encodeURIComponent(endpoint)}&villa=eq.${villa}`);
      return json({ ok: true });
    }

    // Who in this villa has notifications on (number of phones each), and whether the asking phone
    // is one of them, so Settings can show what the server really has.
    if (body.action === "status") {
      const rows: { person: string; endpoint: string }[] = await d.get(`villa_push?villa=eq.${villa}&select=person,endpoint`);
      const endpoint = String(body.endpoint || "");
      return json({
        people: Object.fromEntries(Object.keys(PEOPLE).map(p => [p, rows.filter(r => r.person === p).length])),
        thisPhone: !!endpoint && rows.some(r => r.endpoint === endpoint && r.person === person)
      });
    }

    const vapid = await vapidKeys(d, req.headers.get("origin"));
    if (body.action === "test") return json(await deliver(env, d, villa, { [person]: { title: "Villa 21", body: "Notifications are working on this phone.", tag: "v21-test" } }, vapid));
    if (body.action === "notify") return json(await deliver(env, d, villa, messages(person, body), vapid));
    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    const message = String((err as Error).message || err);
    return json({ error: message }, message === "not_set_up" ? 503 : 500);
  }
}

// The project's service key: the classic service_role key, or the newer secret key.
function serviceKey(get: (k: string) => string | undefined): string {
  const legacy = get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try { const all = JSON.parse(get("SUPABASE_SECRET_KEYS") || "{}"); const v = all.default || Object.values(all)[0]; if (v) return String(v); } catch (_) { /* not set */ }
  return get("SUPABASE_SECRET_KEY") || "";
}

// deno-lint-ignore no-explicit-any
const runtime = (globalThis as any).Deno;
if (runtime) {
  const env: Env = { url: runtime.env.get("SUPABASE_URL") || "", key: serviceKey(k => runtime.env.get(k)) };
  runtime.serve((req: Request) => handle(req, env));
}
