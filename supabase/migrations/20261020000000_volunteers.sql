-- =============================================================================
-- Volunteers: everyone on the production teams, whether or not they have a
-- login. A row is a record the staff keeps about a person (lanyard, tags,
-- notes), not an account: nobody signs in as a volunteer.
--
--   * Everyone on a shown team of a shared Planning Center service is added by
--     the sync (pco_team_people), and so is anyone who shows up on a roster.
--   * Staff can also add people by hand (no Planning Center link).
--   * Lanyards: 'volunteer' (Production Volunteer), 'coach' (Production Coach) or
--     'staff' (Production Staff, added at the end of this file).
--     When and by whom it was given is kept with it.
-- Staff only: volunteers never see this.
-- =============================================================================

create table public.volunteers (
  id              uuid primary key default gen_random_uuid(),
  pco_person_id   text unique,                       -- null when added by hand
  name            text not null check (length(trim(name)) > 0),
  photo           text,
  home_campus_id  uuid references public.campuses (id) on delete set null,
  lanyard         text check (lanyard in ('volunteer', 'coach')),
  lanyard_at      timestamptz,
  lanyard_by      uuid references public.profiles (id) on delete set null,
  tags            text[] not null default '{}',
  notes           text,
  last_seen_at    timestamptz,                        -- last time Planning Center listed them
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references public.profiles (id) on delete set null,
  updated_by      uuid references public.profiles (id) on delete set null
);
create index volunteers_lanyard_idx on public.volunteers (lanyard);

alter table public.volunteers enable row level security;
create policy "staff see volunteers" on public.volunteers for select using ((select public.has_role('staff')));
create policy "staff add volunteers" on public.volunteers for insert with check ((select public.has_role('staff')));
create policy "staff edit volunteers" on public.volunteers for update using ((select public.has_role('staff'))) with check ((select public.has_role('staff')));

create trigger volunteers_stamp before insert or update on public.volunteers
  for each row execute function public.stamp();

-- Keep track of when a lanyard was given, and by whom.
create function public.volunteers_lanyard()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.tags := array(select distinct trim(t) from unnest(coalesce(new.tags, '{}')) t where trim(t) <> '' order by 1);
  if tg_op = 'INSERT' or new.lanyard is distinct from old.lanyard then
    new.lanyard_at := case when new.lanyard is null then null else now() end;
    new.lanyard_by := case when new.lanyard is null then null else auth.uid() end;
  else
    new.lanyard_at := old.lanyard_at;
    new.lanyard_by := old.lanyard_by;
  end if;
  return new;
end
$$;
create trigger volunteers_lanyard before insert or update on public.volunteers
  for each row execute function public.volunteers_lanyard();

-- Who is on each production team in Planning Center (filled by the sync).
create table public.pco_team_people (
  team_id    text not null references public.pco_teams (id) on delete cascade,
  person_id  text not null,
  synced_at  timestamptz not null default now(),
  primary key (team_id, person_id)
);
create index pco_team_people_person_idx on public.pco_team_people (person_id);
alter table public.pco_team_people enable row level security;
create policy "staff see team members" on public.pco_team_people for select using ((select public.has_role('staff')));

alter table public.pco_teams add column people_synced_at timestamptz;

-- Anyone who shows up on a roster becomes a volunteer record too.
create function public.pco_people_to_volunteers()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.person_id is null or nullif(trim(new.name), '') is null then
    return null;
  end if;
  insert into public.volunteers as v (pco_person_id, name, photo, last_seen_at)
  values (new.person_id, trim(new.name), new.photo, now())
  on conflict (pco_person_id) do update
     set name = excluded.name,
         photo = coalesce(excluded.photo, v.photo),
         last_seen_at = excluded.last_seen_at
   where v.name is distinct from excluded.name
      or v.photo is distinct from coalesce(excluded.photo, v.photo)
      or v.last_seen_at is null
      or v.last_seen_at < now() - interval '6 hours';
  return null;
end
$$;
create trigger pco_plan_people_volunteers after insert or update of person_id, name, photo on public.pco_plan_people
  for each row execute function public.pco_people_to_volunteers();

-- Everyone already on a roster.
insert into public.volunteers (pco_person_id, name, photo, last_seen_at)
select distinct on (person_id) person_id, trim(name), photo, now()
  from public.pco_plan_people
 where person_id is not null and nullif(trim(name), '') is not null
 order by person_id, synced_at desc nulls last
on conflict (pco_person_id) do nothing;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.volunteers;
  end if;
end
$$;

-- People added by hand can be removed; Planning Center people come back with the next sync.
create policy "staff remove people added by hand" on public.volunteers for delete
  using ((select public.has_role('staff')) and pco_person_id is null);

-- Production Staff lanyard, and which positions each team member can fill
-- (so people who only run audio can be left out).
alter table public.volunteers
  drop constraint volunteers_lanyard_check,
  add constraint volunteers_lanyard_check check (lanyard in ('volunteer', 'coach', 'staff'));
alter table public.pco_team_people add column positions text[] not null default '{}';
