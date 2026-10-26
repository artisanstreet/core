-- Enroll TOTP: store the encrypted secret, stamp enrollment.
update accounts
set totp_secret_enc = :secretEnc, totp_enrolled_at = now()
where id = :id
returning id, totp_enrolled_at
