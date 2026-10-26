-- Tracking table for applied migrations (applied blind first by db-migrate).
create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);
