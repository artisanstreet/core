update sessions
set revoked_at = now()
where id = :id and account_id = :account_id and id <> :current_session_id and revoked_at is null
returning id
