select id, device_name, user_agent, country_code, last_seen_at, totp_verified_at, created_at, expires_at, revoked_at
from sessions
where account_id = :account_id
order by (id = :current_session_id) desc, created_at desc
limit :limit::int
