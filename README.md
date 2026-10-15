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
- Every 15 minutes (pg_cron → the edge function) the server copies service types and
  their folders, teams, upcoming plans (6 weeks by default), and the rosters and open
  spots of the **shown teams** (Broadcast, FOH… an admin picks) into `pco_*` tables.
- Who sees a service is set per service in Settings: **Everyone** (volunteers and up),
  **Staff**, or **Off**. A campus's weekly services that have a production team start
  shared with everyone; everything else starts off. RLS enforces it.
- App accounts are matched to Planning Center people by email, so the Services tab can
  show "You're on 3 services" and a My schedule view.
- Scheduling people from the app goes through the same connection (next step), so what
  someone may do is decided by their role here, not by their Planning Center login.

## Data model

```
campuses ── rooms
    │
    ├── streams (a campus's Resi web player: embed id + type; status comes from Resi live)
    │
    ├── networks (subnet, VLAN, gateway, tags)
    │
    └── devices — one physical unit ("item" in the app): name, sections, serial, firmware, room, location, status
            ├── device_ips (IP + mask, gateway, MAC, network, label, static/DHCP)
            ├── device_ports (what's plugged into each of its type's ports, plus an assignment like "Universe 5")
            └── device_credentials (staff only, loaded one device at a time)

device_types     the shared catalog entry ("model" in the app): name, brand, part number, category, sections, specs, manual, photo
                 (photos live in the public gear-photos storage bucket: <path>.jpg plus a <path>-t.jpg thumbnail)
    └── device_type_ports (the port layout every unit of that type shares)

departments      audio / video / lighting / network — the section tag on every item
profiles         one per login: role, teams, home campus, matched Planning Center person
activity         every change: who, when, old → new (passwords never copied)

pco_connection   the one Planning Center connection (token secret in Vault; the app can't read this table)
pco_service_types ── pco_teams (shown or not; positions)
        │            who sees it: access = everyone | staff | hidden, and which location
        └── pco_plans (upcoming: dates, times, open spots) ── pco_plan_people (shown teams only)
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
js/views/gear.js               Models, Items (every unit A–Z) and Grid (models × locations or rooms, like the old lighting sheet), filtered by location, section, category and brand
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
js/views/services.js           Services: upcoming plans by day with production-team rosters; My schedule
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
