-- Look up a login request by the emailed token hash.
select id, email, request_secret_hash, email_token_hash, status,
  totp_required, requester_ip, created_at, expires_at,
  email_approved_at, completed_at
from login_requests
where email_token_hash = :email_token_hash
