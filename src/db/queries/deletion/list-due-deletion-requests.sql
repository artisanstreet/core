-- Deletion requests whose grace period has passed (janitor).
select account_id
from deletion_requests
where status = 'pending' and purge_after <= :now
