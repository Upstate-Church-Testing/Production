-- Lighting › Haze: how dense each hazer is run, as a percent (0-100). Typed in on the Haze
-- page next to the hazer; empty until someone sets it. On the item itself (a hazer is an
-- ordinary lighting item in the "Hazer" category), so it's stamped and pushed live with it.
alter table public.devices
  add column if not exists haze_density smallint check (haze_density is null or haze_density between 0 and 100);
