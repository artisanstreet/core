-- List an account's machines (ownership from session, never from the client).
select id, public_key_x, label, created_at, revoked_at, last_seen_at
from machines
where account_id = :account_id
order by created_at desc
