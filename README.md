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
- **Volunteers** can sign in but see no equipment or network data. Service flows and
  training will be built for them later.
- **Admins** approve people, change roles and set each person's production teams.

## Data model

```
campuses ── rooms
    │
    ├── networks (subnet, VLAN, gateway, tags)
    │
    └── devices — one physical unit ("model" in the app): name, tags, serial, firmware, room, location, status
            ├── device_ips (IP + mask, gateway, MAC, network, label, static/DHCP)
            ├── device_ports (what's plugged into each of its type's ports, plus an assignment like "Universe 5")
            └── device_credentials (staff only, loaded one device at a time)

device_types     the shared catalog entry ("type" in the app): name, maker, part number, category, tags, specs, manual
    └── device_type_ports (the port layout every unit of that type shares)

departments      audio / video / lighting — the tag on every item
profiles         one per login: role, teams, home campus
activity         every change: who, when, old → new (passwords never copied)
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
js/views/gear.js               Types and Models (stacked by type), filtered by campus, tag and category
js/views/devices.js            the model panel and editor (shared by Network and Gear)
js/views/types.js              the type editor (shared by Gear and the model editor)
js/views/team.js               people and access
js/views/account.js            your profile, theme, sign out
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
