-- Purge step: config bundles of the account.
delete from config_bundles
where account_id = :accountId
returning id
