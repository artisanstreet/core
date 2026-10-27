-- Connections assigned to one live machine (discovery for sync).
-- Same-account on both ends, assignment present, nothing revoked.
-- Metadata only; secrets are never listed (see getCredentialForMachine).
with input as (
  select :machine_id::text as machine_id,
    :account_id::text as account_id
)
select c.id, c.provider, c.label, c.created_at, c.revoked_at
from provider_connections c
join machine_assignments a on a.connection_id = c.id
join machines m on m.id = a.machine_id
cross join input
where a.machine_id = input.machine_id
  and c.account_id = input.account_id
  and m.account_id = input.account_id
  and c.revoked_at is null
  and m.revoked_at is null
order by c.created_at desc
