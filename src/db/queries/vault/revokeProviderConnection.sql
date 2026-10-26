-- Revoke a provider connection (account-bound).
update provider_connections
set revoked_at = now()
where id = :id and account_id = :accountId and revoked_at is null
returning id
