-- Purge step: recovery codes.
delete from recovery_codes
where account_id = :account_id
returning id
