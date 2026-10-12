-- Supabase queue table for Grok -> Vercel -> Mac FilmCraft worker jobs.
-- Run this in the Supabase SQL editor for the project used by the orchestrator.

create table if not exists public.filmcraft_edit_jobs (
  id text primary key,
  status text not null check (
    status in (
      'queued',
      'claimed',
      'downloading',
      'editing',
      'rendering',
      'uploading',
      'completed',
      'failed'
    )
  ),
  project_id text not null,
  title text not null,
  instructions text not null,
  sources jsonb not null default '[]'::jsonb,
  edit_plan jsonb not null default '{}'::jsonb,
  progress jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  claimed_by text,
  claimed_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists filmcraft_edit_jobs_status_created_idx
  on public.filmcraft_edit_jobs (status, created_at);

create index if not exists filmcraft_edit_jobs_project_created_idx
  on public.filmcraft_edit_jobs (project_id, created_at desc);

-- Keep this queue server-only. The Vercel orchestrator uses the Supabase service-role key;
-- browser clients should not read or write job prompts, source paths, local render paths, or errors.
alter table public.filmcraft_edit_jobs enable row level security;

revoke all on table public.filmcraft_edit_jobs from public;
revoke all on table public.filmcraft_edit_jobs from anon;
revoke all on table public.filmcraft_edit_jobs from authenticated;
grant all on table public.filmcraft_edit_jobs to service_role;
