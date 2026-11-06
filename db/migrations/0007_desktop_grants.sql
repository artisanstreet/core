create table if not exists desktop_grants (
  code_hash text primary key,
  challenge text not null,
  account_id text not null references accounts (id) on delete cascade,
  totp_verified boolean not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  redeemed_at timestamptz
);

create index if not exists desktop_grants_expiry_idx on desktop_grants (expires_at);
