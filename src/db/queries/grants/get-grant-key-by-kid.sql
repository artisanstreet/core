-- Look up a signing key by kid (for issuance; retired keys never issue).
select kid, public_x, private_seed_enc, created_at, retired_at
from grant_keys
where kid = :kid
