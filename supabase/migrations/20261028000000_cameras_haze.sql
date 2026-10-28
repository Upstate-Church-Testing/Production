-- =============================================================================
-- Camera builds and haze (staff, like the rest of Gear).
--
--   camera_builds   one camera position at a location, Cam 1…Cam N, in service
--                   or out of commission. Its gear is every item at that
--                   location whose Spot is "Cam N".
--   haze_fluids     a fluid product: brand, name, part number, bottle size
--   haze_stock      bottles of a fluid on hand at a location, full and opened
--   haze_checks     each time someone checks a hazer's tank: level 0–100%,
--                   whether they filled it, when. The latest check is the level.
--   device_types    + haze_fluid_id (the fluid a hazer model takes)
--                   + tank_liters   (its tank, so a level reads as liters)
-- Hazers stay ordinary lighting items in the "Hazer" category, so they keep
-- their patch and don't show up under "Fixture".
-- =============================================================================

create table public.camera_builds (
  id          uuid primary key default gen_random_uuid(),
  campus_id   uuid not null references public.campuses (id) on delete cascade,
  number      smallint not null check (number between 1 and 99),
  in_service  boolean not null default true,
  note        text check (note is null or length(note) <= 200),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete set null,
  updated_by  uuid references public.profiles (id) on delete set null,
  unique (campus_id, number)
);

create table public.haze_fluids (
  id             uuid primary key default gen_random_uuid(),
  manufacturer   text check (manufacturer is null or length(manufacturer) <= 80),
  name           text not null check (length(trim(name)) between 1 and 120),
  part_number    text check (part_number is null or length(part_number) <= 60),
  bottle_liters  numeric(6,2) check (bottle_liters is null or bottle_liters > 0),
  base           text check (base is null or length(base) <= 40),
  notes          text check (notes is null or length(notes) <= 1000),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references public.profiles (id) on delete set null,
  updated_by     uuid references public.profiles (id) on delete set null
);

create table public.haze_stock (
  id              uuid primary key default gen_random_uuid(),
  campus_id       uuid not null references public.campuses (id) on delete cascade,
  fluid_id        uuid not null references public.haze_fluids (id) on delete cascade,
  full_bottles    int not null default 0 check (full_bottles between 0 and 999),
  opened_bottles  int not null default 0 check (opened_bottles between 0 and 999),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references public.profiles (id) on delete set null,
  updated_by      uuid references public.profiles (id) on delete set null,
  unique (campus_id, fluid_id)
);

create table public.haze_checks (
  id          uuid primary key default gen_random_uuid(),
  device_id   uuid not null references public.devices (id) on delete cascade,
  level       smallint not null check (level between 0 and 100),
  filled      boolean not null default false,
  checked_at  timestamptz not null default now(),
  note        text check (note is null or length(note) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete set null,
  updated_by  uuid references public.profiles (id) on delete set null
);
create index haze_checks_device_idx on public.haze_checks (device_id, checked_at desc);
create index haze_stock_fluid_idx on public.haze_stock (fluid_id);

alter table public.device_types
  add column haze_fluid_id uuid references public.haze_fluids (id) on delete set null,
  add column tank_liters numeric(6,2) check (tank_liters is null or tank_liters > 0);

-- Who and when, on every row.
create trigger camera_builds_stamp before insert or update on public.camera_builds for each row execute function public.stamp();
create trigger haze_fluids_stamp before insert or update on public.haze_fluids for each row execute function public.stamp();
create trigger haze_stock_stamp before insert or update on public.haze_stock for each row execute function public.stamp();
create trigger haze_checks_stamp before insert or update on public.haze_checks for each row execute function public.stamp();

-- Staff only.
alter table public.camera_builds enable row level security;
alter table public.haze_fluids enable row level security;
alter table public.haze_stock enable row level security;
alter table public.haze_checks enable row level security;
do $$
declare t text;
begin
  foreach t in array array['camera_builds', 'haze_fluids', 'haze_stock', 'haze_checks'] loop
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
