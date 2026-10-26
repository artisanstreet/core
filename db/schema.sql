-- AST Core schema (PostgreSQL 14+; local dev runs 18, production via Hyperdrive).
-- Plain Postgres only: no exotic extensions, no plpgsql. Application code
-- generates IDs (prefix_ULID). This file is the reproducible dev/test schema
-- for Reylo; db/migrations/*.sql carries the same statements for deploy.
--
-- Migration splitting rule: db-migrate splits files on `;` at line end, so
-- no statement may contain another line-ending semicolon.

create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

-- Accounts: one row per AST identity. Email is the verified login identity.
create table if not exists accounts (
  id text primary key,
  email text not null unique,
  display_name text not null default '',
  totp_secret_enc bytea,
  totp_pending_secret_enc bytea,
  totp_enrolled_at timestamptz,
  created_at timestamptz not null default now(),
  deletion_requested_at timestamptz,
  deleted_at timestamptz,
  check (email <> '')
);

-- Magic-link login requests. The email token approves; the request secret
-- (held by the originating session) completes. Email alone never mints.
create table if not exists login_requests (
  id text primary key,
  email text not null,
  request_secret_hash text not null,
  email_token_hash text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'email_approved', 'completed', 'expired')),
  totp_required boolean not null default false,
  requester_ip text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  email_approved_at timestamptz,
  completed_at timestamptz
);
create index if not exists login_requests_email_idx on login_requests (email, created_at desc);

-- Persistent revocable sessions. Token hashes only; raw tokens never stored.
create table if not exists sessions (
  id text primary key,
  account_id text not null references accounts (id),
  token_hash text not null unique,
  device_name text not null default '',
  ip text,
  user_agent text,
  totp_verified_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists sessions_account_idx on sessions (account_id, created_at desc);

-- TOTP recovery codes (single use, hashed).
create table if not exists recovery_codes (
  id text primary key,
  account_id text not null references accounts (id) on delete cascade,
  code_hash text not null unique,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
create index if not exists recovery_codes_account_idx on recovery_codes (account_id);

-- Consumed TOTP time-steps: durable single-use per account. A code that
-- verifies is claimed for its exact step; a replay of the same code in the
-- same window finds the row taken and fails. Pruned by the janitor.
create table if not exists totp_used_steps (
  account_id text not null references accounts (id) on delete cascade,
  step bigint not null,
  created_at timestamptz not null default now(),
  primary key (account_id, step)
);

-- Forge machine enrollments (pending codes, short TTL, hashed).
create table if not exists enrollments (
  id text primary key,
  public_key_x text not null,
  label text not null default '',
  code_hash text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'confirmed', 'expired', 'voided')),
  account_id text references accounts (id),
  email text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  confirmed_at timestamptz,
  machine_id text
);

-- Enrolled Forge machines (into accounts, not per Editor).
create table if not exists machines (
  id text primary key,
  account_id text not null references accounts (id),
  public_key_x text not null,
  label text not null default '',
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_seen_at timestamptz
);
create index if not exists machines_account_idx on machines (account_id);
create unique index if not exists machines_account_key_idx on machines (account_id, public_key_x);

-- Durable replay protection: one row per (subject, nonce), unique.
-- Subjects are machine ids (mch_...) and enrollment ids (enr_...).
create table if not exists machine_nonces (
  subject text not null,
  nonce text not null,
  created_at timestamptz not null default now(),
  primary key (subject, nonce)
);

-- DB-backed rate counters (per account / IP / global budgets).
create table if not exists rate_counters (
  key text not null,
  bucket_start timestamptz not null,
  count integer not null default 0,
  primary key (key, bucket_start)
);

-- Grant signing keys (Ed25519). Private seed encrypted with master key.
create table if not exists grant_keys (
  kid text primary key,
  public_x text not null,
  private_seed_enc bytea not null,
  created_at timestamptz not null default now(),
  retired_at timestamptz
);

-- Provider credentials (vault): API keys encrypted at rest, released only
-- to assigned machines of the same account. Supported providers are
-- API-key integrations only (no subscription OAuth, no invented flows).
create table if not exists provider_connections (
  id text primary key,
  account_id text not null references accounts (id),
  provider text not null
    check (provider in ('anthropic', 'openai', 'openrouter', 'google')),
  label text not null default '',
  secret_enc bytea not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists provider_connections_account_idx
  on provider_connections (account_id);

-- Assignment of provider connections to machines. Account binding is enforced
-- in the mutation queries (connection and machine must both belong to the
-- caller's account); foreign keys alone do not prove that.
create table if not exists machine_assignments (
  connection_id text not null references provider_connections (id) on delete cascade,
  machine_id text not null references machines (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (connection_id, machine_id)
);

-- Versioned Editor MCP/skill configuration bundles.
-- Identical content in two accounts stays two independent rows: uniqueness
-- is per account, never global, so one account's save cannot collide with
-- another's and revisions are never deduped away.
create table if not exists config_bundles (
  id text primary key,
  account_id text not null references accounts (id),
  version integer not null,
  content_hash text not null,
  r2_key text not null,
  manifest jsonb not null,
  created_at timestamptz not null default now(),
  unique (account_id, version),
  unique (account_id, content_hash)
);

-- Applied-revision reports from machines.
create table if not exists machine_config_state (
  machine_id text not null references machines (id) on delete cascade,
  bundle_id text not null references config_bundles (id),
  status text not null default 'applied'
    check (status in ('applied', 'failed')),
  detail text not null default '',
  applied_at timestamptz not null default now(),
  primary key (machine_id)
);

-- Engine credential artifacts: opaque envelopes exported by Forge AFTER the
-- user completed the harness's OWN local login (Claude/Codex/OpenCode
-- subscription or key flows). Core performs NO OAuth: it validates the
-- envelope shape, encrypts the envelope at rest, and releases it only to
-- assigned machines of the same account, where Forge imports the files.
-- Inner file bytes are opaque to Core (never parsed, never logged).
create table if not exists engine_artifacts (
  id text primary key,
  account_id text not null references accounts (id),
  engine text not null
    check (engine in ('claude', 'codex', 'opencode')),
  kind text not null
    check (kind in ('oauth', 'api_key')),
  label text not null default '',
  format_version text not null default 'ast-engine-credential/1',
  envelope_enc bytea not null,
  exported_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists engine_artifacts_account_idx
  on engine_artifacts (account_id);

-- Assignment of engine artifacts to machines. Account binding is enforced
-- in the mutation queries (both ends must belong to the caller's account);
-- foreign keys alone do not prove that.
create table if not exists engine_artifact_assignments (
  artifact_id text not null references engine_artifacts (id) on delete cascade,
  machine_id text not null references machines (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (artifact_id, machine_id)
);

-- Append-only activity log.
create table if not exists activity_events (
  id text primary key,
  account_id text not null references accounts (id),
  machine_id text references machines (id),
  kind text not null,
  detail jsonb not null default '{}',
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists activity_account_idx on activity_events (account_id, created_at desc);

-- Account deletion lifecycle.
create table if not exists deletion_requests (
  account_id text primary key references accounts (id),
  status text not null default 'pending'
    check (status in ('pending', 'cancelled', 'done')),
  requested_at timestamptz not null default now(),
  purge_after timestamptz not null,
  completed_at timestamptz
);
