-- Purge step: machines (cascades assignments and config state).
delete from machines
where account_id = :accountId
returning id
