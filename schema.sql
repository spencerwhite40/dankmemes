-- Meme Builder tables. Applied on boot by src/migrate.js (each table with its indexes in ONE statement,
-- never split a CREATE TABLE from what depends on it across separate queries).
create table if not exists meme_builder_personas (
  id          text primary key,
  name        text not null,
  data        jsonb not null,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create table if not exists meme_builder_jobs (
  id            uuid primary key default gen_random_uuid(),
  created_by    uuid,
  persona_id    text not null,
  source_kind   text not null check (source_kind in ('upload','url')),
  source_label  text not null,
  source_url    text,
  source_uri    text,
  parent_job_id uuid references meme_builder_jobs(id) on delete set null,
  status        text not null default 'queued' check (status in ('queued','running','done','error')),
  stage         text not null default 'queued',
  stage_info    jsonb,
  error         text,
  attempts      integer not null default 0,
  options       jsonb not null default '{}'::jsonb,
  analysis      jsonb,
  video_meta    jsonb,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  heartbeat_at  timestamptz
);
create index if not exists meme_builder_jobs_status_idx on meme_builder_jobs (status, created_at);
create index if not exists meme_builder_jobs_created_idx on meme_builder_jobs (created_at desc);
create table if not exists meme_builder_clips (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references meme_builder_jobs(id) on delete cascade,
  persona_id  text not null,
  n           integer not null,
  caption     text not null,
  score       numeric,
  why         text,
  transcript  text,
  emotion     text,
  start_sec   numeric not null,
  end_sec     numeric not null,
  storage_uri text not null,
  rating      smallint not null default 0 check (rating in (-1,0,1)),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists meme_builder_clips_job_idx on meme_builder_clips (job_id, n);
create index if not exists meme_builder_clips_persona_idx on meme_builder_clips (persona_id, created_at desc);

-- ── Ownership, API keys and usage ──────────────────────────────────────────
-- Every run belongs to an owner (a customer). The web page is owner 'default'; each API key belongs to one owner.
-- Added with ALTER ... IF NOT EXISTS plus the backfill, all in this one multi-statement query.
alter table meme_builder_jobs add column if not exists owner_id text;
alter table meme_builder_jobs add column if not exists api_key_id uuid;
update meme_builder_jobs set owner_id = 'default' where owner_id is null;
alter table meme_builder_jobs alter column owner_id set default 'default';
alter table meme_builder_jobs alter column owner_id set not null;
create index if not exists meme_builder_jobs_owner_idx on meme_builder_jobs (owner_id, created_at desc);
alter table meme_builder_personas add column if not exists owner_id text;

create table if not exists api_keys (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              text not null,
  name                  text not null,
  key_hash              text not null unique,
  key_prefix            text not null,
  webhook_secret        text not null,
  rate_limit_per_min    integer not null default 120,
  monthly_minutes_quota numeric,
  created_at            timestamptz not null default now(),
  last_used_at          timestamptz,
  revoked_at            timestamptz
);
create index if not exists api_keys_owner_idx on api_keys (owner_id);

create table if not exists usage_events (
  id             uuid primary key default gen_random_uuid(),
  owner_id       text not null,
  api_key_id     uuid,
  job_id         uuid,
  source_seconds numeric not null default 0,
  clips          integer not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists usage_events_owner_idx on usage_events (owner_id, created_at desc);

-- ── Model usage ledger: every AI call, against the account and run that caused it ─────────────────────────────
create table if not exists model_usage (
  id            uuid primary key default gen_random_uuid(),
  owner_id      text not null,
  job_id        uuid,
  stage         text,
  provider      text not null,
  model         text not null,
  kind          text not null default 'text',
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  cached_tokens bigint not null default 0,
  cost_usd      numeric,
  latency_ms    integer,
  ok            boolean not null default true,
  error         text,
  created_at    timestamptz not null default now()
);
create index if not exists model_usage_owner_idx on model_usage (owner_id, created_at desc);
create index if not exists model_usage_job_idx on model_usage (job_id);

-- ── Accounts, sessions and storage accounting ─────────────────────────────────────────────────────────────────
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  password_hash text not null,
  name          text,
  plan          text not null default 'free',
  is_admin      boolean not null default false,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index if not exists users_email_lower_idx on users (lower(email));

create table if not exists sessions (
  token_hash   text primary key,
  user_id      uuid not null references users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now(),
  user_agent   text
);
create index if not exists sessions_user_idx on sessions (user_id);

-- bytes stored per run's source video and per clip, so storage can be limited by plan
alter table meme_builder_jobs  add column if not exists source_bytes bigint not null default 0;
alter table meme_builder_clips add column if not exists bytes bigint not null default 0;

-- ── Billing (Stripe) ───────────────────────────────────────────────────────────────────────────────────────────
-- The columns, tables and indexes below run as part of the same single query as everything above, in order.
alter table users add column if not exists stripe_customer_id     text;
alter table users add column if not exists stripe_subscription_id text;
alter table users add column if not exists billing_period         text;          -- 'monthly' | 'annual'
alter table users add column if not exists plan_status            text;          -- active | canceling | past_due | canceled
alter table users add column if not exists plan_renews_at         timestamptz;
create unique index if not exists users_stripe_customer_idx on users (stripe_customer_id) where stripe_customer_id is not null;

-- every Stripe event is handled once: its id is stored before it is acted on
create table if not exists stripe_events (
  id          text primary key,
  type        text,
  received_at timestamptz not null default now()
);

-- bought top-up minutes: used after the plan's monthly minutes, oldest-expiring first
create table if not exists credit_packs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(id) on delete cascade,
  pack              text not null,
  minutes           numeric not null,
  remaining         numeric not null,
  stripe_session_id text unique,
  created_at        timestamptz not null default now()
);
-- pack minutes never expire (an earlier version expired them after a year)
alter table credit_packs drop column if exists expires_at;
create index if not exists credit_packs_user_idx on credit_packs (user_id, created_at);

-- A cancelled subscription locks the account: nothing is deleted, nothing can be reached, and a new subscription unlocks it.
alter table users add column if not exists locked_at timestamptz;
-- "Stay another month" offer: the pack promised (granted when the next monthly payment succeeds) and when one was last accepted
alter table users add column if not exists retention_offer_pack    text;
alter table users add column if not exists retention_offer_used_at timestamptz;

-- ── Email: verification and password reset ────────────────────────────────────────────────────────────────────
alter table users add column if not exists email_verified_at timestamptz;
alter table users add column if not exists terms_accepted_at timestamptz;

-- one-time links sent by email. Only the hash of the token is stored, so a database leak can't be replayed.
create table if not exists auth_tokens (
  token_hash text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  purpose    text not null,            -- 'verify' | 'reset'
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists auth_tokens_user_idx on auth_tokens (user_id, purpose);
