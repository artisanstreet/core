-- Create a magic-link login request (hashes only; raw secrets never stored).
insert into login_requests
  (id, email, request_secret_hash, email_token_hash, status, totp_required, requester_ip, expires_at)
values
  (:id, :email, :requestSecretHash, :emailTokenHash, 'pending', :totpRequired, :requesterIp, :expiresAt)
returning id, email, status, expires_at
