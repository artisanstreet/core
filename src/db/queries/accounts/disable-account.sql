update accounts set disabled_at = now()
where id = :id and deleted_at is null and disabled_at is null
  and exists (select 1 from sessions where id = :session_id and account_id = accounts.id and revoked_at is null and expires_at > now())
returning id
