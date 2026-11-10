-- Resi › Studio: Resi Studio's encoders and the events scheduled on them, written down in
-- Tally so the schedule can be read without opening Studio. Resi's API (api.resi.io) can't
-- list or change scheduled events (only start or stop one right now), so this is typed in by
-- hand from Studio and is only as current as the last person who copied it over.
--
-- resi_encoders: one per encoder in Studio › Settings › Encoders, named as it is there, and
-- the location it's at. resi_schedules: one per scheduled event, with the fields of Studio's
-- event form (Schedule › Create › Broadcast, content source Live Encoder): event name and
-- description; encoder, encoder preset and encoder channel; how early the encoder starts
-- (pre-buffer); start date, start time, duration and timezone; repeats (every N hours, days,
-- weeks or months, on which days, ending never, on a date or after N times); destinations;
-- paused. service_time (when the service itself starts) and notes are Tally's own.
-- Staff read and change both; stamped with who changed them and when, and pushed live.

create table if not exists public.resi_encoders (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 80),
  campus_id uuid references public.campuses(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_by_name text,
  updated_by_name text
);
create unique index if not exists resi_encoders_name_key on public.resi_encoders (lower(trim(name)));

create table if not exists public.resi_schedules (
  id uuid primary key default gen_random_uuid(),
  encoder_id uuid not null references public.resi_encoders(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  description text,
  encoder_preset text,
  encoder_channel text,
  prebuffer_min integer not null default 0 check (prebuffer_min between 0 and 720),
  start_date date,
  start_time time not null,
  duration_min integer not null check (duration_min between 1 and 1440),
  timezone text not null default 'America/New_York',
  repeats boolean not null default false,
  repeat_every integer not null default 1 check (repeat_every between 1 and 999),
  repeat_unit text not null default 'week' check (repeat_unit in ('hour', 'day', 'week', 'month')),
  repeat_days smallint[] not null default '{}' check (repeat_days <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]),
  repeat_month text not null default 'date' check (repeat_month in ('date', 'weekday')),
  ends text not null default 'never' check (ends in ('never', 'on', 'after')),
  ends_on date,
  ends_after integer check (ends_after is null or ends_after >= 1),
  destinations text,
  paused boolean not null default false,
  service_time time,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_by_name text,
  updated_by_name text,
  check (ends <> 'on' or ends_on is not null),
  check (ends <> 'after' or ends_after is not null)
);
create index if not exists resi_schedules_encoder_idx on public.resi_schedules (encoder_id, start_time);

alter table public.resi_encoders enable row level security;
create policy "staff see resi encoders" on public.resi_encoders for select to authenticated using (public.has_role('staff'));
create policy "staff add resi encoders" on public.resi_encoders for insert to authenticated with check (public.has_role('staff'));
create policy "staff change resi encoders" on public.resi_encoders for update to authenticated using (public.has_role('staff')) with check (public.has_role('staff'));
create policy "staff remove resi encoders" on public.resi_encoders for delete to authenticated using (public.has_role('staff'));

alter table public.resi_schedules enable row level security;
create policy "staff see resi schedules" on public.resi_schedules for select to authenticated using (public.has_role('staff'));
create policy "staff add resi schedules" on public.resi_schedules for insert to authenticated with check (public.has_role('staff'));
create policy "staff change resi schedules" on public.resi_schedules for update to authenticated using (public.has_role('staff')) with check (public.has_role('staff'));
create policy "staff remove resi schedules" on public.resi_schedules for delete to authenticated using (public.has_role('staff'));

grant select, insert, update, delete on public.resi_encoders, public.resi_schedules to authenticated;

create trigger resi_encoders_stamp before insert or update on public.resi_encoders for each row execute function public.stamp();
create trigger resi_schedules_stamp before insert or update on public.resi_schedules for each row execute function public.stamp();
alter publication supabase_realtime add table public.resi_encoders;
alter publication supabase_realtime add table public.resi_schedules;

-- The encoders in Studio today, each at its location.
insert into public.resi_encoders (name, campus_id)
select v.name, c.id
  from (values ('Anderson', 'AND'), ('Five Forks', 'FF'), ('Fountain Inn', 'FI'), ('GCC', 'GCC'),
               ('Greenville', 'GVL'), ('Harrison Bridge', 'HB'), ('Mauldin', 'MAU'), ('Simpsonville', 'SVL')) as v(name, code)
  join public.campuses c on c.code = v.code
on conflict do nothing;
