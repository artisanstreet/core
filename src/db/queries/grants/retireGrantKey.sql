-- Retire a signing key (stops issuance; verification continues via JWKS).
update grant_keys
set retired_at = now()
where kid = :kid and retired_at is null
returning kid
