-- Expire overdue enrollments (janitor).
update enrollments
set status = 'expired'
where expires_at <= now() and status in ('pending', 'claimed')
returning id
