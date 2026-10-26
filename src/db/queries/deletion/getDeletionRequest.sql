-- Read an account's deletion request.
select account_id, status, requested_at, purge_after, completed_at
from deletion_requests
where account_id = :accountId
