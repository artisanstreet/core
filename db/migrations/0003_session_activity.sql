alter table sessions add column if not exists country_code text;
alter table sessions add column if not exists last_seen_at timestamptz;
