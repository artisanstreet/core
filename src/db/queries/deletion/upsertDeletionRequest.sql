-- Open (or re-open) a deletion request with a fresh grace period.
with input as (
  select :accountId::text as account_id,
    :purgeAfter::timestamptz as purge_after
)
insert into deletion_requests (account_id, status, purge_after)
select input.account_id, 'pending', input.purge_after
from input
on conflict (account_id)
do update set status = 'pending',
  requested_at = now(),
  purge_after = excluded.purge_after
returning account_id, status, requested_at, purge_after
