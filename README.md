# Villa 21

Shared flat expenses for Regin, TM and Rafi: who paid what, who owes who, and a monthly summary.
It's a web app made for the iPhone Home Screen. The data is kept in Firebase (Firestore).

- **One phone, one person.** Each phone picks its person once and can't switch. You can add,
  change and delete only your own expenses; everyone sees everything.
- **Notifications** when someone else adds an expense or records a payment, sent through a small
  Supabase function.

Setting up or updating: see [SETUP.md](SETUP.md).

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole app (screens, logic and styles) |
| `config.js` | Firebase settings and the notification function's address (public values only) |
| `sw.js` | Service worker: works offline, shows notifications |
| `firestore.rules` | Firebase security rules (paste into the Firebase console) |
| `supabase/villa-push.sql` | The Supabase table for notification subscriptions |
| `supabase/functions/villa-notify/index.ts` | The Supabase Edge Function that sends notifications |
| `tests/` | Automated tests (not needed to run the app) |

## Tests

```sh
npm install
npm test             # the notification function (encryption, messages, who gets what)
npm run test:rules   # Firebase rules + the app in a browser, on the Firebase emulators (needs Java)
```
