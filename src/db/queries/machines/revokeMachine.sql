-- Revoke a machine (account-bound: only a machine of this account).
update machines
set revoked_at = now()
where id = :id and account_id = :accountId and revoked_at is null
returning id
