-- Purge step: machines (cascades assignments and config state).
delete from machines
where account_id = :account_id
returning id
