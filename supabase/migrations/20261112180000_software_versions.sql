-- The versions to pick from on CG uploads' version pills: one row per released version of
-- macOS (product 'macOS') or of a software title (product = the title's name, as in
-- public.software: 'ProPresenter', 'Desktop Video'), with its build and release date where
-- known. Picking "Another version" on a pill adds the one typed here, so the list keeps up
-- by itself. Staff read and add.
create table if not exists public.software_versions (
  product text not null check (char_length(btrim(product)) between 1 and 80),
  version text not null check (char_length(btrim(version)) between 1 and 40),
  build text check (build is null or char_length(btrim(build)) between 1 and 60),
  released_on date,
  created_at timestamptz not null default now(),
  primary key (product, version)
);
alter table public.software_versions enable row level security;
create policy "staff see software versions" on public.software_versions for select to authenticated using ((select public.has_role('staff')));
create policy "staff add software versions" on public.software_versions for insert to authenticated with check ((select public.has_role('staff')));
revoke all on public.software_versions from anon, authenticated;
grant select, insert on public.software_versions to authenticated;
alter publication supabase_realtime add table public.software_versions;

-- As of Nov 12, 2026 (macOS from Apple's release history; ProPresenter from Renewed Vision's
-- download page; Desktop Video from Blackmagic's release notes, which give no dates).
insert into public.software_versions (product, version, build, released_on) values
  ('macOS', '27.0.1', null, '2026-09-28'), ('macOS', '27.0', null, '2026-09-14'),
  ('macOS', '26.7', null, '2026-09-14'), ('macOS', '26.6', null, '2026-07-27'),
  ('macOS', '26.5.2', null, '2026-06-29'), ('macOS', '26.5.1', null, '2026-06-01'), ('macOS', '26.5', null, '2026-05-11'),
  ('macOS', '26.4.1', null, '2026-04-09'), ('macOS', '26.4', null, '2026-03-24'),
  ('macOS', '26.3.2', null, '2026-03-10'), ('macOS', '26.3.1', null, '2026-03-04'), ('macOS', '26.3', null, '2026-02-11'),
  ('macOS', '26.2', null, '2025-12-12'), ('macOS', '26.1', null, '2025-11-03'),
  ('macOS', '26.0.1', null, '2025-09-29'), ('macOS', '26.0', null, '2025-09-15'), ('macOS', '15.6', null, null),
  ('ProPresenter', '22.0.1', null, '2026-11-12'), ('ProPresenter', '22', '369098928', '2026-11-05'),
  ('ProPresenter', '21.4', '352583705', '2026-07-01'), ('ProPresenter', '21.3', '352518178', '2026-03-18'),
  ('ProPresenter', '21.2', '352452646', '2026-02-03'), ('ProPresenter', '21.1', '352387082', '2025-12-09'),
  ('ProPresenter', '21.0.1', '352321797', null), ('ProPresenter', '21', '352321578', null),
  ('Desktop Video', '16.5', null, null), ('Desktop Video', '16.4', null, null), ('Desktop Video', '16.3', null, null),
  ('Desktop Video', '16.2', null, null), ('Desktop Video', '16.1', null, null), ('Desktop Video', '16.0.1', null, null),
  ('Desktop Video', '16.0', null, null), ('Desktop Video', '15.3.1', null, null), ('Desktop Video', '15.3', null, null),
  ('Desktop Video', '15.2', null, null), ('Desktop Video', '15.1', null, null), ('Desktop Video', '15.0', null, null),
  ('Desktop Video', '14.5', null, null), ('Desktop Video', '14.4.1', null, null), ('Desktop Video', '14.4', null, null),
  ('Desktop Video', '14.3', null, null)
on conflict do nothing;
