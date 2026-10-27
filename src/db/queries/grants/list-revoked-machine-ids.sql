-- Revoked machine ids for the revocation list (limit required).
select id
from machines
where revoked_at is not null
order by revoked_at desc
limit :limit::int
