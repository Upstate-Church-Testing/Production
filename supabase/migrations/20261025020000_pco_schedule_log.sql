-- =============================================================================
-- Scheduling from the app. Staff put people on open spots through the
-- church-wide Planning Center connection (so Planning Center shows the token's
-- owner as the scheduler); this keeps who in the app did it. Staff only.
-- =============================================================================

create table public.pco_schedule_log (
  id              bigint generated always as identity primary key,
  at              timestamptz not null default now(),
  by              uuid references public.profiles (id) on delete set null,
  action          text not null check (action in ('schedule', 'remove')),
  plan_id         text not null,
  plan_person_id  text,
  person_id       text,
  person_name     text,
  team_id         text,
  position        text
);
create index pco_schedule_log_at_idx on public.pco_schedule_log (at desc);
alter table public.pco_schedule_log enable row level security;
create policy "staff see scheduling log" on public.pco_schedule_log for select using ((select public.has_role('staff')));
