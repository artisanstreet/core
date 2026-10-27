-- List an account's sessions, newest first (limit required).
select id, device_name, ip, totp_verified_at, created_at, expires_at, revoked_at
from sessions
where account_id = :account_id
order by created_at desc
limit :limit::int
