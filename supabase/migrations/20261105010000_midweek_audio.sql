-- Midweeks on PCO › Scheduling. The student midweeks at Simpsonville and Mauldin
-- run one front-of-house crew: Audio, CG and Lighting. Audio is left out of the app
-- everywhere else; a service marked show_audio keeps its audio op (the sync stores
-- them, the app shows them, and staff can schedule into them).

alter table public.pco_service_types
  add column if not exists show_audio boolean not null default false;

-- Share the two midweeks with everyone (like the Sunday services) and keep their audio op.
update public.pco_service_types
   set access = 'everyone', access_set = true, show_audio = true
 where name in ('Simpsonville Midweek', 'Mauldin Midweek');

-- Ask the next sync for a full read, so their plans and rosters come in now.
update public.pco_connection set refresh_wanted_at = now() where id = true;
