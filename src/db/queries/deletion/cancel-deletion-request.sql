-- Cancel a pending deletion request.
update deletion_requests
set status = 'cancelled'
where account_id = :account_id and status = 'pending'
returning account_id, status
