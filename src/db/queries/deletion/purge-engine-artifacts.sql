-- Purge step: engine artifacts (cascades remaining assignments).
delete from engine_artifacts
where account_id = :account_id
returning id
