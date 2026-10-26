-- Complete the login (atomic; email-approved only, unexpired).
update login_requests
set status = 'completed', completed_at = now()
where id = :id and status = 'email_approved' and expires_at > now()
returning id, email, status, totp_required
