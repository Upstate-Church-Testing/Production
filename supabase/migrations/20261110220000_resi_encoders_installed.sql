-- Resi › Studio: whether an encoder is installed. One that isn't yet (Fountain Inn's: Resi has
-- it, it isn't in the building) shows on the board, but its location isn't checked for services
-- without a Resi event. (resi_schedules.service_time is no longer used: the service times come
-- from Planning Center. Left in place so a screen still on the last version can save.)
alter table public.resi_encoders add column if not exists installed boolean not null default true;
update public.resi_encoders e set installed = false from public.campuses c where c.id = e.campus_id and c.code = 'FI';
