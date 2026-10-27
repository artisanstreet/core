-- List an account's provider connections (metadata only; no secrets).
select id, provider, label, created_at, revoked_at
from provider_connections
where account_id = :account_id
order by created_at desc
