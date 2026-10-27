-- Mark the emailed link approved (atomic; pending only, unexpired).
update login_requests
set status = 'email_approved', email_approved_at = now()
where id = :id and status = 'pending' and expires_at > now()
returning id, email, status, totp_required
