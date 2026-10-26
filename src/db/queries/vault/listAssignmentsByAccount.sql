-- All vault assignments in an account (for /me and listings).
select a.connection_id, a.machine_id
from machine_assignments a
join provider_connections c on c.id = a.connection_id
where c.account_id = :accountId
