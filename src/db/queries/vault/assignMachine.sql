-- Assign a connection to a machine. Both ends must belong to the caller's
-- account and be live; foreign keys alone do not prove that, so the account
-- binding happens here in the mutation itself. Inserts nothing otherwise.
with input as (
  select :connectionId::text as connection_id,
    :machineId::text as machine_id,
    :accountId::text as account_id
)
insert into machine_assignments (connection_id, machine_id)
select input.connection_id, input.machine_id
from input
where exists (
  select 1 from provider_connections c
  where c.id = input.connection_id
    and c.account_id = input.account_id
    and c.revoked_at is null
) and exists (
  select 1 from machines m
  where m.id = input.machine_id
    and m.account_id = input.account_id
    and m.revoked_at is null
)
on conflict do nothing
returning connection_id, machine_id
