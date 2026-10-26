-- Mark the deletion request done after the purge.
update deletion_requests
set status = 'done', completed_at = now()
where account_id = :accountId and status = 'pending'
returning account_id, status
