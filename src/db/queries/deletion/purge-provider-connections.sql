-- Purge step: provider connections (cascades remaining assignments).
delete from provider_connections
where account_id = :account_id
returning id
