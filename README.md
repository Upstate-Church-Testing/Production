# Tally

Tally is the Upstate Church production team's one app: services, rosters and
scheduling from Planning Center, the volunteer list and lanyards, gear and lighting
numbers, the network / IP sheet for all 10 campuses, and what every Resi player is
showing. New sections slot in without reworking what's here.

## How it's built

| Piece | What it does |
| --- | --- |
| **Supabase** (Postgres) | Data, logins (email + password), live updates, permissions |
| **Netlify** | Hosts the app at https://tally-upstate.netlify.app (church Netlify account). `netlify.toml` publishes only the app files. The old GitHub Pages address forwards there |
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

## Meetings (staff)

Any meeting (a production meeting, Christmas planning, a walk-through): a name, a day
and time, and optionally a location. Each one is two columns, built to stay open on an
iPad during the meeting:

- **Questions & answers.** Type a question (and who has the answer, if you know). It
  stays open, showing how long it's been waiting (red after 3 days). Answer it with
  what was said, who said it, when, and where (this meeting, a text, an email); names
  and places you've used before are one tap. Once answered it folds to one line: the
  answer in bold, "Student pastor · 10:06 AM · answered in 1h 6m". Tap it for the
  history, **New answer** when it changes ("changed 1×"), or **Reopen**.
- **Notes.** Type and press Return; each note keeps its time and who wrote it.

Everything updates live on every open screen. Tables: `meetings`, `meeting_notes`,
`meeting_questions`, `meeting_answers` (answering closes a question in the database).

## Scheduling from the roster (staff)

Tap an **Open** spot on Services › Roster. The sheet asks Planning Center, live, about
everyone on that team for that day:

- who's set up for that position (and their schedule preference),
- blockouts that cover the service (red), or later that day (noted),
- anything they declined that day, and anything else they're already on (amber),
- how many other days they're on the roster in the coming weeks.

They're grouped Available / Check first / Can't that day / Rest of the team. Pick
someone and Schedule; anyone flagged takes a second tap ("Schedule anyway"). If the
spot is open on more than one service that day (Vintage and Modern), they go on each
one you leave checked.

**The invite isn't sent from the app.** People are added exactly as Planning Center's
own scheduling adds them: unconfirmed, with the invite email *prepared* (the ✉️ in
Planning Center), not sent. Planning Center's API has no way to send it (an open
request, planningcenter/developers #1500), so the sheet links to the plan in Planning
Center, where you tap the ✉️, keep Email checked and hit Send. Until then the roster
shows ✉️ on their pill, and the pill's sheet links to the plan and offers **Take off**
(only while the invite hasn't gone out; after that, remove them in Planning Center so
they're told).

Changes go through the church-wide token, so Planning Center shows its owner as the
scheduler; `pco_schedule_log` keeps who in the app did it. The roster re-reads the plan
right away, and every open app gets the change over realtime.

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

## Rigging (Lighting › Rigging)

A room's hanging positions, front of the room first: FOH Batten, Midstage Batten
Center 1…, Upstage Batten Right. Each position lists what's mounted on it by model, one
chip per light with its fixture ID over its patch (tap one to open it), and what in the
room isn't on a position yet.

- **Hang lights** on a position: check every light on it. A light on another position
  moves here; unchecking takes it down. "Show all gear" lists more than lights, for a
  speaker or camera on a batten.
- **Edit positions**: add, rename, add notes (trim height, circuits), move toward the
  front or back, delete. Deleting a position leaves its lights in the room, not on a position.
- An item's editor has **Hung on** when its room has positions. Moving an item to
  another room takes it down (the database does this, like it clears the patch).

Harrison Bridge Worship Center: FOH Batten (the nine ColorSource Spots), Midstage Batten
Center 1–3, Midstage Batten Left and Right, Upstage Batten Center, Left and Right.

## Gear: where things are, and what's missing (staff)

Gear filters run Department → Location → Room → Spot → Position → Category → Used as → Brand,
each narrowing the ones after it. Department (Audio, Video, Lighting, Network; called
"section" before) comes first because most people look in their own: pick Audio and
Location, Room and Category only offer what audio has. "Lighting, North Auditorium,
Hazer" or "Lighting, Simpsonville, Lighting Storage, Fixture" is a few taps each. Picking a room with all locations showing picks that room everywhere (every
"Worship Center"). With one location picked, every room there is listed, even an empty one.

- **Spot** is where in the room: FOH rack, Stage rack, CG, House left… (the item's "Spot in
  the room"). It shows once a location or room is picked: Five Forks › Worship Center ›
  FOH rack is just what's in that rack. With All locations and a room picked, "FOH rack"
  is every Worship Center's FOH rack. Spots match regardless of capitals; "No spot" lists
  what doesn't have one.
- **Position** is what an item makes possible: CG, Director, Switcher, Audio, Lighting,
  Camera… An item can be in more than one. Position CG shows everything behind CG at every
  location: the Mac minis, their screens, keyboards, UltraStudios, Stream Decks and the
  stage displays. Add Category Computer and it's every CG Mac mini; leave Position on All
  and it's every Mac mini, CG or not. "No position" lists what isn't tagged yet.
- **Used as** is what this one is within its kind: a Display used as a Stage display,
  Computer monitor, Confidence monitor or LED wall. It shows once something in the list
  has one. Position CG + Category Display + Used as Stage display = every CG stage display.
- Search finds both, so "cg stage display" works too. In the item editor they're chips
  under Departments; a new one is typed in once and then offered everywhere, spelled the same.

- **By location**: with All locations showing, Items is split into a block per location
  (in the Location list's order), A–Z inside each, so any filter (all encoders, say) reads
  Anderson, Five Forks, Harrison Bridge, Simpsonville… With one location picked it's one
  A–Z list. Models stays grouped by category, never split by location: a model is one
  entry with all its items, wherever they are.
- **Status** is a colored pill on every item; tap it to change: In use, Ready (works,
  not in use), Needs update (works, needs an upgrade or software update), Needs a check,
  Broken, In repair, Retired.
- **Model unknown.** When you know something is there but not what model it is, pick
  "Don't know the model yet…" and say what kind of thing it is (Projector, Display…).
  It goes in on a placeholder model and Gear keeps saying "3 items still need a model"
  until each one is switched to its real model.
- **Haze**: every hazer with its tank level (from the last check), when it was filled,
  its patch and the fluid it takes, plus the bottles of each fluid at each location.
  Hazers are lighting items in the "Hazer" category: they keep a patch but don't show
  under "Fixture".
- **Cameras**: each location's camera positions (Cam 1…N), in service or out of
  commission, with the gear on each one (any item whose Spot is "Cam 3").
- **Systems** (Logistics › Systems): gear that works together wherever it sits, like the Clear-Com intercom
  (main station in Broadcast, packs on every camera), each piece with what it does.

## Cables (staff)

Cables aren't tracked one by one. A **type** is a signal and two ends (DMX · XLR 5-pin
male → XLR 5-pin female, shown as "DMX 5-pin"); under it, each row is one length and
label at one place with a count (25 ft · Elite Core blue · ×6 · Simpsonville, Lighting
Storage). **Types** shows every kind with its lengths and a total; **Cables** lists every
row with + and −. Search the way you'd say it: "5-pin 25", "3-pin to 5-pin" (order
matters), "powercon 10", "purple".

## Data model

```
campuses ── rooms (a room can be part of a group: rooms.group_id, like E-Wing Offices)
    │
    ├── streams (a campus's Resi web player: embed id + type; status comes from Resi live)
    │
    ├── networks (subnet, VLAN, gateway, tags)
    │
    └── devices — one physical unit ("item" in the app): name, sections, serial, firmware, room, location, status,
            │         asset #, stage #, fixture ID, patch (universe + address), DMX channels, projection (front or rear, projectors only),
            │         position_id (the batten or truss it hangs on; same room only, cleared when it moves rooms),
            │         positions (what it makes possible: CG, Director, Audio…; several allowed), used_as (Stage display, Computer monitor…)
            ├── device_ips (IP + mask, gateway, MAC, network, label, static/DHCP)
            ├── device_ports (what's plugged into each of its type's ports, plus an assignment like "Universe 5")
            └── device_credentials (staff only, loaded one device at a time)

device_types     the shared catalog entry ("model" in the app): name, brand, model number, category, sections, specs, manual, photo, DMX modes,
                 unknown (a placeholder until the model is known), haze fluid and tank size (hazers)
                 (photos live in the public gear-photos storage bucket: <path>.jpg plus a <path>-t.jpg thumbnail)
    └── device_type_ports (the port layout every unit of that type shares)

departments      audio / video / lighting / network — the section tag on every item
profiles         one per login: role, teams, home campus, matched Planning Center person
volunteers       everyone on the production teams (no login): Planning Center link, lanyard (+ when/by whom), tags, notes, home location
activity         every change: who, when, old → new (passwords never copied); actor_name = "Claude" for Claude's changes

pco_connection   the one Planning Center connection (token secret in Vault; the app can't read this table)
pco_service_types ── pco_teams (shown or not; positions)
        │            who sees it: access = everyone | staff | hidden, and which location
        ├── pco_team_people (who's on each shown team; fills volunteers)
        └── pco_plans (upcoming: dates, times, open spots, Planning Center version) ── pco_plan_people (shown teams only; invite sent or not)
                                                          └─ pco_plan_items (the flow: songs, hosts, media, lengths, team notes)
pco_live         one row the sync touches when anything changed (apps listen over realtime)

rig_positions    a room's hanging positions (FOH Batten, Upstage Truss…): name, notes, sort_order front to back
camera_builds    a location's camera positions (Cam N), in service or not; their gear is items with Spot "Cam N"
systems ── system_items   gear that works together (an intercom), each member with its role
haze_fluids ── haze_stock (bottles per location)     haze_checks (each look at a hazer's tank: level, filled, when)
cable_types ── cables     a kind of cable (signal + ends) and how many of each length and label at each place
pco_schedule_log who in the app scheduled or took off whom (staff only)
```

Every production table carries `departments text[]`, checked against `departments`,
so anything added later (gear, cables, training videos) sorts by audio / video /
lighting the same way.

## Files

```
index.html                     app shell, home-screen metadata
styles.css                     the whole look, light and dark
js/config.js                   Supabase URL + publishable key (empty = preview mode)
js/app.js                      sign-in, roles, the sidebar (NAV) and pages, sheets, toasts
js/store-supabase.js           live data
js/store-demo.js               preview data (same methods, in memory)
js/views/network.js            the IP sheet
js/views/gear.js               Models and Items (every unit A–Z), plus the one-tab pages built on it: Fixtures, Patch, Rigging, Hazers, Cameras, Systems; filtered by department, location, room, spot, position, category, used as and brand. Grid (models × locations or rooms) is built but not offered for now
js/views/haze.js               Gear › Haze: hazers, tank checks, fluid bottles per location
js/views/cameras.js            Gear › Cameras: camera positions and the gear on each
js/views/systems.js            Logistics › Systems: gear that works together, with roles
js/views/cables.js             Cables: types by their ends, every length and label with a count
js/views/patch.js              Gear › Patch: each room's patch by universe, the numbers table with quick fill, one universe across locations
js/views/rigging.js            Lighting › Rigging: each room's positions front to back, what hangs on each, hang and edit sheets
js/lighting.js                 patch parsing (1.333), footprints, overlap and duplicate checks
js/photo.js                    turns a picked photo into a white-background square (plus thumbnail)
js/views/devices.js            the item panel and editor (shared by Network and Gear)
js/views/types.js              the model editor (shared by Gear and the item editor)
js/views/team.js               people and access
js/views/stats.js              Statistics: gear and network numbers for one location or all of them
js/picker.js                   the filter dropdowns and their menus (location, section, category, brand…), and the phone Filters page
js/rooms.js                    room groups: the Room filter's entries, matching, the grouped room picker
js/views/resi.js               Resi: what every campus's web player is showing
js/views/resi-settings.js      Settings › Resi players (paste a link, embed code or ID)
js/resi.js                     reads pasted players and asks Resi what's on
js/views/account.js            Settings: your profile, Planning Center, Resi players, theme, sign out
js/views/services.js           Services: pick a location, then a date, then the service (Vintage, Traditional, Modern…); its flow with run times and cues, times and production-team rosters; Roster (every location's positions × dates on one screen, one pill per person per day with a lettered dot per service, colored by their answer to every service that day); People; My schedule
js/views/volunteers.js         Services › People: production volunteers, lanyards, tags, notes, add someone by hand
js/views/schedule-sheet.js     Roster › Open: who could fill the spot (blockouts, declines, other spots that day), schedule, send-invite handoff, undo
js/views/meetings.js            Meetings: any meeting, questions & answers (who, when, where; history), notes
js/views/pco-settings.js       Settings › Planning Center (connect, who sees which services, which teams show)
js/pco.js                      Planning Center helpers (times in the church's time zone, labels)
js/pco-demo.js                 made-up Planning Center data for the preview
supabase/functions/pco/        edge function: connect/disconnect/sync/candidates/schedule/unschedule (index.ts), API client (pco.ts), sync (sync.ts), scheduling (schedule.ts), database (db.ts)
supabase/migrations/*.sql      database, permissions, history
supabase/seed.sql              the 10 campuses, matched to Planning Center
tools/stamp.py                 run before each publish; open copies reload themselves
tools/build_preview.py         one-file preview with example data
```

## Changes Claude makes

Claude edits the live database directly, without signing in, so a change has no
person on it. Every SQL call Claude runs starts with

```sql
select set_config('app.actor', 'Claude', true);
```

which lasts for that one call. History then says **Claude** (`activity.actor_name`),
and items and models say "Added by Claude" / "edited by Claude"
(`created_by_name`, `updated_by_name`). A change with no signed-in person and no
marker still says "Someone"; nothing is guessed. Everything with no name from
Oct 14 to Nov 3, 2026 was Claude's and is marked that way.

## Adding a section

1. Add tables in a new migration with `departments text[]`, the `stamp` and
   `log_activity` triggers, and policies using `public.has_role('staff')` (or lower).
2. Add the methods to both stores.
3. Add `js/views/<name>.js` exporting `mount(el, ctx)` and add it to `NAV` in
   `js/app.js` (as a group, or under one) with the lowest role that should see it.

## Sidebar

`NAV` in `js/app.js`: All gear (Cables), Audio, Video (Cameras), Lighting (Fixtures,
Hazers, Patch, Rigging), Network (IP sheet) and Logistics (Services, Meetings, Resi, Statistics, Systems, Team),
with Settings at the bottom. On a computer it's a rail of icons that opens while the
mouse is over it; on an iPad the first tap opens it. On phones and small iPads (under
860px) it's hidden: Tally at the top left slides it in as a panel, and picking a page
or tapping beside it slides it away. Audio, Video, Lighting, Fixtures and the rest are the
Gear view opened with a `scope`: the department (and category) it's locked to and its tabs.
All gear and the department pages have two tabs, Models and Items.

**Filters on phones** (under 700px): Gear, Network and Cables show one **Filters** button
beside the search instead of the row of dropdowns. It opens a full page with the view
tabs (Models | Items) on one row and each filter as a pill showing its choice;
tap a pill to open its choices as a list (one choice per row, the current one checked,
one pill open at a time), and picking one closes it again. Each
filter only offers what fits the ones above it: pick Simpsonville and Room lists
Simpsonville's rooms; leave All locations and pick Worship Center to get every location's
Worship Center. **Show N items** goes back to the list. The Tally bar and the search + Filters bar stay at the top while you scroll
(`wireFilterButton` in `js/picker.js`).

## Room groups

A room can be part of a bigger area at the same location (`rooms.group_id`, one level):
at Simpsonville, **E-Wing Offices** holds Production Storage and Luken's Office. Most
rooms aren't part of anything. In the Room filter a group is one entry: pick it for
everything in it, or open it for one room. The item editor lists a group's rooms under
it, and "New room…" has a **Part of** choice. Helpers are in `js/rooms.js`.

## Setting it up

1. Create a Supabase project. Run `supabase/migrations/…_foundation.sql`, then `supabase/seed.sql`.
2. In Supabase › Authentication › Sign In / Providers › Email, turn **Confirm email** off
   (admins approve people in the app instead). Set **Site URL** to the Netlify address.
3. Put the project URL and publishable key in `js/config.js`.
4. Deploy the repo to Netlify (`netlify.toml` copies the app into `dist/`; no build tools needed).
5. Open the site and create the first account. That account is the admin.

## Asset numbers and fixtures

Every item has its own asset # across all of Upstate Church Production, shown as
UCP-000001 (up to UCP-999999). The database hands out the next one from a counter
(`devices_asset_seq`), so a number is never shared or reused, and it stays with the item
when it moves or its model is corrected. A fixture (category "Fixture") has no name of its
own: it goes by its model's name and the asset # tells them apart. Lighting › Fixtures is
the sheet of every light: brand, model, status, location, room, fixture ID, patch ID, asset #.
