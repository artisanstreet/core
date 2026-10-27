-- Authenticate a request: session plus owning account state in one lookup.
select s.id, s.account_id,
  s.totp_verified_at, s.expires_at, s.revoked_at,
  a.email, a.display_name, a.totp_enrolled_at,
  a.deleted_at
from sessions s
join accounts a on a.id = s.account_id
where s.token_hash = :token_hash
