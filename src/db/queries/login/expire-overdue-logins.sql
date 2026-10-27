-- Expire overdue login requests (janitor).
update login_requests
set status = 'expired'
where expires_at <= now() and status in ('pending', 'email_approved')
returning id
