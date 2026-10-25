# Upstate Production

The Upstate Church production team's shared system. V1 is the **network / IP sheet**
for all 10 campuses. It is built so gear, schedules (Planning Center), training and
service flows can be added as new sections without reworking what's here.

## How it's built

| Piece | What it does |
| --- | --- |
| **Supabase** (Postgres) | Data, logins (email + password), live updates, permissions |
| **GitHub Pages** | Hosts the app. Every push to `main` goes live in about a minute |
| Plain HTML/CSS/JS modules | No build step. Works in any browser and installs to a phone home screen |

Both the Supabase URL and its publishable key are public by design. Nothing is
readable without a signed-in, approved account; every table is locked with
row-level security.

## Who sees what

Roles, lowest to highest: `pending` → `volunteer` → `contractor` → `staff` → `admin`.

- **The first account created becomes admin.** Everyone after starts as *pending* and
  sees nothing until an admin approves them on the Team screen.
- **Staff and admins** see the network sheet, device logins and change history.
- **Volunteers** see Services and Resi, but no equipment or network data.
  Service flows and training will be built for them later.
- **Staff** set up each campus's Resi player in Settings.
- **Admins** approve people, change roles and set each person's production teams.

## Planning Center (Services tab)

One church-wide connection, so nobody connects their own Planning Center account
and nobody's own Planning Center permissions matter here.

- An admin pastes a Planning Center **personal access token** once, in Settings ›
  Planning Center (make it from a shared production login that can see every
  service type). The `pco` edge function checks it with Planning Center and keeps
  the secret in Supabase Vault. The app can never read it back.
- **Live.** Every 30 seconds (pg_cron → the edge function) the server lists each shared
  service's upcoming plans. Planning Center bumps a plan's `updated_at` whenever anyone on
  it is scheduled, removed, accepts or declines, so only those plans' rosters are read
  again (each plan is also re-read hourly, just in case). When anything changed the sync
  touches `pco_live`, and every open app hears it over realtime and reloads within a
  second or two. A run with no changes is a handful of requests.
- On each run (pg_cron → the edge function) the server copies service types and
  their folders, teams, upcoming plans (6 weeks by default), and the rosters and open
  spots of the **shown teams** (Broadcast, FOH… an admin picks), and each service's
  flow (its items, lengths and Audio/Video/Lighting notes) into `pco_*` tables.
- Who sees a service is set per service in Settings: **Everyone** (volunteers and up),
  **Staff**, or **Off**. A campus's weekly services that have a production team start
  shared with everyone; everything else starts off. RLS enforces it. Audio positions
  are never copied (see People below).
- **Roster** (beside each shared service in Settings) says whether it's on Services ›
  Roster (`pco_service_types.on_roster`). Laurens, Union and Simpsonville's Traditional
  are off it; they stay in the Services list and My schedule.
- App accounts are matched to Planning Center people by email, so the Services tab can
  show "You're on 3 services" and a My schedule view.
- Scheduling people from the app goes through the same connection (next step), so what
  someone may do is decided by their role here, not by their Planning Center login.

## People (production volunteers)

Services › People (staff only) lists everyone on the production teams, whether or not
they have a login. Nobody signs in as these; they're records the staff keep.

- Planning Center fills it: everyone on the shown teams of shared services (read every
  six hours) and anyone who shows up on a roster. Staff can add people by hand too.
- Lanyards: Production Volunteer, Production Coach or Production Staff, one tap to give,
  switch or take back. When and by whom it was given is kept. "No lanyard" puts the
  people serving soonest first, so you know who to hand one to on Sunday.
- Tags and notes on each person. People added by hand can be renamed and removed.

**No audio.** The app covers front of house (CG, lighting) and broadcast, not audio.
A position whose name is only Audio or Sound ("Audio", "Audio A1") is left out of the
roster, the open spots and People; a shared one ("Audio / CG") stays. People who can
only fill audio positions (from Planning Center's position assignments, kept in
`pco_team_people.positions`) aren't listed. The rule is `hiddenPosition` in
`js/pco.js` and `supabase/functions/pco/sync.ts`.

## Lighting numbers

Every lighting fixture carries the numbers a lighting team works with:

| In the app | Column | What it is |
|---|---|---|
| Model # | `device_types.part_number` | The maker's exact model number (JOL299). Filled in only where it's confirmed for the exact product. |
| DMX modes | `device_types.dmx_modes`, `dmx_footprint` | The channel counts the model offers, and the one the team uses. |
| Serial | `devices.serial_number` | From the label on each unit. |
| Asset # | `devices.asset_no` | 1…N per model across every location. Permanent: a deleted unit's number is never reused (`asset_counters`). |
| Stage # | `devices.stage_no` | 1…N per model in one room. Moving a unit gives it the next number in its new room. |
| Fixture ID | `devices.fixture_id` | Its number on that room's console (grandMA3 Fixture ID, Eos channel, Hog fixture number), e.g. 401–424. |
| Patch | `devices.patch_universe`, `patch_address` | Typed as `1.333` (universe 1, address 333; `1/333` works too). Two numbers, so a universe can be counted across locations. |
| Channels | `devices.dmx_channels` | Only when one unit's mode differs from its model's. |

A patch belongs to the console in its room, so patch and fixture ID are per location +
room ("rig"), and moving a unit to another room clears them. The database checks that a
patch doesn't run past address 512; the app flags overlapping patches, repeated fixture
IDs and repeated stage numbers, and treats two fixtures on exactly the same addresses as
doubled on purpose. Gear › Patch is the patch sheet: one room at a time, universe by
universe (1–100), with a fill-in table, or one universe across every location.

## Data model

```
campuses ── rooms
    │
    ├── streams (a campus's Resi web player: embed id + type; status comes from Resi live)
    │
    ├── networks (subnet, VLAN, gateway, tags)
    │
    └── devices — one physical unit ("item" in the app): name, sections, serial, firmware, room, location, status,
            │         asset #, stage #, fixture ID, patch (universe + address), DMX channels
            ├── device_ips (IP + mask, gateway, MAC, network, label, static/DHCP)
            ├── device_ports (what's plugged into each of its type's ports, plus an assignment like "Universe 5")
            └── device_credentials (staff only, loaded one device at a time)

device_types     the shared catalog entry ("model" in the app): name, brand, model number, category, sections, specs, manual, photo, DMX modes
                 (photos live in the public gear-photos storage bucket: <path>.jpg plus a <path>-t.jpg thumbnail)
    └── device_type_ports (the port layout every unit of that type shares)

departments      audio / video / lighting / network — the section tag on every item
profiles         one per login: role, teams, home campus, matched Planning Center person
volunteers       everyone on the production teams (no login): Planning Center link, lanyard (+ when/by whom), tags, notes, home location
activity         every change: who, when, old → new (passwords never copied)

pco_connection   the one Planning Center connection (token secret in Vault; the app can't read this table)
pco_service_types ── pco_teams (shown or not; positions)
        │            who sees it: access = everyone | staff | hidden, and which location
        ├── pco_team_people (who's on each shown team; fills volunteers)
        └── pco_plans (upcoming: dates, times, open spots) ── pco_plan_people (shown teams only)
                                                          └─ pco_plan_items (the flow: songs, hosts, media, lengths, team notes)
```

Every production table carries `departments text[]`, checked against `departments`,
so anything added later (gear, cables, training videos) sorts by audio / video /
lighting the same way.

## Files

```
index.html                     app shell, home-screen metadata
styles.css                     the whole look, light and dark
js/config.js                   Supabase URL + publishable key (empty = preview mode)
js/app.js                      sign-in, roles, navigation, sheets, toasts
js/store-supabase.js           live data
js/store-demo.js               preview data (same methods, in memory)
js/views/network.js            the IP sheet
js/views/gear.js               Models, Items (every unit A–Z), Grid (models × locations or rooms, like the old lighting sheet) and Patch, filtered by location, section, category and brand
js/views/patch.js              Gear › Patch: each room's patch by universe, the numbers table with quick fill, one universe across locations
js/lighting.js                 patch parsing (1.333), footprints, overlap and duplicate checks
js/photo.js                    turns a picked photo into a white-background square (plus thumbnail)
js/views/devices.js            the item panel and editor (shared by Network and Gear)
js/views/types.js              the model editor (shared by Gear and the item editor)
js/views/team.js               people and access
js/views/stats.js              Statistics: gear and network numbers for one location or all of them
js/picker.js                   the filter dropdowns and their menus (location, section, category, brand…)
js/views/resi.js               Resi: what every campus's web player is showing
js/views/resi-settings.js      Settings › Resi players (paste a link, embed code or ID)
js/resi.js                     reads pasted players and asks Resi what's on
js/views/account.js            Settings: your profile, Planning Center, Resi players, theme, sign out
js/views/services.js           Services: pick a location, then a date, then the service (Vintage, Traditional, Modern…); its flow with run times and cues, times and production-team rosters; Roster (every location's positions × dates on one screen, one pill per person per day with a lettered dot per service, colored by their answer to every service that day); People; My schedule
js/views/volunteers.js         Services › People: production volunteers, lanyards, tags, notes, add someone by hand
js/views/pco-settings.js       Settings › Planning Center (connect, who sees which services, which teams show)
js/pco.js                      Planning Center helpers (times in the church's time zone, labels)
js/pco-demo.js                 made-up Planning Center data for the preview
supabase/functions/pco/        edge function: connect/disconnect/sync (index.ts), API client (pco.ts), sync (sync.ts), writes (db.ts)
supabase/migrations/*.sql      database, permissions, history
supabase/seed.sql              the 10 campuses, matched to Planning Center
tools/stamp.py                 run before each publish; open copies reload themselves
tools/build_preview.py         one-file preview with example data
```

## Adding a section

1. Add tables in a new migration with `departments text[]`, the `stamp` and
   `log_activity` triggers, and policies using `public.has_role('staff')` (or lower).
2. Add the methods to both stores.
3. Add `js/views/<name>.js` exporting `mount(el, ctx)` and register it in `MODULES`
   in `js/app.js` with the lowest role that should see it.

## Setting it up

1. Create a Supabase project. Run `supabase/migrations/…_foundation.sql`, then `supabase/seed.sql`.
2. In Supabase › Authentication › Sign In / Providers › Email, turn **Confirm email** off
   (admins approve people in the app instead). Set **Site URL** to the GitHub Pages address.
3. Put the project URL and publishable key in `js/config.js`.
4. Publish to GitHub Pages from `main`, root folder.
5. Open the site and create the first account. That account is the admin.
