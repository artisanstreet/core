-- Count recent login requests for an email (abuse signal).
select count(*)::int as n
from login_requests
where email = :email and created_at > :since
