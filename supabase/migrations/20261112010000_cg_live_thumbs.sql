-- CG Live: the picture of the slide that's live at each location (ProPresenter's own thumbnail
-- of it, a small JPEG, base64), sent by the listener on the CG Mac each time the slide changes.
-- Its own table so cg_live's once-a-minute "still here" doesn't push the picture out again.
create table if not exists public.cg_live_thumbs (
  campus_id uuid primary key references public.campuses(id) on delete cascade,
  presentation_uuid text,
  slide_index integer,
  jpeg text not null,
  req_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.cg_live_thumbs enable row level security;
create policy "staff see cg_live_thumbs" on public.cg_live_thumbs for select to authenticated using ((select public.has_role('staff')));
revoke all on public.cg_live_thumbs from anon, authenticated;
grant select on public.cg_live_thumbs to authenticated;
alter publication supabase_realtime add table public.cg_live_thumbs;
