-- =============================================================================
-- Lighting numbers: every item gets the numbers a lighting team works with.
--
--   Model #     device_types.part_number   The maker's model number (JOL299).
--   DMX modes   device_types.dmx_modes     Channel counts the model offers
--                                          (6, 9, 13…); dmx_footprint is the
--                                          one the team uses, when it's the same
--                                          everywhere.
--   Asset #     devices.asset_no           1…N per model across every location.
--                                          Permanent and never reused, so a fixture
--                                          keeps its number through repairs and moves.
--   Stage #     devices.stage_no           1…N per model in one room
--                                          ("Jolt 5 on the Worship Center stage").
--   Fixture ID  devices.fixture_id         The console's number for it: grandMA3
--                                          Fixture ID, Eos channel, Hog fixture
--                                          number (Jolts 401–424).
--   Patch       devices.patch_universe     "1.333" is universe 1, address 333.
--               devices.patch_address      Kept as two numbers so universe 1 can be
--                                          searched and counted across locations.
--   Channels    devices.dmx_channels       This one's footprint when it differs
--                                          from the model's.
--
-- A patch belongs to the console in that room, so patches and fixture IDs are
-- per location + room. Moving an item to another room gives it the next stage
-- number there and clears its patch and fixture ID (they belonged to the old rig).
-- =============================================================================

alter table public.device_types
  add column dmx_modes     int[] not null default '{}'
    constraint device_types_dmx_modes_check check (1 <= all (dmx_modes) and 512 >= all (dmx_modes)),
  add column dmx_footprint int check (dmx_footprint between 1 and 512);

alter table public.devices
  add column asset_no       int check (asset_no > 0),
  add column stage_no       int check (stage_no > 0),
  add column fixture_id     int check (fixture_id > 0),
  add column patch_universe int check (patch_universe between 1 and 63999),
  add column patch_address  int check (patch_address between 1 and 512),
  add column dmx_channels   int check (dmx_channels between 1 and 512),
  add constraint devices_patch_pair check ((patch_universe is null) = (patch_address is null));

create index devices_patch_idx   on public.devices (patch_universe, patch_address) where patch_universe is not null;
create index devices_fixture_idx on public.devices (campus_id, room_id, fixture_id) where fixture_id is not null;

-- The highest asset number each model has ever handed out, so a deleted
-- fixture's number is never given to another one.
create table public.asset_counters (
  type_id  uuid primary key references public.device_types (id) on delete cascade,
  last     int not null default 0
);
alter table public.asset_counters enable row level security;
create policy "staff read asset counters" on public.asset_counters for select using (public.has_role('staff'));


-- ---------------------------------------------------------------------------
-- Numbering: runs before every insert and update of an item.
-- ---------------------------------------------------------------------------
create function public.devices_numbers()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  extra   jsonb := nullif(current_setting('app.device_numbers', true), '')::jsonb;
  moved   boolean := tg_op = 'UPDATE' and (new.campus_id is distinct from old.campus_id or new.room_id is distinct from old.room_id);
  retyped boolean := tg_op = 'UPDATE' and new.type_id is distinct from old.type_id;
  foot    int;
begin
  -- Numbers sent with save_device_full: only the ones the person changed.
  if jsonb_typeof(extra) = 'object' then
    perform set_config('app.device_numbers', '', true);   -- one item per save
    if extra ? 'asset_no'       then new.asset_no       := nullif(extra ->> 'asset_no', '')::int; end if;
    if extra ? 'stage_no'       then new.stage_no       := nullif(extra ->> 'stage_no', '')::int; end if;
    if extra ? 'fixture_id'     then new.fixture_id     := nullif(extra ->> 'fixture_id', '')::int; end if;
    if extra ? 'patch_universe' then new.patch_universe := nullif(extra ->> 'patch_universe', '')::int; end if;
    if extra ? 'patch_address'  then new.patch_address  := nullif(extra ->> 'patch_address', '')::int; end if;
    if extra ? 'dmx_channels'   then new.dmx_channels   := nullif(extra ->> 'dmx_channels', '')::int; end if;
  end if;

  -- Asset #: next for the model, across every location, never reused.
  if new.asset_no is null or (retyped and new.asset_no is not distinct from old.asset_no) then
    insert into public.asset_counters (type_id, last) values (new.type_id, 0) on conflict (type_id) do nothing;
    update public.asset_counters c
       set last = greatest(c.last, coalesce((select max(d.asset_no) from public.devices d where d.type_id = new.type_id), 0)) + 1
     where c.type_id = new.type_id
    returning c.last into new.asset_no;
  elsif tg_op = 'INSERT' or new.asset_no is distinct from old.asset_no then
    insert into public.asset_counters (type_id, last) values (new.type_id, new.asset_no)
    on conflict (type_id) do update set last = greatest(public.asset_counters.last, excluded.last);
  end if;

  -- Stage #: next for the model in its room, on arrival.
  if (tg_op = 'INSERT' and new.stage_no is null)
     or ((moved or retyped) and new.stage_no is not distinct from old.stage_no) then
    perform pg_advisory_xact_lock(hashtextextended('stage:' || new.type_id::text || ':' || coalesce(new.room_id, new.campus_id)::text, 0));
    select coalesce(max(d.stage_no), 0) + 1 into new.stage_no
      from public.devices d
     where d.type_id = new.type_id and d.campus_id = new.campus_id
       and d.room_id is not distinct from new.room_id and d.id <> new.id;
  end if;

  -- A patch and fixture ID belong to the old room's console.
  if moved then
    if new.fixture_id is not distinct from old.fixture_id then new.fixture_id := null; end if;
    if new.patch_universe is not distinct from old.patch_universe
       and new.patch_address is not distinct from old.patch_address then
      new.patch_universe := null;
      new.patch_address := null;
    end if;
  end if;

  -- A fixture can't run past the end of its universe.
  if new.patch_address is not null then
    select coalesce(new.dmx_channels, t.dmx_footprint, case when cardinality(t.dmx_modes) = 1 then t.dmx_modes[1] end, 1)
      into foot from public.device_types t where t.id = new.type_id;
    if new.patch_address + foot - 1 > 512 then
      raise exception 'Patched at %.% with % channels, it runs past address 512. Start it at %.% or lower, or on the next universe.',
        new.patch_universe, new.patch_address, foot, new.patch_universe, 513 - foot using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;


-- ---------------------------------------------------------------------------
-- Saving: save_device plus the numbers, in one transaction and one history entry.
-- payload.numbers holds only the numbers that changed.
-- ---------------------------------------------------------------------------
create function public.save_device_full(payload jsonb)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare
  dev_id uuid;
begin
  perform set_config('app.device_numbers', coalesce(payload -> 'numbers', '{}'::jsonb)::text, true);
  dev_id := public.save_device(payload);
  perform set_config('app.device_numbers', '', true);
  return dev_id;
end
$$;

-- The patch sheet saves many items at once: [{ id, fixture_id?, patch_universe?, … }].
-- Only the keys present change. Asset numbers can be swapped within one save.
create function public.set_device_numbers(rows jsonb)
returns int
language plpgsql security invoker set search_path = ''
as $$
declare
  r jsonb;
  n int := 0;
begin
  if not public.has_role('staff') then
    raise exception 'Only staff can edit gear.' using errcode = '42501';
  end if;
  set constraints public.devices_type_asset_key deferred;
  for r in select * from jsonb_array_elements(coalesce(rows, '[]')) loop
    update public.devices d set
      asset_no       = case when r ? 'asset_no'       then nullif(r ->> 'asset_no', '')::int       else d.asset_no end,
      stage_no       = case when r ? 'stage_no'       then nullif(r ->> 'stage_no', '')::int       else d.stage_no end,
      fixture_id     = case when r ? 'fixture_id'     then nullif(r ->> 'fixture_id', '')::int     else d.fixture_id end,
      patch_universe = case when r ? 'patch_universe' then nullif(r ->> 'patch_universe', '')::int else d.patch_universe end,
      patch_address  = case when r ? 'patch_address'  then nullif(r ->> 'patch_address', '')::int  else d.patch_address end,
      dmx_channels   = case when r ? 'dmx_channels'   then nullif(r ->> 'dmx_channels', '')::int   else d.dmx_channels end
    where d.id = (r ->> 'id')::uuid;
    if found then n := n + 1; end if;
  end loop;
  set constraints public.devices_type_asset_key immediate;   -- duplicates fail here, with the save
  return n;
end
$$;


-- ---------------------------------------------------------------------------
-- Number what's already here (quietly: no history rows, no "edited" stamps).
--   Asset #: by location order, then room (Worship Center first, Storage last),
--            then the number at the end of the item's name.
--   Stage #: 1…N per model in each room, by the number at the end of the name.
-- ---------------------------------------------------------------------------
alter table public.devices disable trigger devices_activity;
alter table public.devices disable trigger devices_stamp;

with ordered as (
  select d.id,
         row_number() over (
           partition by d.type_id
           order by c.sort_order, c.name,
                    coalesce(r.name ilike '%storage%', true),
                    coalesce(r.name ilike 'worship%', false) desc,
                    r.sort_order nulls last, r.name nulls last,
                    (regexp_match(d.name, '(\d+)\s*$'))[1]::int nulls last, d.name, d.created_at, d.id) as asset,
         row_number() over (
           partition by d.type_id, d.campus_id, d.room_id
           order by (regexp_match(d.name, '(\d+)\s*$'))[1]::int nulls last, d.name, d.created_at, d.id) as stage
    from public.devices d
    join public.campuses c on c.id = d.campus_id
    left join public.rooms r on r.id = d.room_id
)
update public.devices d set asset_no = o.asset, stage_no = o.stage
  from ordered o
 where o.id = d.id;

alter table public.devices enable trigger devices_activity;
alter table public.devices enable trigger devices_stamp;

insert into public.asset_counters (type_id, last)
select type_id, max(asset_no) from public.devices group by type_id;

alter table public.devices
  add constraint devices_type_asset_key unique (type_id, asset_no) deferrable initially immediate;

create trigger devices_numbers before insert or update on public.devices
  for each row execute function public.devices_numbers();


-- ---------------------------------------------------------------------------
-- Model numbers, DMX modes and manuals, from each maker's own site, datasheet or
-- manual. A model number is filled in only when it's confirmed for the exact
-- product; models that come in versions (black/white housing, 4 vs 4X) are left
-- for the team to read off the label. Nothing already filled in is replaced.
-- ---------------------------------------------------------------------------
update public.device_types t set
  part_number = coalesce(t.part_number, v.pn),
  dmx_modes   = case when cardinality(t.dmx_modes) = 0 then v.modes::int[] else t.dmx_modes end,
  manual_url  = coalesce(t.manual_url, v.manual)
from (values
  ('ADJ', 'Jolt Panel FX2', 'JOL299', '{6,9,13,18,20,36,41,43,51,81,83,126,141,143}',
     'https://assets.centryngroup.com/dl/files/JOLTPANELFX2_USERMANUAL.pdf'),
  ('Antari', 'HZ-350', 'HZ-350', '{1}',
     'https://www.antari.com/usermanual/HZ/HZ-350/HZ-350.pdf'),
  ('Chauvet DJ', 'ColorBand Pix ILS', 'COLORBANDPIXILS', '{3,4,6,7,8,9,12,18,36,41}',
     'https://www.chauvetdj.com/wp-content/uploads/2022/10/COLORband_PiX_ILS_UM_Rev2.pdf'),
  ('Chauvet DJ', 'ColorBand Pix USB', 'COLORBANDPIXUSB', '{3,4,6,7,8,9,12,18,36,41}',
     'https://www.chauvetdj.com/wp-content/uploads/2016/09/COLORband_PiX_USB_UM_Rev2_WO.pdf'),
  ('Chauvet DJ', 'ColorBand Pix-M ILS', 'COLORBANDPIXMILS', '{5,6,8,10,17,32,36}',
     'https://www.chauvetdj.com/wp-content/uploads/2023/03/COLORband_PiX_M_ILS_UM_Rev5-1.pdf'),
  ('Chauvet DJ', 'ColorBand Pix-M USB', 'COLORBANDPIXMUSB', '{5,6,8,10,17,32,36}',
     'https://www.chauvetdj.com/wp-content/uploads/2016/12/COLORband_PiX-M_USB_v2_UM_Rev1_WO.pdf'),
  ('Chauvet DJ', 'ColorBand Spectra ILS', 'COLORBANDSPECTRAILS', '{6,11,17,19,164}',
     'https://www.chauvetdj.com/wp-content/uploads/2026/01/COLORband_Spectra_ILS_UM_Rev3.pdf'),
  ('Chauvet DJ', 'Intimidator Hybrid 140 SR', 'INTIMHYBRID140SR', '{13,19}',
     'https://www.chauvetdj.com/wp-content/uploads/2016/09/Intimidator_Hybrid_140SR_V2_UM_Rev6.pdf'),
  ('Chauvet DJ', 'Intimidator Spot 375Z IRC', null, '{9,15}',
     'https://www.chauvetdj.com/wp-content/uploads/2017/07/Intimidator_Spot_375Z_IRC_UM_Rev7.pdf'),
  ('Chauvet DJ', 'SlimBank H18 ILS', 'SLIMBANKH18ILS', '{6,8,12,22}',
     'https://www.chauvetdj.com/wp-content/uploads/2023/12/SlimBANK-H18-ILS_UM_Rev1.pdf'),
  ('Chauvet DJ', 'SlimPar ProW USB', null, '{3,4,9}',
     'https://www.chauvetdj.com/wp-content/uploads/2016/01/SlimPAR_PRO_W_USB_UM_Rev5.pdf'),
  ('Chauvet Professional', 'Colorado Solo Batten', 'COLORADOSOLOBATTEN',
     '{3,4,5,6,8,9,10,12,13,15,16,17,19,20,21,22,24,27,30,36,43,48,60,75,85,87,99,120,160}',
     'https://chauvetprofessional.com/wp-content/uploads/2018/01/COLORado_Solo_Batten_UM_Rev2.pdf'),
  ('Chauvet Professional', 'ColorDash Quad 7', 'COLORDASHPARQUAD7', '{4,6,10}',
     'https://chauvetprofessional.com/wp-content/uploads/2015/07/COLORdash_Par-Quad_7_UM_Rev6.pdf'),
  ('Chauvet Professional', 'Epix Bar Tour', 'EPIXBARTOUR', '{450}',
     'https://chauvetprofessional.com/wp-content/uploads/pdf/en/EPIXBARTOUR.pdf'),
  ('Chauvet Professional', 'Epix Strip Tour', 'EPIXSTRIPTOUR', '{150}',
     'https://chauvetprofessional.com/wp-content/uploads/2015/07/Epix_Strip_Tour_QRG_Rev4_ML4.pdf'),
  ('Chauvet Professional', 'MK2 Spot', 'MAVERICKMK2SPOT', '{24,32}',
     'https://chauvetprofessional.com/wp-content/uploads/2018/10/Maverick_MK2_Spot_UM_ML5_Rev11.pdf'),
  ('Chauvet Professional', 'Ovation B-1965FC', 'OVATIONB1965FC', '{3,4,5,8,9,10,17,21,28,35,45,52,59,70,96}',
     'https://chauvetprofessional.com/wp-content/uploads/2015/01/Ovation_B-1965FC_UM_Rev8.pdf'),
  ('Chauvet Professional', 'Ovation B-565FC', 'OVATIONB565FC', '{3,4,5,6,8,9,10,15,17,19,20,31}',
     'https://chauvetprofessional.com/wp-content/uploads/2015/01/Ovation_B-565FC_UM_Rev7.pdf'),
  ('Chauvet Professional', 'R2X Beam', 'ROGUER2XBEAM', '{16,19}',
     'https://chauvetprofessional.com/wp-content/uploads/2018/09/Rogue_R2X_Beam_UM_Rev1.pdf'),
  ('Chauvet Professional', 'R2X Wash', 'ROGUER2XWASH', '{15,17,22,33,54,56}',
     'https://chauvetprofessional.com/wp-content/uploads/2019/10/Rogue_R2X_Wash_UM_Rev9.pdf'),
  ('Chauvet Professional', 'R3 Beam', 'ROGUER3BEAM', '{16,19}',
     'https://chauvetprofessional.com/wp-content/uploads/2021/04/Rogue_R3_Beam_UM_Rev6-1.pdf'),
  ('Elation', 'Design Wash LED Zoom', 'DWZ056', '{12,14}',
     'https://assets.centryngroup.com/dl/files/DWZ056__DL__005.pdf'),
  ('Elation', 'SixPar 200', 'SIX054', '{6,7,8,12}',
     'https://www.elationlighting.com/products/sixpar-200'),
  ('ETC', 'ColorSource Par Deep Blue', null, '{1,3,5,6}',
     'https://www.etcconnect.com/WorkArea/DownloadAsset.aspx?id=10737509476'),
  ('ETC', 'ColorSource Spot', null, '{1,3,5,6}',
     'https://www.etcconnect.com/WorkArea/DownloadAsset.aspx?id=10737509474'),
  ('ETC', 'ColorSource Spot Jr', null, '{1,3,5,6}',
     'https://www.etcconnect.com/WorkArea/DownloadAsset.aspx?id=10737510118'),
  ('ETC', 'Source Four Ellipsoidal', null, '{}',
     'https://www.etcconnect.com/Products/Entertainment-Fixtures/Source-Four/Source-Four/Documentation.aspx'),
  ('ETC', 'Hoglet 4', '61040064', '{}',
     'https://www.etcconnect.com/WorkArea/DownloadAsset.aspx?id=10737504332'),
  ('GrandMA Lighting', 'GrandMA3 Compact XT', '4010505', '{}',
     'https://www.malighting.com/product/-4010505/')
) as v(mfr, name, pn, modes, manual)
where lower(t.manufacturer) = lower(v.mfr) and lower(t.name) = lower(v.name);
