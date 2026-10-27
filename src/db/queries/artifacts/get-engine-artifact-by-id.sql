-- Fetch one artifact's metadata (no envelope) for its owning account.
select id, engine, kind, label, format_version, exported_at, created_at, revoked_at
from engine_artifacts
where id = :id and account_id = :account_id
