-- CG uploads: a campus can have more than one CG to upload (Simpsonville: CG1 in the Worship
-- Center, CG2 in A Control). station is '' for the campus's main CG, 'CG2'… for another one.
-- Which extra ones there are comes from Gear: a computer at CG2 (location CG2, or "(CG2)" in
-- its name) gets its own row (js/cg-rows.js).
alter table public.cg_uploads add column if not exists station text not null default '';
alter table public.cg_uploads add constraint cg_uploads_station_check check (station = '' or station ~ '^CG[2-9]$');
alter table public.cg_uploads drop constraint cg_uploads_pkey;
alter table public.cg_uploads add primary key (sunday, campus_id, station);
