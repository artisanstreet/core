-- Look up a login request by id (originating-session polling).
select id, email, request_secret_hash, email_token_hash, status,
  totp_required, requester_ip, created_at, expires_at,
  email_approved_at, completed_at
from login_requests
where id = :id
