-- Keys for JWKS: active plus recently retired (15-minute grace so
-- in-flight short-lived grants still verify after rotation).
select kid, public_x, created_at, retired_at
from grant_keys
where retired_at is null or retired_at > now() - interval '15 minutes'
order by created_at desc
