select m.id, m.account_id, m.public_key_x, m.label, m.created_at, m.revoked_at, m.last_seen_at, a.disabled_at
from machines m join accounts a on a.id = m.account_id
where m.id = :id
