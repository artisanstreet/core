alter table accounts add column if not exists avatar_url text;

create table if not exists sign_in_methods (
  account_id text not null references accounts (id) on delete cascade,
  kind text not null check (kind in ('email', 'google', 'github')),
  subject text not null,
  created_at timestamptz not null default now(),
  primary key (account_id, kind),
  unique (kind, subject),
  check (subject <> '')
);

insert into sign_in_methods (account_id, kind, subject)
select id, 'email', email from accounts
where not exists (select 1 from sign_in_methods where account_id = accounts.id)
on conflict do nothing;

create table if not exists oauth_flows (
  id text primary key,
  provider text not null check (provider in ('google', 'github')),
  intent text not null check (intent in ('sign_in', 'link')),
  account_id text references accounts (id) on delete cascade,
  state_hash text not null unique,
  flow_secret_hash text not null,
  verifier_enc bytea not null,
  redirect_uri text not null,
  status text not null default 'started'
    check (status in ('started', 'exchanged', 'awaiting_second_factor', 'signup_pending', 'completed')),
  subject text,
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (intent = 'sign_in' or account_id is not null)
);

create index if not exists oauth_flows_expiry_idx on oauth_flows (expires_at);
