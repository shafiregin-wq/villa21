# Villa 21: setting up the update

This update adds two things:

- **Your own entries only.** Each phone belongs to one person (Regin, TM or Rafi). You can add,
  change and delete only your own expenses. Everyone still sees everything. A payment can only be
  marked as paid by one of the two people in it.
- **Notifications.** When someone adds an expense or a payment, the other two get a notification.

It takes about 10 minutes, done once by whoever looks after the app. Steps 1 and 2 are in
Firebase, and step 3 is in Supabase (the same project MITAK uses).

## 1. Publish the new Firebase rules

The rules are what stop one person's phone from changing another person's expenses, even
from outside the app.

1. Open [console.firebase.google.com](https://console.firebase.google.com) and choose the
   **villa21** project.
2. **Build** › **Firestore Database** › the **Rules** tab.
3. Select everything in the editor and delete it. Open [`firestore.rules`](firestore.rules) from
   this repository, copy all of it, paste it in, and press **Publish**.

Do this as soon as the update is on GitHub. Until then, the app hides the Edit and Delete buttons
on other people's expenses, but the database doesn't enforce it yet.

## 2. Choose who you are, once per phone

Open Villa 21 on each phone. It asks **Who are you?** once. Pick your own name and confirm.
From then on that phone is always you, and Settings no longer has a way to switch.

If a phone was set to the wrong person:

1. In Firebase, **Firestore Database** › **Data** › `villas` › your villa (`v21-…`) › `devices`.
   Each document there is one phone, with the `person` it belongs to and when it was set up.
   Delete the wrong one.
2. On that phone, remove Villa 21 from the Home Screen (this clears its saved data), add it again
   from Safari and paste the Villa 21 code. It asks **Who are you?** again.

## 3. Notifications (Supabase)

Villa 21's data stays in Firebase. Supabase only sends the notifications, using the MITAK project
you already have.

1. Open [supabase.com](https://supabase.com), open the MITAK project, then **SQL Editor** ›
   **New query**. Paste all of [`supabase/villa-push.sql`](supabase/villa-push.sql) and press
   **Run**. It should say "Success. No rows returned". It adds one table and doesn't touch MITAK's data.
2. **Edge Functions** › **Deploy a new function** › **Via Editor**.
3. Name it exactly `villa-notify`. Delete the example code, paste the whole of
   [`supabase/functions/villa-notify/index.ts`](supabase/functions/villa-notify/index.ts), and
   press **Deploy**.
4. Open the function's **Details** (or settings), turn **off** “Enforce JWT verification”
   (sometimes called “Verify JWT”), and save. Villa 21 phones don't sign in to Supabase; the
   function checks the Villa 21 code instead.

The function's address and the Supabase publishable key are already in [`config.js`](config.js).

Then each person, on their own phone:

- **iPhone:** notifications only work from the Home Screen app (iOS 16.4 or later). In Safari tap
  **Share** › **Add to Home Screen**, open Villa 21 from the Home Screen, and tap **Turn on** on
  the Home screen banner (or **Settings** › **Turn on notifications**), then allow them.
- **Android:** open Villa 21 in Chrome › **Settings** › **Turn on notifications**.

**Settings** › **Send a test** checks it works on that phone. Notifications go out for new
expenses and payments, not for edits or deletions.

## Updating later

If an update changes [`firestore.rules`](firestore.rules), publish it again as in step 1. If it
changes the notification function, open **Edge Functions** › `villa-notify` › **Code**, replace it
with the new file and **Deploy**. Running [`supabase/villa-push.sql`](supabase/villa-push.sql)
again is always safe.
