-- Mark deletion requested (grace period starts).
update accounts
set deletion_requested_at = now()
where id = :id
returning id, deletion_requested_at
