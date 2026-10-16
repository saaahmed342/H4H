create table if not exists h4h_store (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);
alter table h4h_store enable row level security;

-- Gallery photos: a public storage bucket for event pictures.
-- (The site tries to create this itself on startup, so you normally don't need this line.
--  Run it only if photo uploads say the "gallery" bucket is missing.)
insert into storage.buckets (id, name, public)
values ('gallery', 'gallery', true)
on conflict (id) do nothing;
