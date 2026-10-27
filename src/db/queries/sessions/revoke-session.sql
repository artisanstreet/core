-- Revoke one session by token hash.
update sessions
set revoked_at = now()
where token_hash = :token_hash and revoked_at is null
returning id, account_id
