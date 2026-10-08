-- Villa 21 notifications, sent through the Supabase project that also runs MITAK.
-- The expenses stay in Firebase; Supabase only keeps which phones want notifications.
--
-- Run once in Supabase › SQL Editor (paste this whole file, Run). Safe to run again.

-- Phones that turned notifications on. "villa" is a SHA-256 fingerprint of the Villa 21 code,
-- never the code itself.
create table if not exists public.villa_push (
  endpoint   text primary key check (char_length(endpoint) <= 1000),
  villa      text not null check (villa ~ '^[0-9a-f]{64}$'),
  person     text not null check (person in ('regin', 'tm', 'rafi')),
  p256dh     text not null check (char_length(p256dh) <= 200),
  auth       text not null check (char_length(auth) <= 100),
  user_agent text not null default '' check (char_length(user_agent) <= 300),
  created_at timestamptz not null default now()
);
create index if not exists villa_push_villa on public.villa_push (villa);

-- Notification keys, shared with MITAK's "notify" function (created on first use).
create table if not exists public.push_config (
  id          int primary key default 1 check (id = 1),
  public_key  text not null,
  private_jwk jsonb not null,
  subject     text not null,
  created_at  timestamptz not null default now()
);

-- Only the Edge Function (with the project's service key) can read or change these.
alter table public.villa_push  enable row level security;
alter table public.push_config enable row level security;
revoke all on public.villa_push, public.push_config from anon, authenticated;
