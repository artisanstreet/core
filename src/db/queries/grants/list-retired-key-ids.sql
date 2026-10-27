-- Retired key ids for the revocation list (limit required).
select kid
from grant_keys
where retired_at is not null
order by retired_at desc
limit :limit::int
