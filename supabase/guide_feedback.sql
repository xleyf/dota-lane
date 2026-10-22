create table if not exists public.guide_feedback (
  guide_id text not null check (guide_id ~ '^[0-9]{5,20}$'),
  visitor_id uuid not null,
  games_played integer not null check (games_played between 1 and 5000),
  rating smallint not null check (rating between 1 and 5),
  created_at timestamptz not null default now(),
  primary key (guide_id, visitor_id)
);

alter table public.guide_feedback enable row level security;
revoke all on table public.guide_feedback from anon, authenticated;
grant insert on table public.guide_feedback to anon, authenticated;
drop policy if exists "Visitors can add one guide rating" on public.guide_feedback;
create policy "Visitors can add one guide rating" on public.guide_feedback
  for insert to anon, authenticated with check (
    guide_id ~ '^[0-9]{5,20}$'
    and games_played between 1 and 5000
    and rating between 1 and 5
  );

-- The public endpoint returns aggregates only; individual visitor IDs stay private.
create or replace view public.guide_feedback_stats as
select guide_id,
       sum(games_played)::bigint as games_played,
       round(avg(rating)::numeric, 1) as rating,
       count(*)::bigint as votes
from public.guide_feedback
group by guide_id;
revoke all on public.guide_feedback_stats from anon, authenticated;
grant select on public.guide_feedback_stats to anon, authenticated;
