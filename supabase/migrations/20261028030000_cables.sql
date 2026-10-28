-- =============================================================================
-- Cables (staff). Cables aren't tracked one by one like gear: nothing about a
-- single 25' DMX cable needs its own record. Instead:
--
--   cable_types  what a cable is: its signal and its two ends
--                (DMX · XLR 5-pin male → XLR 5-pin female), plus an optional
--                nickname ("PowerCon link")
--   cables       how many of one length and label a location has
--                (25 ft, Elite Core label, blue, 6 of them, Simpsonville storage)
--
-- So "Types" answers what kinds of cable we have and how many of each, and
-- "Cables" lists every length and label with its count.
-- =============================================================================

create table public.cable_types (
  id          uuid primary key default gen_random_uuid(),
  signal      text not null check (length(trim(signal)) between 1 and 40),
  end_a       text not null check (length(trim(end_a)) between 1 and 60),
  end_b       text not null check (length(trim(end_b)) between 1 and 60),
  name        text check (name is null or length(name) <= 80),
  notes       text check (notes is null or length(notes) <= 1000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete set null,
  updated_by  uuid references public.profiles (id) on delete set null,
  unique (signal, end_a, end_b)
);

create table public.cables (
  id           uuid primary key default gen_random_uuid(),
  type_id      uuid not null references public.cable_types (id) on delete cascade,
  campus_id    uuid not null references public.campuses (id) on delete cascade,
  room_id      uuid references public.rooms (id) on delete set null,
  length_ft    numeric(6,1) not null check (length_ft > 0 and length_ft <= 1000),
  labeled      boolean not null default false,   -- has an Elite Core label sleeve
  label_color  text check (label_color is null or length(label_color) <= 30),
  quantity     int not null default 1 check (quantity between 0 and 9999),
  notes        text check (notes is null or length(notes) <= 1000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references public.profiles (id) on delete set null,
  updated_by   uuid references public.profiles (id) on delete set null
);
create index cables_type_idx on public.cables (type_id);
create index cables_campus_idx on public.cables (campus_id, room_id);

create trigger cable_types_stamp before insert or update on public.cable_types for each row execute function public.stamp();
create trigger cables_stamp before insert or update on public.cables for each row execute function public.stamp();

alter table public.cable_types enable row level security;
alter table public.cables enable row level security;
do $$
declare t text;
begin
  foreach t in array array['cable_types', 'cables'] loop
    execute format('create policy "staff see %1$s" on public.%1$I for select using ((select public.has_role(''staff'')))', t);
    execute format('create policy "staff add %1$s" on public.%1$I for insert with check ((select public.has_role(''staff'')))', t);
    execute format('create policy "staff edit %1$s" on public.%1$I for update using ((select public.has_role(''staff''))) with check ((select public.has_role(''staff'')))', t);
    execute format('create policy "staff remove %1$s" on public.%1$I for delete using ((select public.has_role(''staff'')))', t);
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
