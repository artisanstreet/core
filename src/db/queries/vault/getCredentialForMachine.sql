-- Release a credential to its assigned machine. Every row is re-checked:
-- same account on both ends, assignment present, nothing revoked.
-- The service decrypts secret_enc only after this row says yes.
with input as (
  select :connectionId::text as connection_id,
    :machineId::text as machine_id,
    :accountId::text as account_id
)
select c.provider, c.secret_enc
from provider_connections c
join machine_assignments a on a.connection_id = c.id
join machines m on m.id = a.machine_id
cross join input
where a.connection_id = input.connection_id
  and a.machine_id = input.machine_id
  and c.account_id = input.account_id
  and m.account_id = input.account_id
  and c.revoked_at is null
  and m.revoked_at is null
