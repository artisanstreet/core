-- Revoke every session of an account (logout-all / deletion).
update sessions
set revoked_at = now()
where account_id = :account_id and revoked_at is null
returning id
