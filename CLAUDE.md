# Villa 21 — notes for Claude

Shared flat expenses for three people: Regin ("regin"), TM ("tm") and Rafi ("rafi"), in AED (stored
as fils, `amountF`). Single-file PWA (`index.html`) on GitHub Pages + Firebase (anonymous auth,
Firestore). No build step. The owner (Regin) is not a developer: explain steps in plain words, one at
a time, with exact Firebase/Supabase/GitHub clicks.

## How changes go live
- Work on a branch, open a PR to `main`, merge it (the owner has asked for this flow). GitHub Pages
  publishes `main` in 1–2 minutes. Bump `VERSION` in `sw.js` when app files or the worker change.
- **Firestore rules** live in `firestore.rules`; after merging, the owner pastes the whole file into
  Firebase console › Firestore Database › Rules › Publish.
- **Notifications** go through the MITAK Supabase project (`shafiregin-wq/road-claims-`): table
  `villa_push` (`supabase/villa-push.sql`, safe to re-run) and Edge Function `villa-notify`
  (`supabase/functions/villa-notify/index.ts`, single file, no imports, pasted into Supabase › Edge
  Functions, "Enforce JWT verification" off). It shares `push_config` (VAPID keys) with MITAK's
  `notify` function.
- `config.js` holds the Firebase web config and `pushConfig` (function URL + Supabase publishable
  key). All public by design. The repo is public: never commit the villa code or personal data.

## Data and rules
- Everything is under `villas/v21-<CODE>/`: `meta/villa`, `meta/categories`, `expenses/{id}`
  (`type` "expense" | "payment", `paidBy`, `participants`, `split` {person: fils}, `createdBy`, …) and
  `devices/{auth uid}` = `{ person, at }`.
- **One phone, one person ("lock the phone only", no PIN):** a phone picks its person once; the device
  doc can be created but never changed or deleted. The app remembers `v21.lock` = `CODE:person`.
- **Own entries only:** create needs `createdBy == me` and (expense) `paidBy == me` / (payment) me is
  payer or payee. Update/delete only by `createdBy`. Older entries added for someone else stay with
  whoever added them (`paidBy` may not change).
- The app mirrors this: no "Paid by" chooser, Edit/Delete only on your own entries, "Paid" button
  only for debts you're part of, no person switcher in Settings.
- If the old rules are still published, picking a person works locally and the device doc is saved
  once the new rules are live.

## Notifications
The phone calls `villa-notify` with the villa code (stored server-side only as SHA-256 of
`"villa21:" + code`) and its person. Actions: `key`, `subscribe`, `unsubscribe`, `test`, `notify`
(`kind` "expense" with `shares`, or "payment" with `from`/`to`). Texts are built in the function, never
taken from the phone. Sent for new expenses/payments only, to everyone except the sender.

## Tests (run before every PR)
```
npm install
npm test             # villa-notify: Web Push crypto, messages, fake Supabase + decrypting fake phones
npm run test:rules   # firestore.rules + the app in Chromium (3 phones) on the Firebase emulators; needs Java
```
The sandbox blocks gstatic.com; the browser test serves the Firebase SDK from `node_modules/firebase`.
Without Firebase settings, the app offers sample data ("Look around with sample data").
