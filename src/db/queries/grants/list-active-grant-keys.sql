-- Active signing keys, newest first (limit required).
select kid, public_x, created_at
from grant_keys
where retired_at is null
order by created_at desc
limit :limit::int
