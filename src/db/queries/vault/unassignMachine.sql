-- Remove an assignment (account-bound through the connection row).
delete from machine_assignments a
using provider_connections c
where a.connection_id = :connectionId and a.machine_id = :machineId
  and a.connection_id = c.id and c.account_id = :accountId
returning a.connection_id, a.machine_id
