-- =============================================================================
-- Systems (staff): items that work together, like a Clear-Com intercom or a
-- video switching system, wherever each piece sits. Each member can say what
-- it does in the system ("Main station", "Belt pack").
-- Plus one more status: "update" = works, but needs an upgrade or an update.
-- =============================================================================

alter table public.devices drop constraint devices_status_check;
alter table public.devices add constraint devices_status_check
  check (status in ('active', 'spare', 'update', 'check', 'broken', 'repair', 'retired'));

create table public.systems (
  id          uuid primary key default gen_random_uuid(),
  campus_id   uuid not null references public.campuses (id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 120),
  notes       text check (notes is null or length(notes) <= 2000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete set null,
  updated_by  uuid references public.profiles (id) on delete set null
);

create table public.system_items (
  id          uuid primary key default gen_random_uuid(),
  system_id   uuid not null references public.systems (id) on delete cascade,
  device_id   uuid not null references public.devices (id) on delete cascade,
  role        text check (role is null or length(role) <= 80),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete set null,
  updated_by  uuid references public.profiles (id) on delete set null,
  unique (system_id, device_id)
);
create index system_items_device_idx on public.system_items (device_id);

create trigger systems_stamp before insert or update on public.systems for each row execute function public.stamp();
create trigger system_items_stamp before insert or update on public.system_items for each row execute function public.stamp();

alter table public.systems enable row level security;
alter table public.system_items enable row level security;
do $$
declare t text;
begin
  foreach t in array array['systems', 'system_items'] loop
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
