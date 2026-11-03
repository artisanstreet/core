select m.id
from machines m join accounts a on a.id = m.account_id
where m.revoked_at is not null or a.disabled_at is not null
order by coalesce(m.revoked_at, a.disabled_at) desc
limit :limit::int
