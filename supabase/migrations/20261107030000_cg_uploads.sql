-- CG uploads: for each Sunday, whether each campus's CG is uploaded (not started, working
-- on it, done). Keyed by the Sunday, so the next Sunday starts with nothing (everything
-- Not started) and last week's stay as they were. Staff read and change it; stamped with
-- who changed it and when (public.stamp), and pushed live to open screens.

create table if not exists public.cg_uploads (
  sunday date not null,
  campus_id uuid not null references public.campuses(id) on delete cascade,
  status text not null default 'not_started' check (status in ('not_started', 'working', 'done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_by_name text,
  updated_by_name text,
  primary key (sunday, campus_id),
  check (extract(isodow from sunday) = 7)
);
alter table public.cg_uploads enable row level security;
create policy "staff see cg uploads" on public.cg_uploads for select to authenticated using (public.has_role('staff'));
create policy "staff add cg uploads" on public.cg_uploads for insert to authenticated with check (public.has_role('staff'));
create policy "staff change cg uploads" on public.cg_uploads for update to authenticated using (public.has_role('staff')) with check (public.has_role('staff'));
create trigger cg_uploads_stamp before insert or update on public.cg_uploads for each row execute function public.stamp();
alter publication supabase_realtime add table public.cg_uploads;
