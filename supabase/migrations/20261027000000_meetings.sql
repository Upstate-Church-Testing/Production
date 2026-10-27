-- =============================================================================
-- Meetings (staff): any meeting, with notes and questions & answers.
--
--   meetings           title, when, where (optional location)
--   meeting_notes      what was said, one note at a time
--   meeting_questions  a question, when it was asked, who has the answer, open or not
--   meeting_answers    each answer: what, who said it, when, where it came from
--                      ("Production meeting", a text). Answering closes the
--                      question; a later answer means it changed; reopening
--                      keeps the history.
-- Staff only: volunteers never see meetings.
-- =============================================================================

create table public.meetings (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(trim(title)) between 1 and 200),
  starts_at   timestamptz not null default now(),
  campus_id   uuid references public.campuses (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete set null,
  updated_by  uuid references public.profiles (id) on delete set null
);
create index meetings_starts_idx on public.meetings (starts_at desc);

create table public.meeting_notes (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references public.meetings (id) on delete cascade,
  body        text not null check (length(trim(body)) between 1 and 5000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete set null,
  updated_by  uuid references public.profiles (id) on delete set null
);
create index meeting_notes_meeting_idx on public.meeting_notes (meeting_id, created_at);

create table public.meeting_questions (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references public.meetings (id) on delete cascade,
  body        text not null check (length(trim(body)) between 1 and 1000),
  asked_at    timestamptz not null default now(),
  waiting_on  text check (waiting_on is null or length(waiting_on) <= 80),
  open        boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete set null,
  updated_by  uuid references public.profiles (id) on delete set null
);
create index meeting_questions_meeting_idx on public.meeting_questions (meeting_id, asked_at);

create table public.meeting_answers (
  id           uuid primary key default gen_random_uuid(),
  question_id  uuid not null references public.meeting_questions (id) on delete cascade,
  body         text not null check (length(trim(body)) between 1 and 2000),
  who          text check (who is null or length(who) <= 80),
  answered_at  timestamptz not null default now(),
  via          text check (via is null or length(via) <= 80),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references public.profiles (id) on delete set null,
  updated_by   uuid references public.profiles (id) on delete set null
);
create index meeting_answers_question_idx on public.meeting_answers (question_id, answered_at);

-- Who and when, on every row.
create trigger meetings_stamp before insert or update on public.meetings for each row execute function public.stamp();
create trigger meeting_notes_stamp before insert or update on public.meeting_notes for each row execute function public.stamp();
create trigger meeting_questions_stamp before insert or update on public.meeting_questions for each row execute function public.stamp();
create trigger meeting_answers_stamp before insert or update on public.meeting_answers for each row execute function public.stamp();

-- An answer closes its question.
create function public.meeting_answer_closes()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  update public.meeting_questions set open = false where id = new.question_id and open;
  return null;
end
$$;
create trigger meeting_answers_close after insert on public.meeting_answers
  for each row execute function public.meeting_answer_closes();

-- Staff only.
alter table public.meetings enable row level security;
alter table public.meeting_notes enable row level security;
alter table public.meeting_questions enable row level security;
alter table public.meeting_answers enable row level security;
do $$
declare t text;
begin
  foreach t in array array['meetings', 'meeting_notes', 'meeting_questions', 'meeting_answers'] loop
    execute format('create policy "staff see %1$s" on public.%1$I for select using ((select public.has_role(''staff'')))', t);
    execute format('create policy "staff add %1$s" on public.%1$I for insert with check ((select public.has_role(''staff'')))', t);
    execute format('create policy "staff edit %1$s" on public.%1$I for update using ((select public.has_role(''staff''))) with check ((select public.has_role(''staff'')))', t);
    execute format('create policy "staff remove %1$s" on public.%1$I for delete using ((select public.has_role(''staff'')))', t);
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
