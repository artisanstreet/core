-- Delete expired or revoked-before sessions (janitor).
delete from sessions
where expires_at <= now() or (revoked_at is not null and revoked_at <= :before)
returning id
