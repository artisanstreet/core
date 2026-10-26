-- Revoke an engine artifact (account-bound).
update engine_artifacts
set revoked_at = now()
where id = :id and account_id = :accountId and revoked_at is null
returning id
