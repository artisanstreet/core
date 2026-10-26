-- Purge step: the deletion request itself (account row goes next).
delete from deletion_requests
where account_id = :accountId
returning account_id
