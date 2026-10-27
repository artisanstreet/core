-- Fetch an account by verified email address.
select id, totp_enrolled_at, deleted_at
from accounts
where email = :email
