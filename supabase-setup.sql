-- Arabic Encyclopedia: synced progress table
-- Run this in Supabase SQL Editor.

create table if not exists public.progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id text not null,
  status text not null default 'Not Started'
    check (status in ('Not Started','Covered','Learning','Confident','Mastered')),
  favourite boolean not null default false,
  date_covered timestamptz,
  last_revised timestamptz,
  times_revised integer not null default 0,
  correct_count integer not null default 0,
  incorrect_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

alter table public.progress enable row level security;

revoke all on table public.progress from anon, authenticated;
grant select, insert, update, delete on table public.progress to authenticated;

drop policy if exists "Users can view own progress" on public.progress;
create policy "Users can view own progress"
on public.progress for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own progress" on public.progress;
create policy "Users can insert own progress"
on public.progress for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update own progress" on public.progress;
create policy "Users can update own progress"
on public.progress for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete own progress" on public.progress;
create policy "Users can delete own progress"
on public.progress for delete
to authenticated
using ((select auth.uid()) = user_id);
