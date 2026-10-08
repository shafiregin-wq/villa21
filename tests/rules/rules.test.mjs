// Villa 21 Firestore rules, checked on the Firebase emulator.
// Run: npm run test:rules   (starts the Firestore and Auth emulators)
import test, { before, after } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp } from "firebase/firestore";

const V = "villas/v21-TESTCODE";
let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-villa21", firestore: { rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8085 } });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, `${V}/meta/villa`), { name: "Villa 21" });
    await setDoc(doc(db, `${V}/expenses/legacy`), { type: "expense", amountF: 900, paidBy: "tm", createdBy: "regin", participants: ["regin", "tm", "rafi"], split: { regin: 300, tm: 300, rafi: 300 }, date: "2026-10-01" });
  });
});
after(async () => { await env.cleanup(); });

const phone = uid => env.authenticatedContext(uid).firestore();
const expense = (person, extra = {}) => ({ type: "expense", amountF: 12000, amount: 120, description: "Chicken", category: "food", date: "2026-10-08", paidBy: person, participants: ["regin", "tm", "rafi"], split: { regin: 4000, tm: 4000, rafi: 4000 }, splitMode: "equal", createdBy: person, updatedBy: person, ...extra });

test("each phone picks its person once and can't switch", async () => {
  const regin = phone("phone-regin");
  await assertSucceeds(setDoc(doc(regin, `${V}/devices/phone-regin`), { person: "regin", at: serverTimestamp() }));
  await assertFails(setDoc(doc(regin, `${V}/devices/phone-regin`), { person: "tm", at: serverTimestamp() }));
  await assertFails(deleteDoc(doc(regin, `${V}/devices/phone-regin`)));
  await assertFails(setDoc(doc(regin, `${V}/devices/phone-other`), { person: "tm" }), "can't register another phone");
  await assertFails(setDoc(doc(phone("phone-x"), `${V}/devices/phone-x`), { person: "stranger" }), "only the three people");
  await assertSucceeds(setDoc(doc(phone("phone-tm"), `${V}/devices/phone-tm`), { person: "tm" }));
  await assertSucceeds(setDoc(doc(phone("phone-rafi"), `${V}/devices/phone-rafi`), { person: "rafi" }));
  await assertFails(getDoc(doc(phone("phone-tm"), `${V}/devices/phone-regin`)), "phones can't look up each other");
});

test("only your own expenses: add, change, delete", async () => {
  const regin = phone("phone-regin"), tm = phone("phone-tm");
  await assertSucceeds(setDoc(doc(regin, `${V}/expenses/e1`), expense("regin")));
  await assertSucceeds(getDoc(doc(tm, `${V}/expenses/e1`)), "everyone sees it");
  await assertFails(updateDoc(doc(tm, `${V}/expenses/e1`), { amountF: 1 }), "TM can't change Regin's expense");
  await assertFails(deleteDoc(doc(tm, `${V}/expenses/e1`)), "TM can't delete it");
  await assertFails(setDoc(doc(tm, `${V}/expenses/e2`), expense("regin")), "TM can't add an expense as Regin");
  await assertFails(setDoc(doc(tm, `${V}/expenses/e3`), expense("regin", { createdBy: "tm" })), "or say Regin paid");
  await assertFails(setDoc(doc(phone("unregistered"), `${V}/expenses/e4`), expense("rafi")), "a phone that hasn't picked a person can't add");
  await assertSucceeds(updateDoc(doc(regin, `${V}/expenses/e1`), { amountF: 15000, updatedBy: "regin" }));
  await assertFails(updateDoc(doc(regin, `${V}/expenses/e1`), { createdBy: "tm" }), "can't hand it to someone else");
  await assertFails(updateDoc(doc(regin, `${V}/expenses/e1`), { paidBy: "tm" }), "or change who paid");
  await assertSucceeds(deleteDoc(doc(regin, `${V}/expenses/e1`)));
});

test("older entries stay with whoever added them", async () => {
  const regin = phone("phone-regin"), tm = phone("phone-tm");
  await assertFails(updateDoc(doc(tm, `${V}/expenses/legacy`), { amountF: 1 }), "TM paid but Regin added it");
  await assertSucceeds(updateDoc(doc(regin, `${V}/expenses/legacy`), { description: "Fixed", updatedBy: "regin" }), "Regin can still correct it");
});

test("payments only by the people in them", async () => {
  const pay = (from, to, by) => ({ type: "payment", amountF: 5000, amount: 50, description: "Payment", category: "payment", date: "2026-10-08", paidBy: from, participants: [to], split: { [to]: 5000 }, splitMode: "custom", createdBy: by, updatedBy: by });
  await assertSucceeds(setDoc(doc(phone("phone-tm"), `${V}/expenses/p1`), pay("tm", "regin", "tm")), "TM paid Regin, recorded by TM");
  await assertSucceeds(setDoc(doc(phone("phone-regin"), `${V}/expenses/p2`), pay("rafi", "regin", "regin")), "Rafi paid Regin, recorded by Regin");
  await assertFails(setDoc(doc(phone("phone-regin"), `${V}/expenses/p3`), pay("tm", "rafi", "regin")), "Regin can't record TM paying Rafi");
  await assertFails(deleteDoc(doc(phone("phone-rafi"), `${V}/expenses/p2`)), "Rafi can't delete the payment Regin recorded");
});

test("villa set-up and categories", async () => {
  await assertSucceeds(getDoc(doc(phone("unregistered"), `${V}/meta/villa`)), "joining checks the villa exists");
  await assertSucceeds(setDoc(doc(phone("new"), "villas/v21-NEWVILLA/meta/villa"), { name: "Villa 21" }));
  await assertSucceeds(setDoc(doc(phone("phone-rafi"), `${V}/meta/categories`), { list: [{ id: "c-gas", label: "Gas", emoji: "🔥" }] }));
  await assertFails(setDoc(doc(phone("unregistered"), `${V}/meta/categories`), { list: [] }));
  await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(), `${V}/expenses/x`), expense("regin")));
});
