-- Fetch a machine by id.
select id, account_id, public_key_x, label, created_at, revoked_at, last_seen_at
from machines
where id = :id
