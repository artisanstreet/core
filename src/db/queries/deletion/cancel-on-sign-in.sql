update deletion_requests
set status = 'cancelled'
where account_id = :account_id and status = 'pending' and purge_after > :now
returning account_id
