-- Fetch an account by id, including TOTP and deletion state.
select id, email, display_name, totp_secret_enc, totp_pending_secret_enc,
  totp_enrolled_at, created_at, deletion_requested_at, deleted_at
from accounts
where id = :id
