-- Purge step: recovery codes.
delete from recovery_codes
where account_id = :accountId
returning id
