-- Fetch an account by id, including TOTP and deletion state.
select id, display_name, totp_secret_enc, totp_pending_secret_enc,
  totp_enrolled_at
from accounts
where id = :id
