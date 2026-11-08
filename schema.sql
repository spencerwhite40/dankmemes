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
