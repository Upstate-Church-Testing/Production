-- The Planning Center sync re-saves every production volunteer on each full pass (every
-- few minutes) just to move last_seen_at forward. Every one of those writes went out live
-- to every open app, which reloaded and redrew what was on screen (and scrolled open
-- panels back to the top). volunteers_upsert_from_pco already only moved last_seen_at
-- every 6 hours; this holds the sync's direct upserts to the same rule.
--
-- An update that changes nothing but last_seen_at (and the stamps), less than 6 hours
-- after the last one, is dropped. Anything staff change (lanyard, tags, notes, home
-- location) and any new name or photo from Planning Center still saves.

create or replace function public.volunteers_skip_noop()
returns trigger
language plpgsql
set search_path to ''
as $$
declare
  same_rest boolean := (to_jsonb(new) - array['last_seen_at', 'updated_at', 'updated_by'])
                     = (to_jsonb(old) - array['last_seen_at', 'updated_at', 'updated_by']);
begin
  if same_rest and old.last_seen_at is not null and new.last_seen_at is not null
     and new.last_seen_at < old.last_seen_at + interval '6 hours' then
    return null; -- nothing to save: no write, nothing sent to open apps
  end if;
  return new;
end
$$;

-- "0" so it runs before the lanyard and stamp triggers (which run in name order).
create trigger volunteers_0_skip_noop before update on public.volunteers
  for each row execute function public.volunteers_skip_noop();
