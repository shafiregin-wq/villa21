// Villa 21: Firebase connection settings.
// From Firebase console → Project settings → Your apps → Villa 21 (web app).
// These values are not secret: the private Villa 21 code (entered once on each phone)
// is what keeps your expenses private, and it is never stored in this file.

export const firebaseConfig = {
  apiKey: "AIzaSyAss3AFpzHQ-wFkkAdPyxzezVAOKTRkP4k",
  authDomain: "villa21-ff3eb.firebaseapp.com",
  projectId: "villa21-ff3eb",
  storageBucket: "villa21-ff3eb.firebasestorage.app",
  messagingSenderId: "285823440087",
  appId: "1:285823440087:web:0af824fd754106cbec4c92"
};

// Notifications: sent by the Supabase function "villa-notify" (see SETUP.md). The key is Supabase's
// publishable key, which is meant to be public. Never put a secret or service_role key here.
export const pushConfig = {
  url: "https://lgyoqcblgtgvxitiunod.supabase.co/functions/v1/villa-notify",
  key: "sb_publishable_JywSs9ZrbTKaX9Daf7Ah6w_vXtLXl4H"
};
