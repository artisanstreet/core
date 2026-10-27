-- Promote the pending secret to the active factor (starts enforcing).
update accounts
set totp_secret_enc = totp_pending_secret_enc,
  totp_pending_secret_enc = null,
  totp_enrolled_at = now()
where id = :id and totp_pending_secret_enc is not null
returning id, totp_enrolled_at
