-- Adds Steam OpenID identities, owned content, and account-backed guide ratings.
-- Run after schema.sql, forum.sql, guide_feedback.sql, and moderation.sql.

create table if not exists public.steam_profiles (
  id uuid primary key default gen_random_uuid(),
  steam_id text not null unique check (steam_id ~ '^[0-9]{17}$'),
  is_moderator boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.steam_login_states (
  state_hash text primary key,
  client_hash text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
alter table public.steam_login_states add column if not exists client_hash text;
alter table public.steam_login_states add column if not exists created_at timestamptz not null default now();
create table if not exists public.steam_login_tickets (
  ticket_hash text primary key,
  steam_id text not null check (steam_id ~ '^[0-9]{17}$'),
  expires_at timestamptz not null
);
create table if not exists public.steam_sessions (
  token_hash text primary key,
  profile_id uuid not null references public.steam_profiles(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table if not exists public.steam_write_events (
  profile_id uuid not null references public.steam_profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.steam_profiles enable row level security;
alter table public.steam_login_states enable row level security;
alter table public.steam_login_tickets enable row level security;
alter table public.steam_sessions enable row level security;
alter table public.steam_write_events enable row level security;
revoke all on public.steam_profiles, public.steam_login_states,
  public.steam_login_tickets, public.steam_sessions,
  public.steam_write_events from anon, authenticated;
grant all on public.steam_profiles, public.steam_login_states,
  public.steam_login_tickets, public.steam_sessions,
  public.steam_write_events to service_role;

create or replace function public.consume_steam_state(p_hash text)
returns boolean language plpgsql security definer set search_path = public
as $$
begin
  delete from public.steam_login_states
  where state_hash = p_hash and expires_at > now();
  return found;
end;
$$;
create or replace function public.consume_steam_ticket(p_hash text)
returns table(steam_id text) language sql security definer set search_path = public
as $$
  delete from public.steam_login_tickets
  where ticket_hash = p_hash and expires_at > now()
  returning steam_login_tickets.steam_id;
$$;
revoke all on function public.consume_steam_state(text) from public, anon, authenticated;
revoke all on function public.consume_steam_ticket(text) from public, anon, authenticated;
grant execute on function public.consume_steam_state(text) to service_role;
grant execute on function public.consume_steam_ticket(text) to service_role;

create or replace function public.allow_steam_write(p_profile_id uuid)
returns boolean language plpgsql security definer set search_path = public
as $$
declare recent_count integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_profile_id::text));
  delete from public.steam_write_events where created_at < now() - interval '1 day';
  select count(*) into recent_count from public.steam_write_events
    where profile_id = p_profile_id and created_at > now() - interval '1 minute';
  if recent_count >= 10 then return false; end if;
  insert into public.steam_write_events(profile_id) values (p_profile_id);
  return true;
end;
$$;
revoke all on function public.allow_steam_write(uuid) from public, anon, authenticated;
grant execute on function public.allow_steam_write(uuid) to service_role;

alter table public.guides
  add column if not exists owner_profile_id uuid references public.steam_profiles(id) on delete set null;
alter table public.forum_threads
  add column if not exists owner_profile_id uuid references public.steam_profiles(id) on delete set null;
alter table public.forum_replies
  add column if not exists owner_profile_id uuid references public.steam_profiles(id) on delete set null;

alter table public.guide_feedback
  add column if not exists steam_verified boolean not null default false;
alter table public.guide_feedback drop constraint if exists guide_feedback_games_played_check;
alter table public.guide_feedback add constraint guide_feedback_games_played_check
  check (games_played between 0 and 5000);
drop policy if exists "Visitors can add one guide rating" on public.guide_feedback;
revoke insert, update, delete on public.guide_feedback from anon, authenticated;

create or replace view public.guide_feedback_stats as
select guide_id,
       sum(games_played)::bigint as games_played,
       round(avg(rating)::numeric, 1) as rating,
       count(*)::bigint as votes
from public.guide_feedback
where steam_verified
group by guide_id;
revoke all on public.guide_feedback_stats from anon, authenticated;
grant select on public.guide_feedback_stats to anon, authenticated;

-- All community writes now pass through steam-auth, which verifies ownership.
drop policy if exists "Visitors can submit guides for review" on public.guides;
drop policy if exists "Visitors can submit forum threads for review" on public.forum_threads;
drop policy if exists "Visitors can submit replies for review" on public.forum_replies;
drop policy if exists "Visitors can report public content" on public.content_reports;
revoke insert, update, delete on public.guides, public.forum_threads,
  public.forum_replies, public.content_reports from anon, authenticated;

-- The Edge Function uses service_role for all authenticated community writes and moderation.
grant select, insert, update, delete on table public.guides, public.forum_threads,
  public.forum_replies, public.content_reports, public.guide_feedback to service_role;
grant usage, select on sequence public.guides_id_seq, public.forum_threads_id_seq,
  public.forum_replies_id_seq, public.content_reports_id_seq to service_role;
grant select on public.guides, public.forum_threads, public.forum_replies to anon, authenticated;
grant select on public.content_reports to service_role;

create or replace view public.community_profiles as
select id, steam_id from public.steam_profiles;
revoke all on public.community_profiles from anon, authenticated;
-- This view is not used by the public client; keep Steam IDs private to the Edge Function.

create index if not exists guides_owner_profile_idx on public.guides(owner_profile_id);
create index if not exists forum_threads_owner_profile_idx on public.forum_threads(owner_profile_id);
create index if not exists forum_replies_owner_profile_idx on public.forum_replies(owner_profile_id);
create index if not exists steam_sessions_expiry_idx on public.steam_sessions(expires_at);
create index if not exists steam_login_states_expiry_idx on public.steam_login_states(expires_at);
create index if not exists steam_login_tickets_expiry_idx on public.steam_login_tickets(expires_at);
create index if not exists steam_login_states_ip_created_idx on public.steam_login_states(client_hash, created_at desc);
create index if not exists steam_write_events_profile_created_idx on public.steam_write_events(profile_id, created_at desc);

-- The server-side client writes reports with the existing identity sequence.
grant usage, select on sequence public.content_reports_id_seq to service_role;
