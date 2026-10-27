-- List an account's engine artifacts (metadata only; envelopes never listed).
select id, engine, kind, label, format_version, exported_at, created_at, revoked_at
from engine_artifacts
where account_id = :account_id
order by created_at desc
