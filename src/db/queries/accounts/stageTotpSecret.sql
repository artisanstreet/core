-- Stage a PENDING TOTP secret. Refuses accounts with an active factor:
-- replacing MFA must go through disable (which verifies the live code),
-- so a stolen session alone cannot silently swap the factor.
update accounts
set totp_pending_secret_enc = :secretEnc
where id = :id and totp_enrolled_at is null
returning id
