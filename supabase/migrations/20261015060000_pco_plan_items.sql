-- The flow of each service: Planning Center's plan items (songs, headers, media, hosts…)
-- with their lengths and per-team notes. Anyone who can see the service can see its flow.
create table public.pco_plan_items (
  id           text primary key,
  plan_id      text not null references public.pco_plans (id) on delete cascade,
  sequence     int,
  title        text not null default '',
  kind         text,            -- header | song | media | item
  position     text,            -- pre | during | post
  length       int,             -- seconds
  description  text,
  key_name     text,
  arrangement  text,            -- the song's sequence, short form (V1 C V2…)
  notes        jsonb not null default '[]',   -- [{category, content}] e.g. Audio: CG
  synced_at    timestamptz not null default now()
);
create index pco_plan_items_plan_idx on public.pco_plan_items (plan_id, sequence);

alter table public.pco_plan_items enable row level security;
create policy "see the flow of shared services" on public.pco_plan_items
  for select to authenticated
  using (exists (select 1 from public.pco_plans p where p.id = plan_id));
grant select on public.pco_plan_items to authenticated;
