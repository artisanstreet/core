-- Remove an assignment (account-bound through the connection row).
delete from machine_assignments a
using provider_connections c
where a.connection_id = :connection_id and a.machine_id = :machine_id
  and a.connection_id = c.id and c.account_id = :account_id
returning a.connection_id, a.machine_id
