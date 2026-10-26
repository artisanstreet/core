-- Fetch one provider connection, account-bound (never across accounts).
select id, account_id, provider, label, secret_enc, created_at, revoked_at
from provider_connections
where id = :id and account_id = :accountId
