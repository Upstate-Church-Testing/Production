-- =============================================================================
-- Item status: two more choices, so a pill can say how an item is doing.
--   active   In use          on a rig, working
--   spare    Ready           works fine, not in use (storage, spares)
--   check    Needs a check   something seems off
--   broken   Broken          doesn't work
--   repair   In repair       out being fixed
--   retired  Retired         gone for good
-- Haze bottles: just how many, not how full each one is.
-- =============================================================================

alter table public.devices drop constraint devices_status_check;
alter table public.devices add constraint devices_status_check
  check (status in ('active', 'spare', 'check', 'broken', 'repair', 'retired'));

alter table public.haze_stock rename column full_bottles to bottles;
alter table public.haze_stock rename constraint haze_stock_full_bottles_check to haze_stock_bottles_check;
comment on column public.haze_stock.opened_bottles is 'Not used: bottles are just counted, not how full they are.';
