-- Fetch an account by verified email address.
select id, email, display_name, totp_secret_enc, totp_pending_secret_enc,
  totp_enrolled_at, created_at, deletion_requested_at, deleted_at
from accounts
where email = :email
