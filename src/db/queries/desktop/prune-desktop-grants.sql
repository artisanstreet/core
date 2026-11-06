delete from desktop_grants
where expires_at < :before
returning code_hash
