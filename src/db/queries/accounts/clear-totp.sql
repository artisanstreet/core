-- Disable TOTP on the account.
update accounts
set totp_secret_enc = null, totp_enrolled_at = null
where id = :id
returning id
